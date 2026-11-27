import ExpoModulesCore
import SDWebImage
import UIKit

public class TVArtworkModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SquirmyTVArtwork")

    View(TVArtworkView.self) {
      Prop("uri") { (view: TVArtworkView, uri: String?) in
        view.uri = uri
      }
      Prop("cornerRadius") { (view: TVArtworkView, radius: Double?) in
        view.cornerRadius = CGFloat(radius ?? 0)
      }
      Prop("circle") { (view: TVArtworkView, circle: Bool?) in
        view.circle = circle ?? false
      }
      Prop("placeholderColor") { (view: TVArtworkView, color: UIColor?) in
        view.placeholderColor = color ?? UIColor(white: 0.18, alpha: 1)
      }
      Prop("focusEffect") { (view: TVArtworkView, enabled: Bool?) in
        view.liftsWithFocus = enabled ?? true
      }
    }
  }
}

/**
 * A cover drawn into its own rounded (or round) shape, so the tvOS focus effect, which acts on
 * the image's opaque pixels, keeps that shape while it lifts, tilts and shines. The effect
 * follows the nearest focusable ancestor: a React Native `Pressable` around this view.
 */
final class TVArtworkView: ExpoView {
  private let imageView = UIImageView()
  private var source: UIImage?
  private var loaded: String?
  private var operation: SDWebImageCombinedOperation?
  private var renderedSize: CGSize = .zero

  var uri: String? { didSet { if uri != oldValue { load() } } }
  var cornerRadius: CGFloat = 0 { didSet { if cornerRadius != oldValue { render() } } }
  var circle = false { didSet { if circle != oldValue { render() } } }
  var placeholderColor = UIColor(white: 0.18, alpha: 1) { didSet { if placeholderColor != oldValue { render() } } }
  var liftsWithFocus = true {
    didSet {
#if os(tvOS)
      imageView.adjustsImageWhenAncestorFocused = liftsWithFocus
#endif
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = false
    imageView.contentMode = .scaleToFill
#if os(tvOS)
    imageView.adjustsImageWhenAncestorFocused = true
    imageView.masksFocusEffectToContents = true
#endif
    addSubview(imageView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
    if bounds.size != renderedSize { render() }
  }

  private func load() {
    operation?.cancel()
    operation = nil
    guard let uri, let url = URL(string: uri) else {
      source = nil
      loaded = nil
      render()
      return
    }
    if loaded == uri, source != nil { return }
    source = nil
    render()
    operation = SDWebImageManager.shared.loadImage(with: url, options: [.retryFailed], progress: nil) { [weak self] image, _, _, cacheType, _, _ in
      guard let self, self.uri == uri, let image else { return }
      self.source = image
      self.loaded = uri
      // A cover from memory appears at once; one from the network fades in over its color.
      self.render(animated: cacheType != .memory)
    }
  }

  /** Each render's number; a render that finishes after a newer one started is dropped. */
  private var generation = 0

  /**
   * Draws the cover into its shape off the main thread, as many covers load at once while a
   * shelf scrolls, then shows it. `animated` fades a cover from the network in over its color.
   */
  private func render(animated: Bool = false) {
    let size = bounds.size
    renderedSize = size
    guard size.width > 0, size.height > 0 else { return }
    generation += 1
    let current = generation
    let source = self.source
    let color = placeholderColor
    let radius = circle ? min(size.width, size.height) / 2 : cornerRadius
    let round = circle
    let scale = window?.screen.scale ?? UIScreen.main.scale
    let draw = {
      let format = UIGraphicsImageRendererFormat.preferred()
      format.opaque = false
      format.scale = scale
      let rect = CGRect(origin: .zero, size: size)
      return UIGraphicsImageRenderer(size: size, format: format).image { _ in
        let path = round ? UIBezierPath(ovalIn: rect) : UIBezierPath(roundedRect: rect, cornerRadius: radius)
        path.addClip()
        color.setFill()
        UIRectFill(rect)
        if let source {
          // Aspect fill, centred.
          let fill = max(size.width / source.size.width, size.height / source.size.height)
          let drawn = CGSize(width: source.size.width * fill, height: source.size.height * fill)
          source.draw(in: CGRect(x: (size.width - drawn.width) / 2, y: (size.height - drawn.height) / 2, width: drawn.width, height: drawn.height))
        }
      }
    }
    // The placeholder alone is cheap and shows at once; a cover is drawn in the background.
    guard source != nil else {
      imageView.image = draw()
      return
    }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let image = draw()
      DispatchQueue.main.async {
        guard let self, self.generation == current else { return }
        if animated {
          UIView.transition(with: self.imageView, duration: 0.25, options: .transitionCrossDissolve, animations: { self.imageView.image = image })
        } else {
          self.imageView.image = image
        }
      }
    }
  }
}
