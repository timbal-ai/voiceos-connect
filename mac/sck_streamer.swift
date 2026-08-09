// ScreenCaptureKit -> stdout JPEG streamer for the voiceos-connect gateway.
//
// Compiled on demand by agent/sck.py (swiftc, cached in .build/). Emits
// binary frames on stdout: uint32 BE jpeg length, uint32 BE width,
// uint32 BE height, then the JPEG bytes. Logs go to stderr.
//
//   sck_streamer --fps 12 --width 1183 [--rect x,y,w,h]
//
// --rect crops in display points (phone mode: the iPhone Mirroring window).
// Needs Screen Recording permission (same as the rest of the agent).

import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

let fps = Int(arg("--fps") ?? "12") ?? 12
let maxWidth = Int(arg("--width") ?? "1183") ?? 1183
var cropRect: CGRect? = nil
if let r = arg("--rect") {
    let p = r.split(separator: ",").compactMap { Double($0) }
    if p.count == 4 { cropRect = CGRect(x: p[0], y: p[1], width: p[2], height: p[3]) }
}

final class FrameWriter: NSObject, SCStreamOutput {
    private let ciContext = CIContext()
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private let out = FileHandle.standardOutput
    private let quality = CIImageRepresentationOption(
        rawValue: kCGImageDestinationLossyCompressionQuality as String)

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sb) else { return }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let jpeg = try? ciContext.jpegRepresentation(
            of: image, colorSpace: colorSpace, options: [quality: 0.55]) else { return }

        var header = Data(capacity: 12)
        for v in [UInt32(jpeg.count), UInt32(CVPixelBufferGetWidth(pixelBuffer)),
                  UInt32(CVPixelBufferGetHeight(pixelBuffer))] {
            var be = v.bigEndian
            header.append(Data(bytes: &be, count: 4))
        }
        out.write(header)
        out.write(jpeg)
    }
}

let writer = FrameWriter()
// Must outlive the Task closure: if the SCStream is deallocated when the
// startup task ends, capture silently stops after zero frames.
var activeStream: SCStream?

Task {
    do {
        let content = try await SCShareableContent.current
        guard let display = content.displays.first else {
            FileHandle.standardError.write(Data("no display\n".utf8))
            exit(1)
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = true

        var srcW = Double(display.width)
        var srcH = Double(display.height)
        if let rect = cropRect {
            cfg.sourceRect = rect
            srcW = rect.width
            srcH = rect.height
        }
        let scale = min(Double(maxWidth) / srcW, 1.0)
        cfg.width = Int(srcW * scale)
        cfg.height = Int(srcH * scale)

        let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
        activeStream = stream
        try stream.addStreamOutput(writer, type: .screen,
                                   sampleHandlerQueue: DispatchQueue(label: "frames"))
        try await stream.startCapture()
        FileHandle.standardError.write(Data("capturing \(cfg.width)x\(cfg.height)@\(fps)\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("start failed: \(error)\n".utf8))
        exit(1)
    }
}

dispatchMain()
