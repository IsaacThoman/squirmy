import ExpoModulesCore
import ObjectiveC
import UIKit

/**
 * Turns off the edge effects iOS 26 draws on scroll views (a dimming blur under the status bar
 * and the bars) in every scroll view, from launch. The app draws its own edges: `ScrollEdge`
 * at the top and `TabBarEdge` under the tab bar.
 */
public class ScrollEdgesAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UIScrollView.hideSystemEdgeEffects()
    return true
  }
}

extension UIScrollView {
  private static var swizzled = false

  /// Hides each scroll view's edge effects when it joins a window, which covers React Native's,
  /// SwiftUI's and UIKit's alike, however a screen nests them.
  static func hideSystemEdgeEffects() {
    guard #available(iOS 26, *), !swizzled else { return }
    swizzled = true
    let original = #selector(UIView.didMoveToWindow)
    let replacement = #selector(UIScrollView.squirmy_didMoveToWindow)
    guard let originalMethod = class_getInstanceMethod(UIScrollView.self, original),
          let replacementMethod = class_getInstanceMethod(UIScrollView.self, replacement) else { return }
    // Add the method to UIScrollView first when it only inherits UIView's, so only scroll views change.
    if class_addMethod(UIScrollView.self, original, method_getImplementation(replacementMethod), method_getTypeEncoding(replacementMethod)) {
      class_replaceMethod(UIScrollView.self, replacement, method_getImplementation(originalMethod), method_getTypeEncoding(originalMethod))
    } else {
      method_exchangeImplementations(originalMethod, replacementMethod)
    }
  }

  @objc private func squirmy_didMoveToWindow() {
    squirmy_didMoveToWindow()
    guard #available(iOS 26, *), window != nil else { return }
    topEdgeEffect.isHidden = true
    bottomEdgeEffect.isHidden = true
    leftEdgeEffect.isHidden = true
    rightEdgeEffect.isHidden = true
  }
}
