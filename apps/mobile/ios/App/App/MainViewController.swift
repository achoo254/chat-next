import Capacitor
import UIKit
import WebKit

/// Capacitor bridge of the app: turns on the edge swipe back/forward
/// through the web app's history (screens have URLs; Capacitor leaves the
/// gesture off by default).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        webView?.allowsBackForwardNavigationGestures = true
    }
}
