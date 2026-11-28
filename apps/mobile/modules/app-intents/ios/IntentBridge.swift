import Foundation

/// Why an intent could not be done, in words Siri or Shortcuts can show.
public struct SquirmyIntentFailure: Error {
  public let message: String
}

/**
 * Hands a request from an App Intent (in the app target) to JavaScript and waits for the
 * answer. Playback lives in the JavaScript session client, so every intent goes through it.
 * Requests made before JavaScript listens (the app was launched in the background for one,
 * and is still starting) wait for it, until their timeout.
 */
@MainActor
public final class SquirmyIntentBridge {
  public static let shared = SquirmyIntentBridge()

  typealias Emit = (_ id: String, _ action: String, _ payload: [String: Any]) -> Void

  private struct Request {
    let id: String
    let action: String
    let payload: [String: Any]
  }

  private var emit: Emit?
  private var queued: [Request] = []
  private var waiting: [String: CheckedContinuation<[String: Any], Error>] = [:]

  /// Whether JavaScript is listening now.
  public var isListening: Bool { emit != nil }

  public func request(_ action: String, _ payload: [String: Any] = [:], timeout: TimeInterval) async throws -> [String: Any] {
    let request = Request(id: UUID().uuidString, action: action, payload: payload)
    return try await withCheckedThrowingContinuation { continuation in
      waiting[request.id] = continuation
      if let emit {
        emit(request.id, request.action, request.payload)
      } else {
        queued.append(request)
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
        self?.finish(request.id, .failure(SquirmyIntentFailure(message: "Squirmy didn’t respond in time. Open the app and try again.")))
      }
    }
  }

  func listen(_ emit: @escaping Emit) {
    self.emit = emit
    let pending = queued
    queued.removeAll()
    for request in pending {
      emit(request.id, request.action, request.payload)
    }
  }

  func stopListening() {
    emit = nil
  }

  func respond(_ id: String, result: [String: Any]?, error: String?) {
    if let error {
      finish(id, .failure(SquirmyIntentFailure(message: error)))
    } else {
      finish(id, .success(result ?? [:]))
    }
  }

  private func finish(_ id: String, _ result: Result<[String: Any], Error>) {
    queued.removeAll { $0.id == id }
    waiting.removeValue(forKey: id)?.resume(with: result)
  }
}
