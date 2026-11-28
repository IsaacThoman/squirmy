import AppIntents
import Foundation
internal import SquirmyAppIntents

/// A request JavaScript turned down, said by Siri or shown by Shortcuts in JavaScript's words.
@available(iOS 17.0, *)
struct SquirmyIntentError: Error, CustomLocalizedStringResourceConvertible {
  let message: String

  var localizedStringResource: LocalizedStringResource {
    LocalizedStringResource(stringLiteral: message)
  }
}

/**
 * Runs an intent's request in JavaScript, where the session client and the API client are,
 * starting React Native first when the app was launched in the background for it. The answer
 * comes once the command reached the server, and for a play, once the music started.
 */
@available(iOS 17.0, *)
enum IntentRunner {
  /// A cold start, the server's answer and the first audio all fit.
  private static let timeout: TimeInterval = 25

  @MainActor
  static func run(_ action: String, _ payload: [String: Any] = [:]) async throws -> [String: Any] {
    SquirmyReactHost.startIfNeeded()
    do {
      return try await SquirmyIntentBridge.shared.request(action, payload, timeout: timeout)
    } catch let failure as SquirmyIntentFailure {
      throw SquirmyIntentError(message: failure.message)
    }
  }
}
