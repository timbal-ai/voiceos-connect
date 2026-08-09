import SwiftUI

struct ContentView: View {
    @StateObject private var controller = StreamController()
    @FocusState private var hostFieldFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            statusBar
            if controller.isActive {
                RemoteWebView(controller: controller)
                    .ignoresSafeArea(.keyboard)
            } else {
                setupScreen
            }
        }
    }

    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(controller.isActive ? Color.green : Color.red)
                .frame(width: 10, height: 10)
            Text(statusText)
                .font(.footnote)
                .lineLimit(1)
            Spacer()
            if controller.state == .connected {
                Button("Disconnect") { controller.disconnect() }
                    .font(.footnote.weight(.semibold))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.thinMaterial)
    }

    private var statusText: String {
        if controller.usbClientCount > 0 {
            return controller.isCapturing ? "Streaming over USB" : "USB connected — starting capture…"
        }
        switch controller.state {
        case .disconnected: return "Not connected"
        case .connecting: return "Connecting…"
        case .connected: return controller.isCapturing ? "Streaming to \(controller.serverHost)" : "Connected — starting capture…"
        case .failed(let message): return message
        }
    }

    private var setupScreen: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "iphone.badge.play")
                .font(.system(size: 56))
                .foregroundStyle(.blue)

            Text("VoiceOS Connect")
                .font(.largeTitle.bold())

            Text("Stream this phone's screen to your computer and control this app from your browser.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            VStack(alignment: .leading, spacing: 8) {
                Text("Computer IP address")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("e.g. 192.168.1.42", text: $controller.serverHost)
                    .keyboardType(.decimalPad)
                    .textFieldStyle(.roundedBorder)
                    .focused($hostFieldFocused)
                Text("Run `npm start` in the server folder on your computer — it prints this IP.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 32)

            Button {
                hostFieldFocused = false
                controller.connect()
            } label: {
                Label("Connect & Start Streaming", systemImage: "antenna.radiowaves.left.and.right")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 32)
            .disabled(controller.state == .connecting)

            Label("Or just plug in the USB cable — no IP needed", systemImage: "cable.connector")
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer()
            Spacer()
        }
    }
}

#Preview {
    ContentView()
}
