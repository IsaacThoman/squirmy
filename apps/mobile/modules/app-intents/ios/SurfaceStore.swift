import Foundation
import ImageIO
import UniformTypeIdentifiers
#if canImport(WidgetKit)
import WidgetKit
#endif

/**
 * Writes the snapshot the widgets and Siri's suggestions read, with the covers it names, into
 * the App Group container. A widget's memory is small, so covers are kept as small JPEGs,
 * fetched (or copied from a download) once per cover, and those no snapshot names are
 * deleted. Each widget is reloaded only when its part of the snapshot changed.
 */
final class SurfaceStore {
  static let shared = SurfaceStore()

  /// Covers fill at most a medium widget's height at 3x.
  private static let artworkPixels = 420
  private let queue = DispatchQueue(label: "com.squirmy.surfaces")
  private var last: SurfaceSnapshot?
  /// Writes run one at a time, in order; a newer one replaces one still waiting, and answers for it.
  private var running = false
  private var next: (snapshot: SurfaceSnapshot, artwork: [String: URL])?
  private var waiting: [() -> Void] = []

  /// `done` runs once the snapshot (or a newer one) is on disk and the widgets were asked to reload.
  func write(_ snapshot: SurfaceSnapshot, artwork: [String: URL], done: @escaping () -> Void = {}) {
    queue.async {
      self.next = (snapshot, artwork)
      self.waiting.append(done)
      self.drain()
    }
  }

  private func drain() {
    guard !running, let (snapshot, artwork) = next else { return }
    next = nil
    let answers = waiting
    waiting.removeAll()
    running = true
    Task.detached(priority: .userInitiated) {
      await self.fetch(artwork)
      self.queue.async {
        self.commit(snapshot)
        answers.forEach { $0() }
        self.running = false
        self.drain()
      }
    }
  }

  private func fetch(_ artwork: [String: URL]) async {
    guard let folder = SurfacePaths.artworkFolder else { return }
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    await withTaskGroup(of: Void.self) { group in
      for (name, source) in artwork {
        guard let target = SurfacePaths.artwork(named: name), !FileManager.default.fileExists(atPath: target.path) else { continue }
        group.addTask { await Self.store(source, at: target) }
      }
    }
  }

  private static func store(_ source: URL, at target: URL) async {
    let data: Data?
    if source.isFileURL {
      data = try? Data(contentsOf: source)
    } else {
      var request = URLRequest(url: source, timeoutInterval: 20)
      request.cachePolicy = .returnCacheDataElseLoad
      data = try? await URLSession.shared.data(for: request).0
    }
    guard let data, let image = CGImageSourceCreateWithData(data as CFData, nil),
          let thumbnail = CGImageSourceCreateThumbnailAtIndex(image, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: artworkPixels,
          ] as CFDictionary) else {
      return
    }
    let encoded = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(encoded, UTType.jpeg.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(destination, thumbnail, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return }
    try? (encoded as Data).write(to: target, options: .atomic)
  }

  private func commit(_ proposed: SurfaceSnapshot) {
    guard let url = SurfacePaths.snapshot else { return }
    var snapshot = proposed
    // A cover that could not be fetched is left out, rather than drawn as a broken image.
    let present = { (name: String?) -> String? in
      guard let name, let file = SurfacePaths.artwork(named: name), FileManager.default.fileExists(atPath: file.path) else { return nil }
      return name
    }
    if var nowPlaying = snapshot.nowPlaying {
      nowPlaying.artwork = present(nowPlaying.artwork)
      snapshot.nowPlaying = nowPlaying
    }
    snapshot.recent = snapshot.recent.map { item in
      var item = item
      item.artwork = present(item.artwork)
      return item
    }

    let previous = last ?? SurfacePaths.read()
    if let previous, Self.sameContent(previous, snapshot) { return }
    do {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
    } catch {
      NSLog("[surfaces] Could not write the widget snapshot: %@", String(describing: error))
      return
    }
    last = snapshot
    prune(keeping: Set([snapshot.nowPlaying?.artwork].compactMap { $0} + snapshot.recent.compactMap(\.artwork)))

    let nowPlayingChanged = previous?.nowPlaying != snapshot.nowPlaying || previous?.signedIn != snapshot.signedIn
    let recentChanged = previous?.recent != snapshot.recent || previous?.signedIn != snapshot.signedIn
    #if canImport(WidgetKit)
    if nowPlayingChanged { WidgetCenter.shared.reloadTimelines(ofKind: "NowPlaying") }
    if recentChanged { WidgetCenter.shared.reloadTimelines(ofKind: "RecentlyPlayed") }
    #endif
    if recentChanged {
      // Siri learns the names of what can be played from the shortcuts' suggested items.
      DispatchQueue.main.async { SquirmyIntentsHost.refreshShortcuts() }
    }
  }

  /// The same apart from when it was written.
  private static func sameContent(_ a: SurfaceSnapshot, _ b: SurfaceSnapshot) -> Bool {
    var a = a
    a.updatedAt = b.updatedAt
    return a == b
  }

  private func prune(keeping names: Set<String>) {
    guard let folder = SurfacePaths.artworkFolder,
          let files = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return }
    for file in files where !names.contains(file) {
      try? FileManager.default.removeItem(at: folder.appendingPathComponent(file))
    }
  }
}
