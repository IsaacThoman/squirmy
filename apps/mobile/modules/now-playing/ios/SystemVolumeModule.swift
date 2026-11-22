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
 * The slider's own thumb is replaced by a clear image in every state, rather than covered.
 * With no thumb to grab, a pan over the whole view moves the volume by how far the finger
 * travels from where it started, as Apple Music's does.
 */
class SystemVolumeView: ExpoView {
  /** Track heights at rest and while dragging. */
  static let restHeight: CGFloat = 6
  static let activeHeight: CGFloat = 10

  let volumeView = MPVolumeView(frame: .zero)
  private var dragging = false
  private var dragStart: Float = 0

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
    let pan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
    pan.maximumNumberOfTouches = 1
    addGestureRecognizer(pan)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    volumeView.frame = bounds
    style()
  }

  @objc private func drag(_ pan: UIPanGestureRecognizer) {
    guard let slider = volumeView.volumeSlider, bounds.width > 0 else {
      return
    }
    switch pan.state {
    case .began:
      dragStart = slider.value
      setDragging(true)
    case .changed:
      let moved = Float(pan.translation(in: self).x / bounds.width)
      let direction: Float = effectiveUserInterfaceLayoutDirection == .rightToLeft ? -1 : 1
      // Setting the volume view's slider is what moves the system volume.
      slider.value = min(1, max(0, dragStart + moved * direction))
      slider.sendActions(for: .valueChanged)
    default:
      setDragging(false)
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
    let clear = SystemVolumeView.image(color: .clear, height: 1)
    for state: UIControl.State in [.normal, .highlighted, .selected, .disabled, [.highlighted, .selected]] {
      volumeView.setVolumeThumbImage(clear, for: state)
    }
    let height = dragging ? SystemVolumeView.activeHeight : SystemVolumeView.restHeight
    volumeView.setMinimumVolumeSliderImage(SystemVolumeView.image(color: tint ?? .white, height: height), for: .normal)
    volumeView.setMaximumVolumeSliderImage(SystemVolumeView.image(color: trackTint ?? .gray, height: height), for: .normal)
  }

  /** A capsule `height` tall that stretches in width: the slider draws its track parts with these. */
  static func image(color: UIColor, height: CGFloat) -> UIImage {
    let width = max(height, 1) + 2
    let format = UIGraphicsImageRendererFormat()
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { _ in
      color.setFill()
      UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: width, height: height), cornerRadius: height / 2).fill()
    }
    let cap = height / 2
    return image.resizableImage(withCapInsets: UIEdgeInsets(top: 0, left: cap, bottom: 0, right: cap), resizingMode: .stretch)
  }
}

extension MPVolumeView {
  /** The slider the volume view draws, once it has built it. */
  var volumeSlider: UISlider? {
    subviews.lazy.compactMap { $0 as? UISlider }.first
  }
}
