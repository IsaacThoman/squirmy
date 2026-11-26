import CarPlay
internal import Expo
import Intents
import React
internal import SquirmyCarPlay
import UIKit

@MainActor
private enum SquirmyReactRoot {
  static var controller: UIViewController?

  static func startWithoutPhoneWindow() {
    guard controller == nil,
          let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
          let factory = provider.reactNativeFactory,
          let delegate = factory.delegate else { return }

    // Fabric starts this surface when the bundle is ready, even without a window.
    // Keep its controller so the phone can attach to the same surface later.
    let view = factory.rootViewFactory.view(
      withModuleName: provider.reactNativeFactoryModuleName,
      initialProperties: nil,
      launchOptions: nil,
      bundleConfiguration: factory.bundleConfiguration,
      devMenuConfiguration: factory.devMenuConfiguration ?? RCTDevMenuConfiguration.default()
    )
    let root = delegate.createRootViewController()
    delegate.setRootView(view, toRootViewController: root)
    controller = root
  }
}

class SquirmyPhoneSceneDelegate: ExpoAppSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider else { return }

    guard let root = SquirmyReactRoot.controller else {
      // Keep Expo’s launch-options and link handling when the phone starts first.
      super.scene(scene, willConnectTo: session, options: connectionOptions)
      SquirmyReactRoot.controller = window?.rootViewController
      return
    }

    // Enabling the CarPlay scene also lets iPadOS request another app window.
    // Keep the existing phone UI and the single playback provider in that case.
    if let current = provider.window?.windowScene, current !== windowScene {
      deliverConnectionOptions(connectionOptions, to: current)
      UIApplication.shared.requestSceneSessionDestruction(session, options: nil)
      UIApplication.shared.requestSceneSessionActivation(current.session, userActivity: nil, options: nil)
      return
    }

    let phoneWindow = UIWindow(windowScene: windowScene)
    window = phoneWindow
    provider.window = phoneWindow
    phoneWindow.rootViewController = root
    phoneWindow.makeKeyAndVisible()
    deliverConnectionOptions(connectionOptions, to: windowScene)
  }

  override func sceneDidDisconnect(_ scene: UIScene) {
    if let phoneWindow = window {
      phoneWindow.rootViewController = nil
      if let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
         provider.window === phoneWindow {
        provider.window = nil
      }
    }
    super.sceneDidDisconnect(scene)
  }

  private func deliverConnectionOptions(_ options: UIScene.ConnectionOptions, to scene: UIWindowScene) {
    self.scene(scene, openURLContexts: options.urlContexts)
    options.userActivities.forEach { self.scene(scene, continue: $0) }
    if let shortcut = options.shortcutItem {
      windowScene(scene, performActionFor: shortcut) { _ in }
    }
  }
}

@objc(SquirmyCarPlaySceneDelegate)
final class SquirmyCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  func templateApplicationScene(
    _ scene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    CarPlayRuntime.shared.connect(interfaceController, scene: scene)
    SquirmyReactRoot.startWithoutPhoneWindow()
  }

  func templateApplicationScene(
    _ scene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    CarPlayRuntime.shared.disconnect(interfaceController)
  }

  func sceneDidBecomeActive(_ scene: UIScene) { updateActivation(scene) }
  func sceneWillResignActive(_ scene: UIScene) { updateActivation(scene) }
  func sceneWillEnterForeground(_ scene: UIScene) { updateActivation(scene) }
  func sceneDidEnterBackground(_ scene: UIScene) { updateActivation(scene) }

  private func updateActivation(_ scene: UIScene) {
    guard let scene = scene as? CPTemplateApplicationScene else { return }
    CarPlayRuntime.shared.updateActivation(scene)
  }
}

final class SquirmyPlayMediaIntentHandler: NSObject, INPlayMediaIntentHandling {
  func handle(intent: INPlayMediaIntent, completion: @escaping (INPlayMediaIntentResponse) -> Void) {
    let item = intent.mediaItems?.first ?? intent.mediaContainer
    let search = intent.mediaSearch
    let query = [item?.title, search?.mediaName, search?.artistName, search?.albumName]
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty }
    let type: String?
    switch item?.type ?? search?.mediaType {
    case .song: type = "track"
    case .album: type = "album"
    case .artist: type = "artist"
    case .playlist: type = "playlist"
    default: type = nil
    }
    let shuffle = intent.playShuffled
    let resume = intent.resumePlayback ?? (query == nil)

    DispatchQueue.main.async {
      let app = UIApplication.shared
      var task = UIBackgroundTaskIdentifier.invalid
      var finished = false
      func finish(_ success: Bool) {
        guard !finished else { return }
        finished = true
        completion(INPlayMediaIntentResponse(code: success ? .success : .failure, userActivity: nil))
        if task != .invalid { app.endBackgroundTask(task) }
      }
      task = app.beginBackgroundTask(withName: "Play Siri request") { finish(false) }
      SquirmyReactRoot.startWithoutPhoneWindow()
      CarPlayRuntime.shared.publishMediaIntent(
        query: query,
        mediaType: type,
        shuffle: shuffle,
        resume: resume,
        completion: finish
      )
    }
  }
}
