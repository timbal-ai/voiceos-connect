import Foundation
import ReplayKit
import CoreImage
import UIKit

/// A control command sent from the PC viewer.
enum ControlEvent {
    case tap(x: CGFloat, y: CGFloat)          // normalized 0..1 in screen space
    case scroll(dx: CGFloat, dy: CGFloat)
    case text(String)
    case key(String)                          // "backspace" | "enter"
    case navOpen(URL)
    case navBack
}

@MainActor
final class StreamController: NSObject, ObservableObject {
    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case failed(String)
    }

    @Published var state: ConnectionState = .disconnected
    @Published var isCapturing = false
    @Published var usbClientCount = 0
    @Published var serverHost: String = UserDefaults.standard.string(forKey: "serverHost") ?? ""

    /// The view layer registers here to receive control events (e.g. the web view).
    var onControlEvent: ((ControlEvent) -> Void)?

    /// True when any transport (Wi-Fi or USB) is active.
    var isActive: Bool { state == .connected || usbClientCount > 0 }

    private var socket: URLSessionWebSocketTask?
    private let recorder = RPScreenRecorder.shared()
    private let encoder = FrameEncoder()
    private let usbServer = USBServer()

    override init() {
        super.init()
        // The Mac tunnels into this server over the USB cable (usbmuxd).
        usbServer.onControlMessage = { [weak self] text in
            self?.handleControlMessage(text)
        }
        usbServer.onClientCountChanged = { [weak self] count in
            guard let self else { return }
            self.usbClientCount = count
            if count > 0 {
                self.startCapture()
            } else if self.state != .connected {
                self.stopCapture()
            }
        }
        usbServer.start()
    }

    // MARK: - Connection

    func connect() {
        let host = serverHost.trimmingCharacters(in: .whitespaces)
        guard !host.isEmpty, let url = URL(string: "ws://\(host):8080/?role=phone") else {
            state = .failed("Enter your computer's IP address first")
            return
        }
        UserDefaults.standard.set(host, forKey: "serverHost")

        disconnect()
        state = .connecting

        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        task.resume()

        receiveLoop(task)

        // Verify the connection with a ping before starting capture
        task.sendPing { [weak self] error in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                if let error {
                    self.state = .failed("Can't reach \(host): \(error.localizedDescription)")
                    self.socket = nil
                } else {
                    self.state = .connected
                    self.startCapture()
                }
            }
        }
    }

    func disconnect() {
        if usbClientCount == 0 { stopCapture() }
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        state = .disconnected
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message {
                        self.handleControlMessage(text)
                    }
                    self.receiveLoop(task)
                case .failure(let error):
                    if self.state == .connected || self.state == .connecting {
                        self.state = .failed("Connection lost: \(error.localizedDescription)")
                    }
                    if self.usbClientCount == 0 { self.stopCapture() }
                    self.socket = nil
                }
            }
        }
    }

    // MARK: - Control messages from the PC

    private func handleControlMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "tap":
            if let x = json["x"] as? Double, let y = json["y"] as? Double {
                onControlEvent?(.tap(x: x, y: y))
            }
        case "scroll":
            let dx = json["dx"] as? Double ?? 0
            let dy = json["dy"] as? Double ?? 0
            onControlEvent?(.scroll(dx: dx, dy: dy))
        case "text":
            if let t = json["text"] as? String {
                onControlEvent?(.text(t))
            }
        case "key":
            if let k = json["key"] as? String {
                onControlEvent?(.key(k))
            }
        case "nav":
            if let action = json["action"] as? String {
                if action == "back" {
                    onControlEvent?(.navBack)
                } else if action == "open",
                          let urlString = json["url"] as? String,
                          let url = URL(string: urlString) {
                    onControlEvent?(.navOpen(url))
                }
            }
        default:
            break
        }
    }

    // MARK: - Screen capture

    private func startCapture() {
        guard !isCapturing, recorder.isAvailable else { return }
        recorder.isMicrophoneEnabled = false

        let encoder = self.encoder
        let usbServer = self.usbServer
        recorder.startCapture { [weak self] sampleBuffer, bufferType, error in
            // Runs on ReplayKit's background queue
            guard error == nil, bufferType == .video,
                  let jpeg = encoder.encodeIfDue(sampleBuffer) else { return }
            usbServer.broadcast(jpeg)
            Task { @MainActor in
                guard let self, let socket = self.socket, self.state == .connected else { return }
                socket.send(.data(jpeg)) { _ in }
            }
        } completionHandler: { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.state = .failed("Screen capture failed: \(error.localizedDescription)")
                } else {
                    self.isCapturing = true
                }
            }
        }
    }

    private func stopCapture() {
        guard isCapturing else { return }
        recorder.stopCapture { _ in }
        isCapturing = false
    }
}

/// Downscales, throttles, and JPEG-encodes captured frames.
/// Not actor-isolated: ReplayKit delivers frames on its own serial queue.
final class FrameEncoder: @unchecked Sendable {
    private let ciContext = CIContext()
    private let targetFPS: Double = 12
    private let targetWidth: CGFloat = 540
    private var lastSent: TimeInterval = 0

    func encodeIfDue(_ sampleBuffer: CMSampleBuffer) -> Data? {
        let now = CACurrentMediaTime()
        guard now - lastSent >= 1.0 / targetFPS else { return nil }
        lastSent = now

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }

        var image = CIImage(cvPixelBuffer: pixelBuffer)
        let scale = targetWidth / image.extent.width
        if scale < 1 {
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }

        return ciContext.jpegRepresentation(
            of: image,
            colorSpace: CGColorSpaceCreateDeviceRGB(),
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.5]
        )
    }
}
