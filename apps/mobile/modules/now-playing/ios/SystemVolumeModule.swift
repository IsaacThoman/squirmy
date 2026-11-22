import AVFoundation
import ExpoModulesCore
import MediaPlayer
import UIKit

/**
 * The phone's own output volume: the one the side buttons and Control Center change. On iOS
 * the player is always at full volume and this is the only volume there is, so the app shows
 * the system's slider and keeps the session's figure for this phone in step with it.
 *
 * `getVolume` reads it, `onVolumeChange` reports every change wherever it came from, and
 * `setVolume` moves it (for another device changing this phone's volume). iOS has no API for
 * that last one; the slider inside an `MPVolumeView` is the sanctioned way to move it, and
 * the system shows its volume indicator when it does.
 */
public class SystemVolumeModule: Module {
  private var observation: NSKeyValueObservation?
  /** An off-screen volume view whose slider `setVolume` moves. */
  private var setter: MPVolumeView?

  public func definition() -> ModuleDefinition {
    Name("SquirmySystemVolume")

    Events("onVolumeChange")

    OnStartObserving {
      self.observation = AVAudioSession.sharedInstance().observe(\.outputVolume, options: [.new]) { [weak self] _, change in
        guard let volume = change.newValue else {
          return
        }
        self?.sendEvent("onVolumeChange", ["volume": Double(volume)])
      }
    }

    OnStopObserving {
      self.observation?.invalidate()
      self.observation = nil
    }

    Function("getVolume") {
      Double(AVAudioSession.sharedInstance().outputVolume)
    }

    AsyncFunction("setVolume") { (volume: Double) in
      self.move(to: Float(min(1, max(0, volume))))
    }.runOnQueue(.main)

    View(SystemVolumeView.self) {
      Prop("tint") { (view: SystemVolumeView, color: UIColor?) in
        view.tint = color
      }
      Prop("trackTint") { (view: SystemVolumeView, color: UIColor?) in
        view.trackTint = color
      }
    }

    OnDestroy {
      self.observation?.invalidate()
      self.observation = nil
      DispatchQueue.main.async {
        self.setter?.removeFromSuperview()
        self.setter = nil
      }
    }
  }

  private func move(to volume: Float) {
    if let slider = setter?.volumeSlider, setter?.window != nil {
      slider.value = volume
      return
    }
    // The volume view only drives the system volume while it is in a window, and builds its
    // slider lazily: add it once, off screen, and move the slider on the next turn.
    guard let window = UIApplication.shared.connectedScenes
      .compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first
    else {
      return
    }
    let view = setter ?? MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 120, height: 40))
    view.alpha = 0.01
    view.isUserInteractionEnabled = false
    if view.superview == nil {
      window.addSubview(view)
    }
    setter = view
    DispatchQueue.main.async {
      view.volumeSlider?.value = volume
    }
  }
}

/** The system volume slider, drawn in the app's colors. It follows the side buttons by itself. */
class SystemVolumeView: ExpoView {
  let volumeView = MPVolumeView(frame: .zero)

  var tint: UIColor? {
    didSet { style() }
  }
  var trackTint: UIColor? {
    didSet { style() }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    // The output picker sits beside the slider as its own view.
    volumeView.showsRouteButton = false
    addSubview(volumeView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    volumeView.frame = bounds
    style()
  }

  private func style() {
    guard let slider = volumeView.volumeSlider else {
      return
    }
    slider.minimumTrackTintColor = tint
    slider.maximumTrackTintColor = trackTint
    slider.thumbTintColor = tint
  }
}

extension MPVolumeView {
  /** The slider the volume view draws, once it has built it. */
  var volumeSlider: UISlider? {
    subviews.lazy.compactMap { $0 as? UISlider }.first
  }
}
