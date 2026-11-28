import AppIntents
import SwiftUI
import WidgetKit

struct NowPlayingEntry: TimelineEntry {
  let date: Date
  let signedIn: Bool
  let item: SurfaceNowPlaying?
  /// The song is playing at `date`, as far as the app last said. A song that should have ended
  /// with no word from the app since (it was closed) shows as stopped.
  let live: Bool

  var cover: UIImage? { WidgetArtwork.image(item?.artwork) }

  /// When the song started and ends, at the position the app last gave.
  var span: ClosedRange<Date>? {
    guard let item, item.durationMs > 0 else { return nil }
    let start = Date(timeIntervalSince1970: (item.anchorAt - item.positionMs) / 1000)
    return start...start.addingTimeInterval(item.durationMs / 1000)
  }

  var progress: Double {
    guard let item, item.durationMs > 0 else { return 0 }
    return min(1, max(0, item.positionMs / item.durationMs))
  }

  static let sample = NowPlayingEntry(
    date: Date(), signedIn: true,
    item: SurfaceNowPlaying(title: "Song Title", artist: "Artist", album: "Album", artwork: nil, color: "#5B4F9A",
                            playing: true, positionMs: 60_000, anchorAt: Date().timeIntervalSince1970 * 1000,
                            durationMs: 200_000, device: nil),
    live: true
  )
}

struct NowPlayingProvider: TimelineProvider {
  /// How long past a song's end it still shows as playing, in case the app is a little late.
  private static let grace: TimeInterval = 30

  func placeholder(in context: Context) -> NowPlayingEntry { .sample }

  func getSnapshot(in context: Context, completion: @escaping (NowPlayingEntry) -> Void) {
    let snapshot = SurfacePaths.read()
    completion(context.isPreview && snapshot?.nowPlaying == nil ? .sample : Self.entries(snapshot, now: Date())[0])
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<NowPlayingEntry>) -> Void) {
    // The app reloads the widget when the song or its state changes; nothing to poll.
    completion(Timeline(entries: Self.entries(SurfacePaths.read(), now: Date()), policy: .never))
  }

  static func entries(_ snapshot: SurfaceSnapshot?, now: Date) -> [NowPlayingEntry] {
    let signedIn = snapshot?.signedIn ?? false
    let entry = { (date: Date, live: Bool) in NowPlayingEntry(date: date, signedIn: signedIn, item: snapshot?.nowPlaying, live: live) }
    guard let item = snapshot?.nowPlaying, item.playing else { return [entry(now, false)] }
    guard item.durationMs > 0 else { return [entry(now, true)] }
    let ends = Date(timeIntervalSince1970: (item.anchorAt + item.durationMs - item.positionMs) / 1000).addingTimeInterval(grace)
    return ends <= now ? [entry(now, false)] : [entry(now, true), entry(ends, false)]
  }
}

struct NowPlayingWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "NowPlaying", provider: NowPlayingProvider()) { entry in
      NowPlayingView(entry: entry)
    }
    .configurationDisplayName("Now Playing")
    .description("What’s playing in Squirmy, on this iPhone or another device, with its controls.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular, .accessoryInline])
    .contentMarginsDisabled()
  }
}

