import ExpoModulesCore
import Foundation

public final class CarPlayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SquirmyCarPlay")
    Events("onStateChange", "onSelect", "onTemplateAppear", "onMediaIntent")

    OnCreate { [weak self] in
      DispatchQueue.main.async {
        guard let self else { return }
        CarPlayRuntime.shared.listen(self) { [weak self] name, payload in self?.sendEvent(name, payload) }
      }
    }

    OnDestroy { [weak self] in
      guard let self else { return }
      DispatchQueue.main.async { CarPlayRuntime.shared.stopListening(self) }
    }

    AsyncFunction("getState") {
      MainActor.assumeIsolated { CarPlayRuntime.shared.state() }
    }.runOnQueue(.main)

    AsyncFunction("setRoot") { (tabs: [[String: Any]], reset: Bool?, promise: Promise) in
      let models = try Self.decode([CarPlayList].self, from: tabs)
      MainActor.assumeIsolated {
        CarPlayRuntime.shared.setRoot(models, reset: reset == true, completion: Self.resolve(promise))
      }
    }.runOnQueue(.main)

    AsyncFunction("push") { (list: [String: Any], promise: Promise) in
      let model = try Self.decode(CarPlayList.self, from: list)
      MainActor.assumeIsolated {
        CarPlayRuntime.shared.push(model, completion: Self.resolve(promise))
      }
    }.runOnQueue(.main)

    AsyncFunction("update") { (list: [String: Any]) in
      let model = try Self.decode(CarPlayList.self, from: list)
      MainActor.assumeIsolated { CarPlayRuntime.shared.update(model) }
    }.runOnQueue(.main)

    AsyncFunction("pop") { (promise: Promise) in
      MainActor.assumeIsolated { CarPlayRuntime.shared.pop(completion: Self.resolve(promise)) }
    }.runOnQueue(.main)

    AsyncFunction("popToRoot") { (promise: Promise) in
      MainActor.assumeIsolated { CarPlayRuntime.shared.popToRoot(completion: Self.resolve(promise)) }
    }.runOnQueue(.main)

    AsyncFunction("showNowPlaying") { (promise: Promise) in
      MainActor.assumeIsolated { CarPlayRuntime.shared.showNowPlaying(completion: Self.resolve(promise)) }
    }.runOnQueue(.main)

    AsyncFunction("setNowPlaying") { (state: [String: Any]) in
      let model = try Self.decode(CarPlayNowPlaying.self, from: state)
      MainActor.assumeIsolated { CarPlayRuntime.shared.setNowPlaying(model) }
    }.runOnQueue(.main)

    AsyncFunction("showAlert") { (title: String, detail: String?, promise: Promise) in
      MainActor.assumeIsolated {
        CarPlayRuntime.shared.showAlert(title: title, detail: detail, completion: Self.resolve(promise))
      }
    }.runOnQueue(.main)

    AsyncFunction("finishSelection") { (requestId: String) in
      MainActor.assumeIsolated { CarPlayRuntime.shared.finishSelection(requestId) }
    }.runOnQueue(.main)

    AsyncFunction("takeMediaIntents") {
      MainActor.assumeIsolated { CarPlayRuntime.shared.takeMediaIntents() }
    }.runOnQueue(.main)

    AsyncFunction("completeMediaIntent") { (id: String, success: Bool) in
      MainActor.assumeIsolated { CarPlayRuntime.shared.completeMediaIntent(id, success: success) }
    }.runOnQueue(.main)
  }

  private static func decode<T: Decodable>(_ type: T.Type, from value: Any) throws -> T {
    try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
  }

  private static func resolve(_ promise: Promise) -> (Bool, Error?) -> Void {
    { success, error in
      if let error {
        promise.reject(error)
      } else {
        promise.resolve(success)
      }
    }
  }
}
