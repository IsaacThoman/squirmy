import ImageIO
import UIKit

@MainActor
final class CarPlayArtwork {
  private let cache = NSCache<NSString, UIImage>()
  private let session: URLSession
  private var pending: [String: [(UIImage) -> Void]] = [:]

  init() {
    cache.totalCostLimit = 16 * 1024 * 1024
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForResource = 12
    config.httpMaximumConnectionsPerHost = 4
    session = URLSession(configuration: config)
  }

  deinit {
    session.invalidateAndCancel()
  }

  func load(_ url: URL, pixels: Int, scale: CGFloat, receive: @escaping (UIImage) -> Void) {
    guard url.isFileURL || ["https", "http"].contains(url.scheme?.lowercased()) else { return }
    let key = "\(pixels):\(scale):\(url.absoluteString)"
    if let cached = cache.object(forKey: key as NSString) {
      receive(cached)
      return
    }
    if pending[key] != nil {
      pending[key]?.append(receive)
      return
    }
    pending[key] = [receive]

    if url.isFileURL {
      DispatchQueue.global(qos: .utility).async { [weak self] in
        let source = CGImageSourceCreateWithURL(url as CFURL, nil)
        let thumbnail = Self.thumbnail(source, pixels: pixels)
        DispatchQueue.main.async { [weak self] in self?.complete(key, with: thumbnail, scale: scale) }
      }
    } else {
      session.dataTask(with: url) { [weak self] data, response, _ in
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let thumbnail: CGImage?
        if (200..<300).contains(status), let data, data.count <= 10 * 1024 * 1024 {
          let source = CGImageSourceCreateWithData(data as CFData, nil)
          thumbnail = Self.thumbnail(source, pixels: pixels)
        } else {
          thumbnail = nil
        }
        DispatchQueue.main.async { [weak self] in self?.complete(key, with: thumbnail, scale: scale) }
      }.resume()
    }
  }

  private func complete(_ key: String, with thumbnail: CGImage?, scale: CGFloat) {
    let receivers = pending.removeValue(forKey: key)
    guard let thumbnail else { return }
    let image = UIImage(cgImage: thumbnail, scale: scale, orientation: .up)
    cache.setObject(image, forKey: key as NSString, cost: thumbnail.bytesPerRow * thumbnail.height)
    receivers?.forEach { $0(image) }
  }

  nonisolated private static func thumbnail(_ source: CGImageSource?, pixels: Int) -> CGImage? {
    guard let source else { return nil }
    return CGImageSourceCreateThumbnailAtIndex(source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: pixels,
    ] as CFDictionary)
  }

  static func placeholder(size: CGFloat, scale: CGFloat, dark: Bool) -> UIImage {
    let size = CGSize(width: size, height: size)
    let format = UIGraphicsImageRendererFormat()
    format.scale = scale
    return UIGraphicsImageRenderer(size: size, format: format).image { context in
      let rect = CGRect(origin: .zero, size: size)
      let fill = dark ? UIColor(red: 0.16, green: 0.13, blue: 0.23, alpha: 1)
        : UIColor(red: 0.94, green: 0.92, blue: 0.97, alpha: 1)
      let ink = dark ? UIColor(red: 0.80, green: 0.76, blue: 1, alpha: 1)
        : UIColor(red: 0.36, green: 0.26, blue: 0.62, alpha: 1)
      fill.setFill()
      context.fill(rect)
      let symbol = UIImage(systemName: "music.note", withConfiguration: UIImage.SymbolConfiguration(pointSize: size.width * 0.36))
      if let symbol = symbol?.withTintColor(ink, renderingMode: .alwaysOriginal) {
        let origin = CGPoint(x: (size.width - symbol.size.width) / 2, y: (size.height - symbol.size.height) / 2)
        symbol.draw(at: origin)
      }
    }
  }
}
