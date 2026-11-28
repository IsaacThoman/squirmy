import AppIntents
import Foundation
internal import SquirmyAppIntents

/**
 * Something to play: an album, artist, playlist, song, Liked Songs, a mix or a radio, as the
 * app names it (`album:<id>`). Siri's phrases match the suggested ones (Jump back in, and
 * what was played lately); Shortcuts and Siri's follow-up question search the server.
 */
@available(iOS 17.0, *)
struct MusicEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Music"
  static let defaultQuery = MusicQuery()

  let id: String
  let kind: String
  let title: String
  let subtitle: String?
  /// A cover in the App Group container, or on the server.
  let artwork: URL?

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: LocalizedStringResource(stringLiteral: title),
      subtitle: subtitle.map { LocalizedStringResource(stringLiteral: $0) },
      image: artwork.map { DisplayRepresentation.Image(url: $0) }
    )
  }

  /// What JavaScript is asked to play.
  var payload: [String: Any] { ["id": id, "kind": kind, "title": title] }

  init(id: String, kind: String, title: String, subtitle: String?, artwork: URL?) {
    self.id = id
    self.kind = kind
    self.title = title
    self.subtitle = subtitle
    self.artwork = artwork
  }

  /// From JavaScript's `{ id, kind, title, subtitle?, artworkUrl? }`.
  init?(_ item: [String: Any]) {
    guard let id = item["id"] as? String, let kind = item["kind"] as? String, let title = item["title"] as? String else { return nil }
    self.init(id: id, kind: kind, title: title, subtitle: item["subtitle"] as? String,
              artwork: (item["artworkUrl"] as? String).flatMap(URL.init(string:)))
  }

  init(_ item: SurfaceItem) {
    self.init(id: item.id, kind: item.kind, title: item.title, subtitle: item.subtitle,
              artwork: item.artwork.flatMap(SurfacePaths.artwork(named:)))
  }

  static let liked = MusicEntity(id: "liked", kind: "liked", title: "Liked Songs", subtitle: "Playlist", artwork: nil)
}

/// Items found or played lately, kept so a saved shortcut still names what it plays.
@available(iOS 17.0, *)
enum MusicMemory {
  private static let key = "squirmy.intents.music"
  private static let limit = 200

  static func remember(_ entities: [MusicEntity]) {
    guard !entities.isEmpty else { return }
    var kept = (UserDefaults.standard.array(forKey: key) as? [[String: String]]) ?? []
    let ids = Set(entities.map(\.id))
    kept.removeAll { ids.contains($0["id"] ?? "") }
    kept.insert(contentsOf: entities.map { entity in
      var row = ["id": entity.id, "kind": entity.kind, "title": entity.title]
      row["subtitle"] = entity.subtitle
      // A cover in the container may be gone by the time it is read again; a server one stays.
      if let artwork = entity.artwork, !artwork.isFileURL { row["artworkUrl"] = artwork.absoluteString }
      return row
    }, at: 0)
    UserDefaults.standard.set(Array(kept.prefix(limit)), forKey: key)
  }

  static func recall() -> [String: MusicEntity] {
    let kept = (UserDefaults.standard.array(forKey: key) as? [[String: String]]) ?? []
    var known = [String: MusicEntity]()
    for row in kept.reversed() {
      if let entity = MusicEntity(row) { known[entity.id] = entity }
    }
    for item in SurfacePaths.read()?.recent ?? [] { known[item.id] = MusicEntity(item) }
    known[MusicEntity.liked.id] = MusicEntity.liked
    return known
  }
}

@available(iOS 17.0, *)
struct MusicQuery: EntityStringQuery {
  func entities(for identifiers: [MusicEntity.ID]) async throws -> [MusicEntity] {
    let known = MusicMemory.recall()
    let missing = identifiers.filter { known[$0] == nil }
    var found = known
    if !missing.isEmpty, let answer = try? await IntentRunner.run("lookup", ["ids": missing]) {
      let looked = Self.entities(answer)
      MusicMemory.remember(looked)
      for entity in looked { found[entity.id] = entity }
    }
    return identifiers.compactMap { found[$0] }
  }

  func entities(matching string: String) async throws -> [MusicEntity] {
    let query = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return try await suggestedEntities() }
    let found = Self.entities(try await IntentRunner.run("search", ["query": query]))
    MusicMemory.remember(found)
    return found
  }

  func suggestedEntities() async throws -> [MusicEntity] {
    let recent = (SurfacePaths.read()?.recent ?? []).map(MusicEntity.init)
    return recent.contains { $0.id == MusicEntity.liked.id } ? recent : recent + [MusicEntity.liked]
  }

  private static func entities(_ answer: [String: Any]) -> [MusicEntity] {
    ((answer["items"] as? [[String: Any]]) ?? []).compactMap(MusicEntity.init)
  }
}

