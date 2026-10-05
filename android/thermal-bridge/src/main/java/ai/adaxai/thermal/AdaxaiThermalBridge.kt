// NOT COMPILED, NOT RUN on hardware. Written against the FLIR Atlas Android SDK 2.4.0 javadoc and the Android WebView documentation
// without an Android SDK, a JDK, the FLIR SDK, a tablet or a FLIR ONE. Nothing in this file has been tested. See android/README.md and
// docs/THERMAL_CAMERA.md.
package ai.adaxai.thermal

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Bridge contract v1 between the ADAXAI web app and a FLIR ONE on this tablet. Registered with
 * `webView.addJavascriptInterface(bridge, "AdaxaiThermalNative")` (call [attach]); the page calls the methods below and listens for
 * `adaxai-thermal` events on `window`.
 *
 * Security:
 * - Every method first checks that the WebView's current URL has the configured ADAXAI origin (scheme, host and port, exactly). From any
 *   other page a method that returns a value returns `{"error":{"code":"origin_not_allowed",...}}` and the others do nothing.
 * - Events, frames and captured files are handed to the page only while the WebView shows that origin; otherwise they are dropped.
 * - The bridge sends nothing anywhere else: no network call, no file kept (a capture's temporary file is deleted once read), no log of
 *   image contents or of the page's URL. The page uploads a capture to ADAXAI over its own authenticated session.
 * - The check is on the top-level page. Android injects the object into every frame of that page, iframes included, so the web app must
 *   not embed content from other origins (see docs/THERMAL_CAMERA.md, "Security").
 *
 * Lifecycle, for the host Activity:
 * - onCreate: construct it on the UI thread with the Activity, then call [attach] before loading the page. The Activity is the FLIR
 *   SDK's UI context (`ThermalSdkAndroid.init`, the USB permission dialog); the camera code keeps it only through a weak reference,
 *   and this class does not keep it at all.
 * - onPause: [pausePreview]. The stream stops and the page gets `connected`.
 * - onResume: [reportStatus]. The page gets the camera's current state again; the live view is not restarted by the bridge, the page
 *   asks for it (`startPreview()` works from `connected`).
 * - onDestroy: [release], before `webView.destroy()`.
 */
class AdaxaiThermalBridge(activity: Activity, private val webView: WebView, allowedOrigin: String) {
  companion object {
    /** The name the page sees: `window.AdaxaiThermalNative`. */
    const val JS_NAME = "AdaxaiThermalNative"
    private const val TAG = "AdaxaiThermal"
    private const val URL_READ_TIMEOUT_MS = 1000L
    private const val MAX_REQUEST_ID_LENGTH = 100
  }

  /** An origin: scheme, host and port, compared exactly. Only http and https. */
  private class Origin(val scheme: String, val host: String, val port: Int) {
    fun matches(url: String?): Boolean {
      val o = parse(url) ?: return false
      return o.scheme == scheme && o.host == host && o.port == port
    }

    companion object {
      fun parse(url: String?): Origin? {
        if (url.isNullOrEmpty()) return null
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
        if (scheme != "https" && scheme != "http") return null
        val host = uri.host?.lowercase(Locale.ROOT)
        if (host.isNullOrEmpty()) return null
        val port = if (uri.port != -1) uri.port else if (scheme == "https") 443 else 80
        return Origin(scheme, host, port)
      }
    }
  }

  private val origin: Origin = Origin.parse(allowedOrigin) ?: throw IllegalArgumentException("allowedOrigin must be an http or https origin, e.g. https://adaxai.example.org")
  private val main = Handler(Looper.getMainLooper())
  private val camera: FlirOneCamera
  @Volatile private var released = false

  /** The newest frame not yet handed to the page. Frames are coalesced: a slow page gets the latest one, not a queue. */
  private val pendingFrame = AtomicReference<String?>(null)

  private val events = object : CameraEvents {
    override fun onStatus(snapshot: StatusSnapshot) = dispatch(BridgeJson.eventScript(BridgeJson.status(snapshot, event = true)))

    override fun onFrame(frame: PreviewFrame) {
      val b64 = Base64.encodeToString(frame.jpeg, Base64.NO_WRAP)
      dispatchFrame(BridgeJson.eventScript(BridgeJson.frame(b64, frame.width, frame.height, frame.scaleMinC, frame.scaleMaxC, frame.at)))
    }

    override fun onCapture(result: CaptureResult) {
      val json = when (result) {
        is CaptureResult.Ok ->
          BridgeJson.captureOk(
            result.requestId,
            Base64.encodeToString(result.bytes, Base64.NO_WRAP),
            result.fileName,
            result.capturedAt,
            result.capturedAtSource,
            result.device,
            FlirOneCamera.sdkInfo(),
            result.stats,
          )
        is CaptureResult.Failed -> BridgeJson.captureFailed(result.requestId, result.error)
      }
      dispatch(BridgeJson.eventScript(json))
    }
  }

  init {
    check(Looper.myLooper() == Looper.getMainLooper()) { "Create AdaxaiThermalBridge on the UI thread" }
    // The SDK's javadoc: initialisation "must be done from UI code", with a context that "*MUST* be a UI context". See initSdk.
    FlirOneCamera.initSdk(activity)
    camera = FlirOneCamera(activity, events)
  }

  /** Register on the WebView as `window.AdaxaiThermalNative`. The page sees it from its next load. */
  fun attach() {
    webView.addJavascriptInterface(this, JS_NAME)
  }

  /**
   * For the host's onPause: stop the live preview. The camera stays connected and the page gets a `status` event saying `connected`.
   * Not reachable from the page.
   */
  fun pausePreview() {
    if (!released) camera.stopPreview()
  }

  /**
   * For the host's onResume: send the page the camera's current state as a `status` event (`connected` after a pause, `disconnected`
   * if the camera went away meanwhile), so the page shows the truth and offers to start the live view. Not reachable from the page.
   */
  fun reportStatus() {
    if (!released) camera.reportStatus()
  }

  /** For the host's onDestroy, before `webView.destroy()`: disconnect the camera and stop the bridge. */
  fun release() {
    if (released) return
    released = true
    camera.release()
    webView.removeJavascriptInterface(JS_NAME)
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Origin check
  // ---------------------------------------------------------------------------------------------------------------------------------

  /**
   * The WebView's current URL. JavaScript calls arrive on a background thread and a WebView may only be touched on the UI thread, so it
   * is read there; no answer within a second counts as not allowed.
   */
  private fun currentUrl(): String? {
    if (Looper.myLooper() == Looper.getMainLooper()) return webView.url
    val latch = CountDownLatch(1)
    val url = AtomicReference<String?>(null)
    main.post {
      try {
        url.set(webView.url)
      } finally {
        latch.countDown()
      }
    }
    return if (latch.await(URL_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)) url.get() else null
  }

  private fun pageAllowed(): Boolean {
    if (released) return false
    if (origin.matches(currentUrl())) return true
    Log.w(TAG, "Bridge call refused: the page is not on the configured ADAXAI origin")
    return false
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Events to the page (always on the UI thread)
  // ---------------------------------------------------------------------------------------------------------------------------------

  private fun dispatch(script: String) {
    if (released) return
    main.post { evaluate(script) }
  }

  private fun dispatchFrame(script: String) {
    if (released) return
    if (pendingFrame.getAndSet(script) != null) return // a hand-over is already posted; it will take this newer frame
    main.post {
      val latest = pendingFrame.getAndSet(null)
      if (latest != null) evaluate(latest)
    }
  }

  /** On the UI thread. Nothing reaches a page of another origin: the URL is checked again at the moment of hand-over. */
  private fun evaluate(script: String) {
    if (released || !origin.matches(webView.url)) return
    webView.evaluateJavascript(script, null)
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Contract v1: called by the page, on the WebView's background thread
  // ---------------------------------------------------------------------------------------------------------------------------------

  @JavascriptInterface
  fun bridgeInfo(): String {
    if (!pageAllowed()) return BridgeJson.refused().toString()
    return BridgeJson.bridgeInfo(FlirOneCamera.sdkInfo()).toString()
  }

  @JavascriptInterface
  fun getStatus(): String {
    if (!pageAllowed()) return BridgeJson.refused().toString()
    return BridgeJson.status(camera.status, event = false).toString()
  }

  @JavascriptInterface
  fun getCapabilities(): String {
    if (!pageAllowed()) return BridgeJson.refused().toString()
    return BridgeJson.capabilities().toString()
  }

  /** DeviceInfo, or `null` (the string, which `JSON.parse` reads as null) when no camera is connected. */
  @JavascriptInterface
  fun getDeviceInfo(): String {
    if (!pageAllowed()) return BridgeJson.refused().toString()
    return BridgeJson.deviceInfo(camera.status.device).toString()
  }

  @JavascriptInterface
  fun connect() {
    if (pageAllowed()) camera.connect()
  }

  @JavascriptInterface
  fun disconnect() {
    if (pageAllowed()) camera.disconnect()
  }

  @JavascriptInterface
  fun startPreview() {
    if (pageAllowed()) camera.startPreview()
  }

  @JavascriptInterface
  fun stopPreview() {
    if (pageAllowed()) camera.stopPreview()
  }

  /** The answer comes as a `capture` event with the same `requestId` (1 to 100 characters, chosen by the page). */
  @JavascriptInterface
  fun capture(requestId: String?) {
    if (!pageAllowed()) return
    val id = requestId?.trim().orEmpty()
    if (id.isEmpty() || id.length > MAX_REQUEST_ID_LENGTH) {
      dispatch(BridgeJson.eventScript(BridgeJson.captureFailed(id.take(MAX_REQUEST_ID_LENGTH), BridgeError("invalid_request_id", "A capture needs a request id of 1 to 100 characters."))))
      return
    }
    camera.capture(id)
  }
}
