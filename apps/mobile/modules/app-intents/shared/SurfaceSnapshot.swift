import Foundation

// Compiled into three places: the SquirmyAppIntents pod (which writes the snapshot), the app
// target (whose App Intents suggest from it) and the widget extension (which draws it). The
// types stay internal so each module has its own copy and none clashes with another.

/**
 * What the app last said for the widgets and Siri's suggestions, as JSON in the App Group
 * container. The app writes it whole (`SurfaceStore`); readers never change it.
 */
struct SurfaceSnapshot: Codable, Equatable {
  /// Bumped when a field changes meaning; a reader skips a snapshot it does not know.
  static let version = 1

  var version: Int
  /// False once the account signs out: the widgets ask to open the app.
  var signedIn: Bool
  var nowPlaying: SurfaceNowPlaying?
  /// Jump back in, from Home, newest first.
  var recent: [SurfaceItem]
  /// Epoch milliseconds.
  var updatedAt: Double
}

struct SurfaceNowPlaying: Codable, Equatable {
  var title: String
  var artist: String?
  var album: String?
  /// A file name in the artwork folder (`SurfacePaths.artwork(named:)`).
  var artwork: String?
  /// The cover's dominant color, `#rrggbb`.
  var color: String?
  var playing: Bool
  /// Where the song was at `anchorAt` (epoch milliseconds), and how long it is.
  var positionMs: Double
  var anchorAt: Double
  var durationMs: Double
  /// The other device's name while it plays the session and this phone is a remote.
  var device: String?
}

/// A card of Jump back in: an album, artist, playlist, Liked Songs, a mix or a radio.
struct SurfaceItem: Codable, Equatable, Identifiable {
  /// `album:<id>`, `artist:<id>`, `playlist:<id>`, `liked`, `mix:<id>`, `radio:track:<id>` or `radio:artist:<id>`.
  var id: String
  var kind: String
  var title: String
  var subtitle: String?
  var artwork: String?
  var color: String?
  /// The page it opens, as a path under the app's URL scheme (`album/<id>`).
  var link: String
}

enum SurfacePaths {
  /// Set on the app's and the extension's Info.plist by the config plugin; missing in a build without widgets.
  static var appGroup: String? {
    Bundle.main.object(forInfoDictionaryKey: "SquirmyAppGroup") as? String
  }

  /// The App Group container, or the app's own Application Support where there is none (the
  /// snapshot then only serves Siri's suggestions).
  static var root: URL? {
    let base = appGroup.flatMap { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) }
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    return base?.appendingPathComponent("Squirmy", isDirectory: true)
  }

  static var snapshot: URL? { root?.appendingPathComponent("surfaces.json") }
  static var artworkFolder: URL? { root?.appendingPathComponent("artwork", isDirectory: true) }

  static func artwork(named name: String) -> URL? {
    // Names come from the app; anything that could leave the folder is refused.
    guard !name.isEmpty, !name.contains("/"), !name.hasPrefix(".") else { return nil }
    return artworkFolder?.appendingPathComponent(name)
  }

  static func read() -> SurfaceSnapshot? {
    guard let url = snapshot, let data = try? Data(contentsOf: url),
          let snapshot = try? JSONDecoder().decode(SurfaceSnapshot.self, from: data),
          snapshot.version == SurfaceSnapshot.version else {
      return nil
    }
    return snapshot
  }
}
