import AppIntents
import Foundation

// Compiled into the app and the widget extension. The widgets' and the Live Activity's buttons
// are these intents; iOS runs an audio playback intent in the app's process (launching it in
// the background when it is not running), where `IntentRunner` hands it to the session.

@available(iOS 17.0, *)
struct TogglePlaybackIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Play or Pause"
  static let description = IntentDescription("Plays or pauses Squirmy, on whichever device is playing.")

  func perform() async throws -> some IntentResult {
    try await runControl("togglePlayback")
    return .result()
  }
}

@available(iOS 17.0, *)
struct PauseIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Pause"
  static let description = IntentDescription("Pauses Squirmy, on whichever device is playing.")

  func perform() async throws -> some IntentResult {
    try await runControl("pause")
    return .result()
  }
}

@available(iOS 17.0, *)
struct ResumeIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Resume"
  static let description = IntentDescription("Resumes what Squirmy was playing.")

  func perform() async throws -> some IntentResult {
    try await runControl("resume")
    return .result()
  }
}

@available(iOS 17.0, *)
struct NextTrackIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Next Song"
  static let description = IntentDescription("Skips to the next song in Squirmy.")

  func perform() async throws -> some IntentResult {
    try await runControl("next")
    return .result()
  }
}

@available(iOS 17.0, *)
struct PreviousTrackIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Previous Song"
  static let description = IntentDescription("Goes back to the song before in Squirmy.")

  func perform() async throws -> some IntentResult {
    try await runControl("previous")
    return .result()
  }
}

@available(iOS 17.0, *)
private func runControl(_ action: String) async throws {
  #if SQUIRMY_WIDGETS
  // Never reached: these run in the app. The extension only needs the types for its buttons.
  #else
  _ = try await IntentRunner.run(action)
  #endif
}
