// Draws the menu bar icon: Minca's rainbow (apps/example/public/favicon.svg)
// in one colour, as a template image, so macOS tints it like every other
// icon there. Its four bands keep a gap between them, or one colour would
// make them a half disc.
//
//   swift apps/desktop/assets/tray.swift apps/desktop/assets/tray.png
//
// 44 × 24 pixels, shown at 22 × 12 points (index.ts, `Tray`).
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let width = 44, height = 24
let context = CGContext(
  data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))

// From the bottom edge, in pixels: three arcs and the half disc inside them.
let center = CGPoint(x: 22, y: 2)
let bands: [(outer: CGFloat, inner: CGFloat)] = [(20, 16.5), (15, 11.5), (10, 6.5), (5, 0)]
for band in bands {
  let path = CGMutablePath()
  path.addArc(center: center, radius: band.outer, startAngle: 0, endAngle: .pi, clockwise: false)
  if band.inner > 0 {
    path.addArc(center: center, radius: band.inner, startAngle: .pi, endAngle: 0, clockwise: true)
  }
  path.closeSubpath()
  context.addPath(path)
  context.fillPath()
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let file = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(file, context.makeImage()!, nil)
CGImageDestinationFinalize(file)
