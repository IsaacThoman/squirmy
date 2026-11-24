import ExpoModulesCore
import UIKit

/**
 * A thumbless slider drawn by a `UISlider`, as Apple Music's scrubber is: a rounded track that
 * thickens while a finger drags it, and stretches a little when pulled past an end.
 *
 * It only draws. JavaScript owns the gesture, the value and what VoiceOver hears, so the view
 * takes no touches and is no accessibility element of its own. `value` runs from 0 to 1;
 * `active` is true while a finger drags; `stretch` is how far the track is pulled past an end,
 * in points on screen, negative to the left. When `stretch` returns to 0 the track springs back.
 */
class SliderBarView: ExpoView {
  let slider = BarSlider()

  var tint: UIColor? {
    didSet { style() }
  }
  var trackTint: UIColor? {
    didSet { style() }
  }
  var value: Float = 0 {
    didSet { slider.value = value }
  }
  var active = false {
    didSet {
      guard active != oldValue else {
        return
      }
      UIView.transition(with: slider, duration: 0.15, options: [.transitionCrossDissolve, .allowUserInteraction]) {
        self.style()
      }
    }
  }
  var stretch: CGFloat = 0 {
    didSet {
      guard stretch != oldValue else {
        return
      }
      place(springing: stretch == 0)
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    slider.isUserInteractionEnabled = false
    slider.isAccessibilityElement = false
    slider.minimumValue = 0
    slider.maximumValue = 1
    addSubview(slider)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    place(springing: false)
    style()
  }

  /** The slider fills the view, and reaches past the side it is pulled toward. */
  private func place(springing: Bool) {
    let frame = CGRect(x: bounds.minX + min(stretch, 0), y: bounds.minY, width: bounds.width + abs(stretch), height: bounds.height)
    guard springing, window != nil, !UIAccessibility.isReduceMotionEnabled else {
      slider.frame = frame
      return
    }
    UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0,
                   options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.slider.frame = frame
      self.slider.layoutIfNeeded()
    }
  }

  /** What the slider was last drawn with; layout comes often, and the images need not be made again. */
  private var styled: (tint: UIColor?, trackTint: UIColor?, active: Bool)?

  private func style() {
    if let styled, styled.tint == tint, styled.trackTint == trackTint, styled.active == active {
      return
    }
    styled = (tint, trackTint, active)
    let height = active ? SliderTrack.activeHeight : SliderTrack.restHeight
    slider.trackHeight = height
    let clear = SliderTrack.clearThumb
    for state: UIControl.State in [.normal, .highlighted, .selected, .disabled] {
      slider.setThumbImage(clear, for: state)
    }
    slider.setMinimumTrackImage(SliderTrack.image(color: tint ?? .white, height: height, part: .filled), for: .normal)
    slider.setMaximumTrackImage(SliderTrack.image(color: trackTint ?? .gray, height: height, part: .rest), for: .normal)
    slider.setNeedsLayout()
  }
}

/** A slider whose track spans its whole width, centred, with a thumb of no size at the value. */
class BarSlider: UISlider {
  var trackHeight = SliderTrack.restHeight

  override func trackRect(forBounds bounds: CGRect) -> CGRect {
    CGRect(x: bounds.minX, y: bounds.midY - trackHeight / 2, width: bounds.width, height: trackHeight)
  }

  override func thumbRect(forBounds bounds: CGRect, trackRect rect: CGRect, value: Float) -> CGRect {
    let range = maximumValue - minimumValue
    let fraction = range > 0 ? CGFloat((value - minimumValue) / range) : 0
    let leftToRight = effectiveUserInterfaceLayoutDirection == .leftToRight
    let x = leftToRight ? rect.minX + rect.width * fraction : rect.maxX - rect.width * fraction
    return CGRect(x: x, y: rect.midY, width: 0, height: 0)
  }
}

/** How Squirmy's sliders draw their tracks: shared by this view and the system volume slider. */
enum SliderTrack {
  /** Track heights at rest and while dragging. */
  static let restHeight: CGFloat = 6
  static let activeHeight: CGFloat = 10

  /** A thumb that draws nothing, in place of the slider's knob. */
  static let clearThumb: UIImage = {
    let format = UIGraphicsImageRendererFormat()
    format.opaque = false
    return UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1), format: format).image { _ in }
  }()

  enum Part {
    /** The part up to the value: rounded at the start, square where it meets the rest. */
    case filled
    /** The rest of the track: square where it meets the filled part, rounded at the end. */
    case rest
  }

  /**
   * One part of a capsule `height` tall that stretches in width. The two meet square, so the
   * value reads as a clean edge, as in Apple Music, and the track as one capsule. Flipped right to left.
   */
  static func image(color: UIColor, height: CGFloat, part: Part) -> UIImage {
    let cap = height / 2
    let width = cap + 2
    let format = UIGraphicsImageRendererFormat()
    format.opaque = false
    let corners: UIRectCorner = part == .filled ? [.topLeft, .bottomLeft] : [.topRight, .bottomRight]
    let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { _ in
      color.setFill()
      UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: width, height: height), byRoundingCorners: corners,
                   cornerRadii: CGSize(width: cap, height: cap)).fill()
    }
    let insets = part == .filled
      ? UIEdgeInsets(top: 0, left: cap, bottom: 0, right: 1)
      : UIEdgeInsets(top: 0, left: 1, bottom: 0, right: cap)
    return image.resizableImage(withCapInsets: insets, resizingMode: .stretch).imageFlippedForRightToLeftLayoutDirection()
  }
}
