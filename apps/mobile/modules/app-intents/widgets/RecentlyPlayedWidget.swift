import SwiftUI
import WidgetKit

struct RecentlyPlayedEntry: TimelineEntry {
  let date: Date
  let signedIn: Bool
  let items: [SurfaceItem]

  static let sample = RecentlyPlayedEntry(date: Date(), signedIn: true, items: [
    SurfaceItem(id: "liked", kind: "liked", title: "Liked Songs", subtitle: "Playlist", artwork: nil, color: nil, link: "playlist/liked"),
    SurfaceItem(id: "album:1", kind: "album", title: "Album", subtitle: "Artist", artwork: nil, color: "#7862B4", link: ""),
    SurfaceItem(id: "artist:1", kind: "artist", title: "Artist", subtitle: "Artist", artwork: nil, color: "#4F7A9A", link: ""),
    SurfaceItem(id: "playlist:1", kind: "playlist", title: "Playlist", subtitle: "Playlist", artwork: nil, color: "#9A4F6E", link: ""),
  ])
}

struct RecentlyPlayedProvider: TimelineProvider {
  func placeholder(in context: Context) -> RecentlyPlayedEntry { .sample }

  func getSnapshot(in context: Context, completion: @escaping (RecentlyPlayedEntry) -> Void) {
    let entry = Self.entry(SurfacePaths.read())
    completion(context.isPreview && entry.items.isEmpty ? .sample : entry)
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<RecentlyPlayedEntry>) -> Void) {
    // Written when Home loads in the app, which reloads this widget.
    completion(Timeline(entries: [Self.entry(SurfacePaths.read())], policy: .never))
  }

  static func entry(_ snapshot: SurfaceSnapshot?) -> RecentlyPlayedEntry {
    RecentlyPlayedEntry(date: Date(), signedIn: snapshot?.signedIn ?? false, items: snapshot?.recent ?? [])
  }
}

struct RecentlyPlayedWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RecentlyPlayed", provider: RecentlyPlayedProvider()) { entry in
      RecentlyPlayedView(entry: entry)
    }
    .configurationDisplayName("Jump Back In")
    .description("What you played lately in Squirmy, a tap away.")
    .supportedFamilies([.systemMedium, .systemLarge])
    .contentMarginsDisabled()
  }
}

struct RecentlyPlayedView: View {
  let entry: RecentlyPlayedEntry
  @Environment(\.widgetFamily) private var family

  private var columns: Int { 4 }
  private var rows: Int { family == .systemLarge ? 2 : 1 }

  var body: some View {
    VStack(alignment: .leading, spacing: family == .systemLarge ? 14 : 10) {
      HStack(spacing: 6) {
        Text("Jump back in").font(.subheadline.weight(.bold))
        Spacer()
        Image(systemName: "waveform").font(.caption.weight(.bold)).foregroundStyle(.tint).widgetAccentable()
      }
      if !entry.signedIn {
        message("Open Squirmy to sign in.")
      } else if entry.items.isEmpty {
        message("Play something in Squirmy and it shows here.")
      } else {
        Grid(horizontalSpacing: 10, verticalSpacing: family == .systemLarge ? 14 : 0) {
          ForEach(0..<rows, id: \.self) { row in
            GridRow(alignment: .top) {
              ForEach(0..<columns, id: \.self) { column in
                let index = row * columns + column
                if index < entry.items.count {
                  tile(entry.items[index])
                } else {
                  Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                }
              }
            }
          }
        }
        if family == .systemLarge { Spacer(minLength: 0) }
      }
    }
    .padding(14)
    .widgetBackground { Color(uiColor: .systemBackground) }
    .widgetURL(WidgetLinks.url(""))
  }

  private func tile(_ item: SurfaceItem) -> some View {
    Link(destination: WidgetLinks.url(item.link) ?? WidgetLinks.url("")!) {
      VStack(alignment: .leading, spacing: 4) {
        CoverView(image: WidgetArtwork.image(item.artwork), color: item.color, symbol: symbol(forKind: item.kind),
                  round: item.kind == "artist", radius: 8)
        Text(item.title).font(.caption2.weight(.medium)).lineLimit(1)
        if family == .systemLarge, let subtitle = item.subtitle {
          Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
      }
    }
    .accessibilityLabel(item.subtitle.map { "\(item.title), \($0)" } ?? item.title)
  }

  private func message(_ text: String) -> some View {
    Text(text).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }
}
