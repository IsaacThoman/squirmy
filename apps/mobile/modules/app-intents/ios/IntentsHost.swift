import Foundation

/**
 * What the app target's App Intents do for this module. The intent types live in the app
 * target, which imports this pod; the pod can't name them back, so it finds the app's class
 * by its Objective-C name (`SquirmyAppIntentsHost`, in the app's `MediaIntents.swift`).
 */
@objc public protocol SquirmyIntentsHosting {
  /// Tells Siri that `item` (`{ id, kind, title, subtitle? }`) was just played, so it can suggest it again.
  static func donate(_ item: [String: Any])
  /// Reads the suggested items again for the App Shortcuts' phrases.
  static func refreshShortcuts()
}

enum SquirmyIntentsHost {
  private static var host: SquirmyIntentsHosting.Type? {
    NSClassFromString("SquirmyAppIntentsHost") as? SquirmyIntentsHosting.Type
  }

  static func donate(_ item: [String: Any]) {
    host?.donate(item)
  }

  static func refreshShortcuts() {
    host?.refreshShortcuts()
  }
}
