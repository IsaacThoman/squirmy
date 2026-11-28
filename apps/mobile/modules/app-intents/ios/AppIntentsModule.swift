import ExpoModulesCore
import Foundation

/**
 * JavaScript's side of Squirmy outside the app: it answers the App Intents' requests
 * (`onRequest`, `respond`), writes what the widgets show (`setSnapshot`), tells Siri what was
 * played (`donate`) and keeps the downloads Live Activity (`setDownloadActivity`).
 */
public class AppIntentsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SquirmyAppIntents")

    Events("onRequest")

    /// The build has the widget extension and its App Group.
    Constant("hasWidgets") {
      SurfacePaths.appGroup != nil
    }

    /// JavaScript is ready for requests (`true`) or no longer is.
    Function("setListening") { (listening: Bool) in
      DispatchQueue.main.async {
        if listening {
          SquirmyIntentBridge.shared.listen { [weak self] id, action, payload in
            self?.sendEvent("onRequest", ["id": id, "action": action, "payload": payload])
          }
        } else {
          SquirmyIntentBridge.shared.stopListening()
        }
      }
    }

    Function("respond") { (id: String, result: [String: Any]?, error: String?) in
      DispatchQueue.main.async {
        SquirmyIntentBridge.shared.respond(id, result: result, error: error)
      }
    }

    /// `snapshot` is a `SurfaceSnapshot`; `artwork` maps each cover's file name to where to get it.
    /// Resolves once it is written, so an intent's answer (after which iOS reloads the widget) comes after it.
    AsyncFunction("setSnapshot") { (snapshot: [String: Any], artwork: [String: String], promise: Promise) in
      let data = try JSONSerialization.data(withJSONObject: snapshot)
      let decoded = try JSONDecoder().decode(SurfaceSnapshot.self, from: data)
      SurfaceStore.shared.write(decoded, artwork: artwork.compactMapValues(URL.init(string:))) { promise.resolve() }
    }

    AsyncFunction("donate") { (item: [String: Any]) in
      DispatchQueue.main.async { SquirmyIntentsHost.donate(item) }
    }

    /// The downloads' progress, or null when none are running.
    AsyncFunction("setDownloadActivity") { (state: [String: Any]?) async throws in
      #if canImport(ActivityKit)
      let content = try state.map { state in
        try JSONDecoder().decode(DownloadActivityAttributes.ContentState.self, from: JSONSerialization.data(withJSONObject: state))
      }
      // The extension that draws it needs iOS 17.
      if #available(iOS 17.0, *) { await DownloadActivityController.shared.update(content) }
      #endif
    }

    OnDestroy {
      DispatchQueue.main.async { SquirmyIntentBridge.shared.stopListening() }
    }
  }
}
