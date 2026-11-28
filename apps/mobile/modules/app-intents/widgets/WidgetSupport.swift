import SwiftUI
import UIKit
import WidgetKit

/// Links into the app, under the scheme of the build the extension came with (`squirmy`, or `squirmy-dev`).
enum WidgetLinks {
  private static var scheme: String {
    Bundle.main.object(forInfoDictionaryKey: "SquirmyURLScheme") as? String ?? "squirmy"
  }

  static func url(_ path: String) -> URL? {
    URL(string: "\(scheme)://\(path)")
  }

  static var nowPlaying: URL? { url("now-playing") }
  static var downloads: URL? { url("downloads") }
}

enum WidgetArtwork {
  static func image(_ name: String?) -> UIImage? {
    guard let url = name.flatMap(SurfacePaths.artwork(named:)) else { return nil }
    return UIImage(contentsOfFile: url.path)
  }
}

extension Color {
  /// From the server's `#rrggbb`.
  init?(hex: String?) {
    guard let hex, hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    self.init(
      red: Double((value >> 16) & 0xFF) / 255,
      green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255
    )
  }
}

/// How light a `#rrggbb` color is (0 to 1), to pick text that reads on it.
func luminance(_ hex: String?) -> Double? {
  guard let hex, hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
  let channel = { (shift: UInt32) -> Double in
    let c = Double((value >> shift) & 0xFF) / 255
    return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}

extension View {
  /// The widget's background, which iOS takes away in tinted modes and StandBy.
  func widgetBackground<Background: View>(@ViewBuilder _ background: () -> Background) -> some View {
    containerBackground(for: .widget, content: background)
  }
}

extension Image {
  /// A cover in a tinted Home Screen keeps its picture, toned to the tint, rather than turning into a flat shape.
  @ViewBuilder
  func coverRendering() -> some View {
    if #available(iOS 18.0, *) {
      widgetAccentedRenderingMode(.accentedDesaturated)
    } else {
      self
    }
  }
}

/// A cover, or a gradient with a symbol for something with none (Liked Songs, a radio).
struct CoverView: View {
  let image: UIImage?
  let color: String?
  let symbol: String
  var round = false
  var radius: CGFloat = 8

  var body: some View {
    ZStack {
      if let image {
        Image(uiImage: image).resizable().coverRendering().scaledToFill()
      } else {
        LinearGradient(
          colors: [Color(hex: color) ?? Color(red: 0.62, green: 0.6, blue: 0.84), Color(red: 0.19, green: 0.15, blue: 0.29)],
          startPoint: .topLeading, endPoint: .bottomTrailing
        )
        Image(systemName: symbol).font(.title3.weight(.semibold)).foregroundStyle(.white.opacity(0.9))
      }
    }
    .aspectRatio(1, contentMode: .fit)
    .clipShape(round ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: radius, style: .continuous)))
  }
}

func symbol(forKind kind: String) -> String {
  switch kind {
  case "liked": return "heart.fill"
  case "artist": return "person.fill"
  case "playlist", "mix": return "music.note.list"
  case "radio": return "dot.radiowaves.left.and.right"
  default: return "music.note"
  }
}
