#if os(iOS) || os(tvOS)
import AVFoundation

/**
 * The app's audio session for the engine: playback, the long-form route-sharing policy (so
 * iOS treats Squirmy as a music app for routes, as it does Music and Podcasts), and the
 * system's events turned into engine calls. The engine never resumes by itself: an
 * interruption that ends with "should resume" only tells the app, which decides.
 */
final class AudioSessionController: EngineSession {
  private weak var engine: Engine?
  private var observers: [NSObjectProtocol] = []
  private var configured = false
  private let log: (String) -> Void

  init(engine: Engine, log: @escaping (String) -> Void) {
    self.engine = engine
    self.log = log
    observe()
    report()
  }

  deinit {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }

  func activate() -> Bool {
    let session = AVAudioSession.sharedInstance()
    do {
      if !configured {
        // The long-form policy allows no category options, which matches the classic
        // engine's `doNotMix`.
        try session.setCategory(.playback, mode: .default, policy: .longFormAudio, options: [])
        configured = true
      }
      try session.setActive(true)
      return true
    } catch {
      log("couldn’t activate the audio session: \(error.localizedDescription)")
      return false
    }
  }

  func deactivate() {
    do {
      try AVAudioSession.sharedInstance().setActive(false)
    } catch {
      log("couldn’t deactivate the audio session: \(error.localizedDescription)")
    }
  }

  private func observe() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    if #available(iOS 27.0, tvOS 27.0, *) {
      // These replace the interruption notification from iOS and tvOS 27.
      observers += [
        center.addObserver(forName: AVAudioSession.didBecomeInactiveNotification, object: session, queue: nil) { [weak self] note in
          let context = note.userInfo?[AVAudioSession.deactivationContextKey] as? AVAudioSession.DeactivationContext
          // Our own deactivation comes through here too.
          guard context?.source == .system else { return }
          self?.engine?.interruptionBegan()
        },
        center.addObserver(forName: AVAudioSession.resumptionRecommendationNotification, object: session, queue: nil) { [weak self] note in
          let context = note.userInfo?[AVAudioSession.resumptionContextKey] as? AVAudioSession.ResumptionContext
          self?.engine?.interruptionEnded(shouldResume: context?.recommendation == .shouldResume)
        },
      ]
    } else {
      observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
          self?.engine?.interruptionBegan()
        case .ended:
          let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
          self?.engine?.interruptionEnded(shouldResume: options.contains(.shouldResume))
        @unknown default:
          break
        }
      })
    }
    observers += [
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        if raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)) == .oldDeviceUnavailable { self?.engine?.outputLost() }
        self?.report()
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
        self?.configured = false
        _ = self?.activate()
        self?.engine?.mediaServicesReset()
      },
    ]
  }

  /// The route's kind and rate, which set how far ahead the engine renders and at what rate.
  private func report() {
    let session = AVAudioSession.sharedInstance()
    let airPlay = session.currentRoute.outputs.contains { $0.portType == .airPlay }
    engine?.routeChanged(airPlay: airPlay, sampleRate: session.sampleRate)
  }
}
#endif