@available(iOS 17.0, *)
struct PlayMusicIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Play Music"
  static let description = IntentDescription("Plays an album, artist, playlist or song from Squirmy, on whichever device is playing.")

  @Parameter(title: "Music", requestValueDialog: IntentDialog("What would you like to play?"))
  var item: MusicEntity

  @Parameter(title: "Shuffle", default: false)
  var shuffle: Bool

  static var parameterSummary: some ParameterSummary {
    Summary("Play \(\.$item)") {
      \.$shuffle
    }
  }

  init() {}

  init(item: MusicEntity) {
    self.item = item
  }

  func perform() async throws -> some IntentResult {
    _ = try await IntentRunner.run("play", ["item": item.payload, "shuffle": shuffle])
    MusicMemory.remember([item])
    return .result()
  }
}

@available(iOS 17.0, *)
struct PlayLikedSongsIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Play Liked Songs"
  static let description = IntentDescription("Plays the songs you hearted in Squirmy.")

  @Parameter(title: "Shuffle", default: false)
  var shuffle: Bool

  static var parameterSummary: some ParameterSummary {
    Summary("Play Liked Songs") {
      \.$shuffle
    }
  }

  func perform() async throws -> some IntentResult {
    _ = try await IntentRunner.run("play", ["item": MusicEntity.liked.payload, "shuffle": shuffle])
    return .result()
  }
}

@available(iOS 17.0, *)
struct ShuffleLibraryIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Shuffle Library"
  static let description = IntentDescription("Shuffles the songs in your Squirmy library.")

  func perform() async throws -> some IntentResult {
    _ = try await IntentRunner.run("shuffleLibrary")
    return .result()
  }
}

@available(iOS 17.0, *)
struct StartRadioIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Start Radio"
  static let description = IntentDescription("Starts a radio of music like the song playing in Squirmy.")

  func perform() async throws -> some IntentResult {
    _ = try await IntentRunner.run("radio")
    return .result()
  }
}

@available(iOS 17.0, *)
struct SquirmyShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: PlayMusicIntent(),
      phrases: [
        "Play \(\.$item) in \(.applicationName)",
        "Play \(\.$item) on \(.applicationName)",
        "Play music in \(.applicationName)",
        "Play music on \(.applicationName)",
      ],
      shortTitle: "Play Music",
      systemImageName: "play.circle"
    )
    AppShortcut(
      intent: PlayLikedSongsIntent(),
      phrases: [
        "Play my liked songs in \(.applicationName)",
        "Play my liked songs on \(.applicationName)",
        "Play Liked Songs in \(.applicationName)",
      ],
      shortTitle: "Liked Songs",
      systemImageName: "heart"
    )
    AppShortcut(
      intent: ShuffleLibraryIntent(),
      phrases: [
        "Shuffle my library in \(.applicationName)",
        "Shuffle my music in \(.applicationName)",
        "Shuffle \(.applicationName)",
      ],
      shortTitle: "Shuffle Library",
      systemImageName: "shuffle"
    )
    AppShortcut(
      intent: StartRadioIntent(),
      phrases: [
        "Start radio in \(.applicationName)",
        "Start a radio from this song in \(.applicationName)",
        "Play more like this in \(.applicationName)",
      ],
      shortTitle: "Start Radio",
      systemImageName: "dot.radiowaves.left.and.right"
    )
    AppShortcut(intent: PauseIntent(), phrases: ["Pause \(.applicationName)"], shortTitle: "Pause", systemImageName: "pause")
    AppShortcut(
      intent: ResumeIntent(),
      phrases: ["Resume \(.applicationName)", "Resume playing in \(.applicationName)"],
      shortTitle: "Resume",
      systemImageName: "play"
    )
    AppShortcut(
      intent: NextTrackIntent(),
      phrases: ["Skip this song in \(.applicationName)", "Next song in \(.applicationName)"],
      shortTitle: "Next Song",
      systemImageName: "forward"
    )
  }

  static let shortcutTileColor: ShortcutTileColor = .purple
}

/// What the pod asks of the App Intents (`SquirmyIntentsHosting`), found by this Objective-C name.
@objc(SquirmyAppIntentsHost)
final class SquirmyAppIntentsHost: NSObject, SquirmyIntentsHosting {
  static func donate(_ item: [String: Any]) {
    guard #available(iOS 17.0, *), let entity = MusicEntity(item) else { return }
    MusicMemory.remember([entity])
    // Siri suggests what was played, at the times it usually is, on the Lock Screen and in Search.
    Task { _ = try? await IntentDonationManager.shared.donate(intent: PlayMusicIntent(item: entity)) }
  }

  static func refreshShortcuts() {
    guard #available(iOS 17.0, *) else { return }
    SquirmyShortcuts.updateAppShortcutParameters()
  }
}
