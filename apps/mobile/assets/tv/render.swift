// Run with `swift apps/mobile/assets/tv/render.swift` after regenerating the iOS icon.
import AppKit
import CoreText
import ImageIO
import UniformTypeIdentifiers

let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let layers = directory.deletingLastPathComponent().appending(path: "Squirmy.icon/Assets")
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

func image(_ source: String) -> CGImage {
    let url = layers.appending(path: source) as CFURL
    return CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(url, nil)!, 0, nil)!
}

let body = image("worm-body.png")
let eyes = image("worm-face.png")

func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
    let components = [16, 8, 0].map { CGFloat((hex >> $0) & 255) / 255 } + [alpha]
    return CGColor(colorSpace: colorSpace, components: components)!
}

func paint(_ name: String, width: Int, height: Int, opaque: Bool, format: UTType = .png, draw: (CGContext) -> Void) {
    let bitmapInfo = opaque ? CGImageAlphaInfo.noneSkipLast : .premultipliedLast
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                            bytesPerRow: 0, space: colorSpace, bitmapInfo: bitmapInfo.rawValue)!
    context.interpolationQuality = .high
    draw(context)

    let suffix = format == .jpeg ? "jpg" : "png"
    let url = directory.appending(path: "\(name)-\(width).\(suffix)") as CFURL
    let destination = CGImageDestinationCreateWithURL(url, format.identifier as CFString, 1, nil)!
    let properties = format == .jpeg ? [kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary : nil
    CGImageDestinationAddImage(destination, context.makeImage()!, properties)
    precondition(CGImageDestinationFinalize(destination))
}

func drawIcon(width: Int) {
    let height = width * 3 / 5
    let length = CGFloat(width)
    let worm = CGRect(x: 0, y: -length * 0.25, width: length, height: length)
    paint("eyes", width: width, height: height, opaque: false) { $0.draw(eyes, in: worm) }
    paint("body", width: width, height: height, opaque: false) { $0.draw(body, in: worm) }
    paint("background", width: width, height: height, opaque: true) { context in
        let floor = CGGradient(colorsSpace: colorSpace,
                               colors: [color(0x7063B6), color(0xB9B0E4)] as CFArray, locations: nil)!
        context.drawLinearGradient(floor, start: .zero, end: CGPoint(x: length * 0.75, y: CGFloat(height)),
                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }
}

func drawShelf(width: Int, height: Int) {
    let w = CGFloat(width)
    let h = CGFloat(height)
    paint("shelf", width: width, height: height, opaque: true, format: .jpeg) { context in
        context.setFillColor(color(0x12101C))
        context.fill(CGRect(x: 0, y: 0, width: w, height: h))

        let glow = CGGradient(colorsSpace: colorSpace,
                              colors: [color(0x51416F), color(0x201932, alpha: 0)] as CFArray, locations: nil)!
        let center = CGPoint(x: w * 0.77, y: h * 0.45)
        context.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center,
                                   endRadius: w * 0.53, options: [])

        context.setStrokeColor(color(0xC9A6E5, alpha: 0.13))
        context.setLineWidth(h / 600)
        for groove in 0..<14 {
            let radius = h * (0.51 + CGFloat(groove) * 0.053)
            let rings = CGPoint(x: w * 0.735, y: h * 0.48)
            context.strokeEllipse(in: CGRect(x: rings.x - radius, y: rings.y - radius,
                                             width: radius * 2, height: radius * 2))
        }

        context.saveGState()
        context.translateBy(x: w, y: 0)
        context.scaleBy(x: -1, y: 1)
        let length = h * 1.68
        let worm = CGRect(x: 0, y: -h * 0.40, width: length, height: length)
        context.setShadow(offset: CGSize(width: 0, height: -h * 0.018), blur: h * 0.075,
                          color: color(0x100B1C, alpha: 0.6))
        context.draw(body, in: worm)
        context.setShadow(offset: .zero, blur: 0)
        context.draw(eyes, in: worm)
        context.restoreGState()

        let font = NSFont.systemFont(ofSize: h * 0.193, weight: .semibold)
        let wordmark = NSAttributedString(string: "Squirmy", attributes: [
            .font: font, .kern: -h * 0.006,
            .foregroundColor: NSColor(cgColor: color(0xF5F2FF))!,
        ])
        context.textPosition = CGPoint(x: w * 0.235, y: h * 0.442)
        CTLineDraw(CTLineCreateWithAttributedString(wordmark), context)
    }
}

for width in [400, 800, 1280] { drawIcon(width: width) }
for (width, height) in [(1920, 720), (3840, 1440), (2320, 720), (4640, 1440)] {
    drawShelf(width: width, height: height)
}
