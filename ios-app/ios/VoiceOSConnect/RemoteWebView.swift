import SwiftUI
import WebKit

/// A WKWebView the PC viewer can drive: taps, scrolls, typing, and navigation.
struct RemoteWebView: UIViewRepresentable {
    @ObservedObject var controller: StreamController

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: URL(string: "https://www.google.com")!))
        context.coordinator.webView = webView

        controller.onControlEvent = { [weak coordinator = context.coordinator] event in
            coordinator?.apply(event)
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator {
        weak var webView: WKWebView?

        func apply(_ event: ControlEvent) {
            guard let webView else { return }
            switch event {
            case .tap(let nx, let ny):
                // Viewer coordinates are normalized to the whole phone screen;
                // convert to a point inside the web view.
                let screen = UIScreen.main.bounds
                let screenPoint = CGPoint(x: nx * screen.width, y: ny * screen.height)
                let local = webView.convert(screenPoint, from: nil)
                guard webView.bounds.contains(local) else { return }
                tap(at: local, in: webView)

            case .scroll(let dx, let dy):
                run(webView, "window.scrollBy({left: \(dx), top: \(dy), behavior: 'instant'});")

            case .text(let text):
                let escaped = jsString(text)
                run(webView, """
                (function() {
                  var el = document.activeElement;
                  if (!el) return;
                  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    var s = el.selectionStart ?? el.value.length;
                    var e = el.selectionEnd ?? s;
                    try { el.setRangeText(\(escaped), s, e, 'end'); }
                    catch (_) { el.value += \(escaped); }
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                  } else if (el.isContentEditable) {
                    document.execCommand('insertText', false, \(escaped));
                  }
                })();
                """)

            case .key("backspace"):
                run(webView, """
                (function() {
                  var el = document.activeElement;
                  if (!el) return;
                  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    var s = el.selectionStart ?? el.value.length;
                    var e = el.selectionEnd ?? s;
                    if (s === e && s > 0) s -= 1;
                    try { el.setRangeText('', s, e, 'end'); }
                    catch (_) { el.value = el.value.slice(0, -1); }
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                  } else if (el.isContentEditable) {
                    document.execCommand('delete');
                  }
                })();
                """)

            case .key("enter"):
                run(webView, """
                (function() {
                  var el = document.activeElement;
                  if (!el) return;
                  var opts = {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true};
                  el.dispatchEvent(new KeyboardEvent('keydown', opts));
                  el.dispatchEvent(new KeyboardEvent('keyup', opts));
                  if (el.form) {
                    if (el.form.requestSubmit) el.form.requestSubmit();
                    else el.form.submit();
                  }
                })();
                """)

            case .key:
                break

            case .navOpen(let url):
                webView.load(URLRequest(url: url))

            case .navBack:
                if webView.canGoBack { webView.goBack() }
            }
        }

        private func tap(at point: CGPoint, in webView: WKWebView) {
            // WKWebView points map 1:1 to CSS pixels at default zoom.
            let x = point.x
            let y = point.y
            run(webView, """
            (function() {
              var el = document.elementFromPoint(\(x), \(y));
              if (!el) return;
              var opts = {bubbles: true, cancelable: true, clientX: \(x), clientY: \(y), view: window};
              el.dispatchEvent(new PointerEvent('pointerdown', opts));
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              el.dispatchEvent(new PointerEvent('pointerup', opts));
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.dispatchEvent(new MouseEvent('click', opts));
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) el.focus();
            })();
            """)
        }

        private func run(_ webView: WKWebView, _ js: String) {
            webView.evaluateJavaScript(js) { _, _ in }
        }

        private func jsString(_ s: String) -> String {
            let data = try? JSONSerialization.data(withJSONObject: [s])
            let json = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
            return String(json.dropFirst().dropLast()) // strip the [ ] around the encoded string
        }
    }
}
