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

/**
 * The system volume slider, drawn like Apple Music's: no thumb, a thin rounded track that
 * thickens while a finger drags it, and the whole bar to drag on. It follows the side
 * buttons by itself, and moving it moves the system volume.
 *
 * It is dragged as the scrubber is (`TransportSlider` and `scrub.ts`): the volume moves by how
 * far the finger travels from where it started, never jumping to where it touched down, so a
 * tap changes nothing. Past an end the track stretches a little and springs back on release,
 * with a light tap of haptics on arriving at an end. The slider's own thumb is replaced by a
 * clear image in every state, and the slider never sees a touch: the view takes them all for
 * its pan. VoiceOver still adjusts the slider itself.
 */
class SystemVolumeView: ExpoView {
  let volumeView = AlignedVolumeView(frame: .zero)
  private var dragging = false
  private var dragStart: Float = 0
  private var lastValue: Float = 0
  /** How far the track is pulled past an end, in points on screen, negative to the left. */
  private var stretch: CGFloat = 0
  private let endHaptic = UIImpactFeedbackGenerator(style: .light)

  var tint: UIColor? {
    didSet { style() }
  }
  var trackTint: UIColor? {
    didSet { style() }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    // Only the slider: choosing where the sound goes is in the device sheet.
    volumeView.showsRouteButton = false
    addSubview(volumeView)
    let pan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
    pan.maximumNumberOfTouches = 1
    addGestureRecognizer(pan)
  }

  /** Only a sideways drag moves the volume: one that goes up or down is swiping Now Playing away. */
  override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
    guard let pan = gesture as? UIPanGestureRecognizer else {
      return super.gestureRecognizerShouldBegin(gesture)
    }
    let velocity = pan.velocity(in: self)
    return abs(velocity.x) > abs(velocity.y)
  }

  /**
   * Every touch on the bar is the view's own, for its pan. Left to itself the system slider
   * would take a touch first and jump the volume to where the finger landed.
   */
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard isUserInteractionEnabled, !isHidden, alpha > 0.01, self.point(inside: point, with: event) else {
      return nil
    }
    return self
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    place(springing: false)
    style()
  }

  /** The volume view fills this view, and reaches past the side it is pulled toward. */
  private func place(springing: Bool) {
    let frame = CGRect(x: bounds.minX + min(stretch, 0), y: bounds.minY, width: bounds.width + abs(stretch), height: bounds.height)
    guard springing, window != nil, !UIAccessibility.isReduceMotionEnabled else {
      volumeView.frame = frame
      return
    }
    UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0,
                   options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.volumeView.frame = frame
      self.volumeView.layoutIfNeeded()
    }
  }

  @objc private func drag(_ pan: UIPanGestureRecognizer) {
    guard let slider = volumeView.volumeSlider, bounds.width > 0 else {
      return
    }
    switch pan.state {
    case .began:
      dragStart = slider.value
      lastValue = slider.value
      endHaptic.prepare()
      setDragging(true)
    case .changed:
      let direction: Float = effectiveUserInterfaceLayoutDirection == .rightToLeft ? -1 : 1
      let raw = dragStart + Float(pan.translation(in: self).x / bounds.width) * direction
      let value = min(1, max(0, raw))
      if value != slider.value {
        // Setting the volume view's slider is what moves the system volume.
        slider.value = value
        slider.sendActions(for: .valueChanged)
      }
      if (value <= 0 && lastValue > 0) || (value >= 1 && lastValue < 1) {
        endHaptic.impactOccurred()
      }
      lastValue = value
      let pulled = SliderTrack.rubberBand(CGFloat(raw - value) * bounds.width * CGFloat(direction))
      if pulled != stretch {
        stretch = pulled
        place(springing: false)
      }
    default:
      setDragging(false)
      if stretch != 0 {
        stretch = 0
        place(springing: true)
      }
    }
  }

  private func setDragging(_ value: Bool) {
    guard dragging != value else {
      return
    }
    dragging = value
    if let slider = volumeView.volumeSlider {
      UIView.transition(with: slider, duration: 0.15, options: [.transitionCrossDissolve, .allowUserInteraction]) {
        self.style()
      }
    }
  }

  /** What the slider was last drawn with; layout comes often, and the images need not be made again. */
  private var styled: (tint: UIColor?, trackTint: UIColor?, dragging: Bool, slider: UISlider?)?

  private func style() {
    let slider = volumeView.volumeSlider
    if let styled, styled.tint == tint, styled.trackTint == trackTint, styled.dragging == dragging, styled.slider === slider {
      return
    }
    styled = (tint, trackTint, dragging, slider)
    for state: UIControl.State in [.normal, .highlighted, .selected, .disabled, [.highlighted, .selected]] {
      volumeView.setVolumeThumbImage(SliderTrack.clearThumb, for: state)
    }
    let height = dragging ? SliderTrack.activeHeight : SliderTrack.restHeight
    volumeView.setMinimumVolumeSliderImage(SliderTrack.image(color: tint ?? .white, height: height, part: .filled), for: .normal)
    volumeView.setMaximumVolumeSliderImage(SliderTrack.image(color: trackTint ?? .gray, height: height, part: .rest), for: .normal)
    volumeView.setNeedsLayout()
  }
}

/**
 * A volume view whose track spans its bounds, centred, as the scrubber's does. Left alone, the
 * volume view lays its slider out at the slider's own height from the top, so the track sits
 * above the middle, and the slider insets its track from both ends.
 */
class AlignedVolumeView: MPVolumeView {
  override func layoutSubviews() {
    super.layoutSubviews()
    guard let slider = volumeSlider, bounds.width > 0 else {
      return
    }
    let track = slider.trackRect(forBounds: CGRect(origin: .zero, size: bounds.size))
    let leading = max(0, track.minX)
    let trailing = max(0, bounds.width - track.maxX)
    slider.frame = CGRect(x: bounds.minX - leading, y: bounds.minY, width: bounds.width + leading + trailing, height: bounds.height)
  }
}

extension MPVolumeView {
  /** The slider the volume view draws, once it has built it. */
  var volumeSlider: UISlider? {
    subviews.lazy.compactMap { $0 as? UISlider }.first
  }
}
