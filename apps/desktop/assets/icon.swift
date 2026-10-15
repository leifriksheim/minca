// Draws the app icon: Minca's rainbow (apps/shared/src/mark.ts) on a warm
// ground, in the rounded square macOS gives every app, with the soft shadow
// under it.
//
//   swift apps/desktop/assets/icon.swift apps/desktop/assets/icon.iconset
//
// Every size an .iconset holds; the build turns it into AppIcon.icns
// (electrobun.config.ts, `mac.icons`).
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func colour(_ hex: Int, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(
    red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

// apps/shared/src/tokens.ts
let edge = colour(0x13214a, 0.12)
/// Apricot: the peach band, lightened, so the ground is warm and the band still shows on it
let ground = colour(0xf8d4a4)
let bands: [(outer: CGFloat, inner: CGFloat, fill: CGColor)] = [
  (11.5, 8.75, colour(0x2340d6)), (8.75, 6, colour(0xff6b4a)),
  (6, 3.25, colour(0xffc46b)), (3.25, 0, colour(0x4e8f6c)),
]

/// One icon, `size` pixels square, drawn on Apple's 1024 grid: an 824 square, corners of 185.
func draw(_ size: Int) -> CGImage {
  let context = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  let scale = CGFloat(size) / 1024
  context.scaleBy(x: scale, y: scale)
  let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
  let shape = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)

  // The ground, lifted off the dock by a soft shadow.
  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -10), blur: 28, color: colour(0x000000, 0.3))
  context.addPath(shape)
  context.setFillColor(ground)
  context.fillPath()
  context.restoreGState()

  context.saveGState()
  context.addPath(shape)
  context.clip()
  // The rainbow, 23 of the mark's units 600 pixels wide, its middle a little under the tile's, where the eye puts it.
  let unit: CGFloat = 600 / 23
  let center = CGPoint(x: 512, y: 512 - 11.5 * unit / 2 - 12)
  for band in bands {
    let path = CGMutablePath()
    path.addArc(
      center: center, radius: band.outer * unit, startAngle: 0, endAngle: .pi, clockwise: false)
    if band.inner > 0 {
      path.addArc(
        center: center, radius: band.inner * unit, startAngle: .pi, endAngle: 0, clockwise: true)
    }
    path.closeSubpath()
    context.addPath(path)
    context.setFillColor(band.fill)
    context.fillPath()
  }
  context.restoreGState()

  // One navy edge, as every Minca surface has.
  context.addPath(shape)
  context.setStrokeColor(edge)
  context.setLineWidth(max(4, 1 / scale))
  context.strokePath()
  return context.makeImage()!
}

let folder = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
  for (factor, suffix) in [(1, ""), (2, "@2x")] {
    let out = folder.appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
    let file = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(file, draw(points * factor), nil)
    CGImageDestinationFinalize(file)
  }
}
