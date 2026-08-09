import Foundation
import Network

/// WebSocket server the Mac connects to through the USB cable (via usbmuxd/iproxy).
/// Connections arrive as loopback traffic on the phone, so no network permission is involved.
final class USBServer {
    static let port: UInt16 = 9081

    private var listener: NWListener?
    private var clients: [NWConnection] = []
    private let queue = DispatchQueue(label: "usb-server")

    /// Callbacks are invoked on the main queue.
    var onClientCountChanged: ((Int) -> Void)?
    var onControlMessage: ((String) -> Void)?

    func start() {
        let params = NWParameters.tcp
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        guard let listener = try? NWListener(using: params, on: NWEndpoint.Port(rawValue: Self.port)!) else { return }
        self.listener = listener

        listener.newConnectionHandler = { [weak self] connection in
            self?.queue.async { self?.accept(connection) }
        }
        listener.start(queue: queue)
    }

    private func accept(_ connection: NWConnection) {
        clients.append(connection)
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.remove(connection) }
            if case .cancelled = state { self?.remove(connection) }
        }
        connection.start(queue: queue)
        receiveLoop(connection)
        notifyCount()
    }

    private func remove(_ connection: NWConnection) {
        clients.removeAll { $0 === connection }
        notifyCount()
    }

    private func receiveLoop(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            if error != nil {
                connection.cancel()
                self.remove(connection)
                return
            }
            if let data,
               let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata,
               metadata.opcode == .text,
               let text = String(data: data, encoding: .utf8) {
                DispatchQueue.main.async { self.onControlMessage?(text) }
            }
            self.receiveLoop(connection)
        }
    }

    /// Send a binary frame to all connected USB clients.
    func broadcast(_ data: Data) {
        queue.async {
            guard !self.clients.isEmpty else { return }
            let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
            let context = NWConnection.ContentContext(identifier: "frame", metadata: [metadata])
            for client in self.clients {
                client.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
            }
        }
    }

    var hasClients: Bool {
        queue.sync { !clients.isEmpty }
    }

    private func notifyCount() {
        let count = clients.count
        DispatchQueue.main.async { self.onClientCountChanged?(count) }
    }
}