struct NowPlayingView: View {
  let entry: NowPlayingEntry
  @Environment(\.widgetFamily) private var family
  @Environment(\.widgetRenderingMode) private var rendering
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    content
      .widgetURL(WidgetLinks.nowPlaying)
  }

  @ViewBuilder
  private var content: some View {
    switch family {
    case .accessoryInline: inline
    case .accessoryCircular: circular
    case .accessoryRectangular: rectangular
    case .systemMedium: medium
    default: small
    }
  }

  // MARK: Home Screen

  private var small: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top) {
        CoverView(image: entry.cover, color: entry.item?.color, symbol: "music.note", radius: 10)
          .frame(width: 62, height: 62)
          .shadow(color: .black.opacity(0.18), radius: 4, y: 2)
        Spacer(minLength: 4)
        if entry.item != nil { playButton(size: 34) }
      }
      Spacer(minLength: 6)
      titles(lines: 1)
      if entry.item != nil {
        progress.padding(.top, 8)
      }
    }
    .padding(14)
    .foregroundStyle(text)
    .widgetBackground { background }
  }

  private var medium: some View {
    HStack(spacing: 14) {
      CoverView(image: entry.cover, color: entry.item?.color, symbol: "music.note", radius: 12)
        .frame(maxHeight: .infinity)
        .shadow(color: .black.opacity(0.18), radius: 6, y: 3)
      VStack(alignment: .leading, spacing: 0) {
        titles(lines: 2)
        Spacer(minLength: 6)
        if entry.item != nil {
          progress
          HStack(spacing: 0) {
            Button(intent: PreviousTrackIntent()) { control("backward.fill", size: 20) }
            Spacer(minLength: 0)
            playButton(size: 40)
            Spacer(minLength: 0)
            Button(intent: NextTrackIntent()) { control("forward.fill", size: 20) }
          }
          .buttonStyle(.plain)
          .padding(.top, 8)
        }
      }
    }
    .padding(14)
    .foregroundStyle(text)
    .widgetBackground { background }
  }

  @ViewBuilder
  private func titles(lines: Int) -> some View {
    if !entry.signedIn {
      Text("Open Squirmy to sign in").font(.subheadline.weight(.semibold)).lineLimit(2)
    } else if let item = entry.item {
      VStack(alignment: .leading, spacing: 2) {
        if let device = item.device {
          Label(device, systemImage: "hifispeaker.fill")
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .opacity(0.8)
        }
        Text(item.title).font(.subheadline.weight(.semibold)).lineLimit(lines)
        if let artist = item.artist {
          Text(artist).font(.caption).lineLimit(1).opacity(0.75)
        }
      }
    } else {
      VStack(alignment: .leading, spacing: 2) {
        Text("Not Playing").font(.subheadline.weight(.semibold))
        Text("Squirmy").font(.caption).opacity(0.75)
      }
    }
  }

  @ViewBuilder
  private var progress: some View {
    if entry.live, let span = entry.span {
      ProgressView(timerInterval: span, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
        .progressViewStyle(.linear)
        .tint(text)
    } else {
      ProgressView(value: entry.progress).progressViewStyle(.linear).tint(text)
    }
  }

  private func playButton(size: CGFloat) -> some View {
    Button(intent: TogglePlaybackIntent()) {
      control(entry.live ? "pause.fill" : "play.fill", size: size * 0.5)
        .frame(width: size, height: size)
        .background(Circle().fill(text.opacity(0.16)))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(entry.live ? "Pause" : "Play")
  }

  private func control(_ symbol: String, size: CGFloat) -> some View {
    Image(systemName: symbol).font(.system(size: size, weight: .semibold)).frame(minWidth: 32, minHeight: 32)
  }

  /// The cover's color, deeper in Dark Mode, so the widget takes the music's look as Apple Music's does.
  private var background: some View {
    ZStack {
      if let color = Color(hex: entry.item?.color) {
        color
        Color.black.opacity(scheme == .dark ? 0.45 : 0.12)
      } else {
        Color(uiColor: .secondarySystemBackground)
      }
    }
  }

  private var text: Color {
    guard rendering == .fullColor else { return .primary }
    guard let light = luminance(entry.item?.color) else { return .primary }
    return scheme == .light && light * 0.88 > 0.45 ? .black : .white
  }

  // MARK: Lock Screen

  private var rectangular: some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 1) {
        if let item = entry.item {
          Label(item.device ?? "Squirmy", systemImage: item.device == nil ? "waveform" : "hifispeaker.fill")
            .font(.caption2.weight(.semibold))
            .widgetAccentable()
            .lineLimit(1)
          Text(item.title).font(.headline).lineLimit(1)
          if let artist = item.artist { Text(artist).font(.caption).lineLimit(1).foregroundStyle(.secondary) }
        } else {
          Label("Squirmy", systemImage: "waveform").font(.caption2.weight(.semibold)).widgetAccentable()
          Text(entry.signedIn ? "Not Playing" : "Open to sign in").font(.headline).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if entry.item != nil {
        Button(intent: TogglePlaybackIntent()) {
          Image(systemName: entry.live ? "pause.fill" : "play.fill").font(.title3)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(entry.live ? "Pause" : "Play")
      }
    }
    .widgetBackground { Color.clear }
  }

  private var circular: some View {
    Button(intent: TogglePlaybackIntent()) {
      ZStack {
        if entry.live, let span = entry.span {
          ProgressView(timerInterval: span, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
            .progressViewStyle(.circular)
        } else {
          ProgressView(value: entry.progress).progressViewStyle(.circular)
        }
        Image(systemName: entry.item == nil ? "music.note" : entry.live ? "pause.fill" : "play.fill")
          .font(.title3.weight(.semibold))
          .widgetAccentable()
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(entry.live ? "Pause" : "Play")
    .widgetBackground { AccessoryWidgetBackground() }
  }

  private var inline: some View {
    Group {
      if let item = entry.item {
        Label([item.title, item.artist].compactMap { $0 }.joined(separator: " · "), systemImage: entry.live ? "play.fill" : "pause.fill")
      } else {
        Label("Squirmy", systemImage: "music.note")
      }
    }
    .widgetBackground { Color.clear }
  }
}
