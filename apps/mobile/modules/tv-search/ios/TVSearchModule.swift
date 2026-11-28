import ExpoModulesCore
import UIKit

public class TVSearchModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SquirmyTVSearch")

    View(TVSearchView.self) {
      Events("onChangeText", "onSubmit")
      Prop("placeholder") { (view: TVSearchView, placeholder: String?) in
        view.placeholder = placeholder ?? ""
      }
    }
  }
}

/**
 * The system's search field with its keyboard, as the system's apps show it at the top of
 * Search: on Apple TV a single row of letters under the field. What is typed comes back as
 * `onChangeText`; the results are React Native views laid out under this one, which focus
 * reaches by moving down from the keyboard.
 */
final class TVSearchView: ExpoView, UISearchResultsUpdating, UISearchBarDelegate {
  let onChangeText = EventDispatcher()
  let onSubmit = EventDispatcher()
  private let results = UIViewController()
  private lazy var search: UISearchController = {
    let controller = UISearchController(searchResultsController: results)
    controller.searchResultsUpdater = self
    controller.searchBar.delegate = self
    controller.obscuresBackgroundDuringPresentation = false
    controller.hidesNavigationBarDuringPresentation = false
#if os(tvOS)
    controller.searchControllerObservedScrollView = nil
#endif
    return controller
  }()
  private var container: UIViewController?
  private var lastText = ""
  /** React Native's select recognizers above this view, switched off while the keyboard has focus. */
  private var quieted: [UIGestureRecognizer] = []

  var placeholder = "" {
    didSet { search.searchBar.placeholder = placeholder }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = false
    results.view.backgroundColor = .clear
    results.view.isUserInteractionEnabled = false
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, container == nil, let parent = owningViewController() else { return }
#if os(tvOS)
    let host = UISearchContainerViewController(searchController: search)
#else
    let host = UIViewController()
    host.view.addSubview(search.searchBar)
#endif
    host.view.backgroundColor = .clear
    parent.addChild(host)
    host.view.frame = bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(host.view)
    host.didMove(toParent: parent)
    container = host
  }

  // React Native listens for the remote's select on its views above this one, and a recognizer
  // there takes the click before the keyboard's key does. While focus is in the field or the
  // keyboard, those recognizers are off, so the system keyboard types as in any other app.
  override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
    super.didUpdateFocus(in: context, with: coordinator)
    if context.nextFocusedView?.isDescendant(of: self) == true {
      quietRemote()
    } else {
      restoreRemote()
    }
  }

  private func quietRemote() {
    guard quieted.isEmpty else { return }
    let select = NSNumber(value: UIPress.PressType.select.rawValue)
    var view = superview
    while let current = view {
      for recognizer in current.gestureRecognizers ?? [] where recognizer.isEnabled && recognizer.allowedPressTypes.contains(select) {
        recognizer.isEnabled = false
        quieted.append(recognizer)
      }
      view = current.superview
    }
  }

  private func restoreRemote() {
    quieted.forEach { $0.isEnabled = true }
    quieted.removeAll()
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    // Leaving the screen with the keyboard focused (a sign-out, an account switch) must not leave
    // React Native's select recognizers off, nor the search controller attached.
    if newWindow == nil { tearDown() }
  }

  private func tearDown() {
    restoreRemote()
    container?.willMove(toParent: nil)
    container?.view.removeFromSuperview()
    container?.removeFromParent()
    container = nil
  }

  override func removeFromSuperview() {
    tearDown()
    super.removeFromSuperview()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    container?.view.frame = bounds
  }

  private func owningViewController() -> UIViewController? {
    var responder: UIResponder? = self
    while let next = responder?.next {
      if let controller = next as? UIViewController { return controller }
      responder = next
    }
    return nil
  }

  func updateSearchResults(for searchController: UISearchController) {
    let text = searchController.searchBar.text ?? ""
    guard text != lastText else { return }
    lastText = text
    onChangeText(["text": text])
  }

  func searchBarSearchButtonClicked(_ searchBar: UISearchBar) {
    onSubmit(["text": searchBar.text ?? ""])
  }
}
