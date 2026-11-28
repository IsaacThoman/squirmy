internal import Expo
import React
import UIKit

/**
 * React Native runs once per process. It starts in the phone's window, as Expo starts it, or,
 * when Siri, Shortcuts or a widget launches the app in the background for an intent, without a
 * window: the intent needs the JavaScript session client. A window that connects later shows
 * that same React Native root rather than starting a second app beside it.
 */
@MainActor
enum SquirmyReactHost {
  /// The root view controller React Native renders into, once it has started either way.
  private(set) static var controller: UIViewController?

  static func startIfNeeded() {
    guard controller == nil,
          let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
          let factory = provider.reactNativeFactory,
          let delegate = factory.delegate else {
      return
    }
    NSLog("[surfaces] Starting React Native without a window for an App Intent")
    // Fabric starts the surface when the bundle has loaded, with or without a window.
    let view = factory.rootViewFactory.view(
      withModuleName: provider.reactNativeFactoryModuleName,
      initialProperties: nil,
      launchOptions: nil
    )
    let root = delegate.createRootViewController()
    delegate.setRootView(view, toRootViewController: root)
    controller = root
  }

  fileprivate static func adopt(_ root: UIViewController?) {
    if controller == nil { controller = root }
  }
}

/// The phone's scene: Expo's, unless React Native already started without a window.
class SquirmySceneDelegate: ExpoAppSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
          let root = SquirmyReactHost.controller else {
      super.scene(scene, willConnectTo: session, options: connectionOptions)
      SquirmyReactHost.adopt(window?.rootViewController)
      return
    }
    let phoneWindow = UIWindow(windowScene: windowScene)
    window = phoneWindow
    provider.window = phoneWindow
    phoneWindow.rootViewController = root
    phoneWindow.makeKeyAndVisible()
    // JavaScript is running, so links and activities arrive as events rather than launch options.
    self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    connectionOptions.userActivities.forEach { self.scene(scene, continue: $0) }
    if let shortcut = connectionOptions.shortcutItem {
      self.windowScene(windowScene, performActionFor: shortcut) { _ in }
    }
  }

  override func sceneDidDisconnect(_ scene: UIScene) {
    // The root outlives its window: a background intent may still be using it.
    if let phoneWindow = window {
      phoneWindow.rootViewController = nil
      if let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider, provider.window === phoneWindow {
        provider.window = nil
      }
    }
    super.sceneDidDisconnect(scene)
  }
}
