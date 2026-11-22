import AVFoundation
import ExpoModulesCore
import MediaPlayer
import UIKit

struct NowPlayingItem: Record {
  @Field var title: String = ""
  @Field var artist: String?
  @Field var album: String?
  @Field var artworkUrl: URL?
  @Field var durationMs: Double = 0
}

/**
 * Shows what is playing on the lock screen and in Control Center, and forwards their
 * buttons to JavaScript as `onRemoteCommand` events instead of acting on a player, so the
 * app can turn them into session commands. Also forwards what the audio session reports:
 * `onInterruption` (a call or Siri began, or ended and may resume) and `onRouteChange`
 * (headphones unplugged), which the player could only guess at from its own state.
 */
public class NowPlayingModule: Module {
  private var targets: [(command: MPRemoteCommand, target: Any)] = []
  private var artworkUrl: URL?
  private var artwork: MPMediaItemArtwork?
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("SquirmyNowPlaying")

    Events("onRemoteCommand", "onInterruption", "onRouteChange")

    OnCreate {
      let center = NotificationCenter.default
      let session = AVAudioSession.sharedInstance()
      self.observers = [
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
          self?.interruption(note)
        },
        center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] note in
          self?.routeChange(note)
        },
      ]
    }

    AsyncFunction("setItem") { (item: NowPlayingItem) in
      self.enableCommands()
      var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
      info[MPMediaItemPropertyTitle] = item.title
      info[MPMediaItemPropertyArtist] = item.artist
      info[MPMediaItemPropertyAlbumTitle] = item.album
      info[MPMediaItemPropertyPlaybackDuration] = item.durationMs / 1000
      info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
      info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0
      info[MPMediaItemPropertyArtwork] = item.artworkUrl == self.artworkUrl ? self.artwork : nil
      MPNowPlayingInfoCenter.default().nowPlayingInfo = info
      if let url = item.artworkUrl, url != self.artworkUrl {
        self.loadArtwork(url)
      }
    }.runOnQueue(.main)

    AsyncFunction("setPlayback") { (playing: Bool, positionMs: Double) in
      var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = positionMs / 1000
      info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
      MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }.runOnQueue(.main)

    AsyncFunction("clear") {
      self.clear()
    }.runOnQueue(.main)

    OnDestroy {
      self.observers.forEach { NotificationCenter.default.removeObserver($0) }
      self.observers.removeAll()
      DispatchQueue.main.async { self.clear() }
    }
  }

  private func interruption(_ note: Notification) {
    guard
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else {
      return
    }
    switch type {
    case .began:
      sendEvent("onInterruption", ["type": "began"])
    case .ended:
      let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
      sendEvent("onInterruption", ["type": "ended", "shouldResume": options.contains(.shouldResume)])
    @unknown default:
      break
    }
  }

  private func routeChange(_ note: Notification) {
    guard
      let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
    else {
      return
    }
    sendEvent("onRouteChange", ["reason": reason == .oldDeviceUnavailable ? "oldDeviceUnavailable" : "other"])
  }

  private func clear() {
    for (command, target) in targets {
      command.removeTarget(target)
      command.isEnabled = false
    }
    targets.removeAll()
    artworkUrl = nil
    artwork = nil
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
  }

  private func enableCommands() {
    guard targets.isEmpty else {
      return
    }
    let center = MPRemoteCommandCenter.shared()
    forward(center.playCommand, as: "play")
    forward(center.pauseCommand, as: "pause")
    forward(center.togglePlayPauseCommand, as: "togglePlayPause")
    forward(center.nextTrackCommand, as: "next")
    forward(center.previousTrackCommand, as: "previous")
    forward(center.changePlaybackPositionCommand, as: "seek") { event in
      (event as? MPChangePlaybackPositionCommandEvent).map { ["positionMs": $0.positionTime * 1000] }
    }
    // Next and previous take the place of the skip buttons.
    center.skipForwardCommand.isEnabled = false
    center.skipBackwardCommand.isEnabled = false
  }

  private func forward(
    _ command: MPRemoteCommand,
    as name: String,
    details: @escaping (MPRemoteCommandEvent) -> [String: Any]? = { _ in [:] }
  ) {
    command.isEnabled = true
    let target = command.addTarget { [weak self] event in
      guard let self, let payload = details(event) else {
        return .commandFailed
      }
      self.sendEvent("onRemoteCommand", payload.merging(["command": name]) { _, new in new })
      return .success
    }
    targets.append((command, target))
  }

  private func loadArtwork(_ url: URL) {
    artworkUrl = url
    artwork = nil
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let data, let image = UIImage(data: data) else {
        return
      }
      DispatchQueue.main.async {
        guard let self, self.artworkUrl == url else {
          return
        }
        let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        self.artwork = artwork
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyArtwork] = artwork
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
      }
    }.resume()
  }
}
