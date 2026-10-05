// NOT COMPILED, NOT RUN on hardware. Written against the FLIR Atlas Android SDK 2.4.0 javadoc without an Android SDK, a JDK, the FLIR
// SDK, a tablet or a FLIR ONE. Nothing in this file has been tested. Every FLIR name used here is listed, with where it was checked, in
// android/README.md; check each against the javadoc of the SDK version actually downloaded before building.
package ai.adaxai.thermal

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.flir.thermalsdk.ErrorCode
import com.flir.thermalsdk.ErrorCodeException
import com.flir.thermalsdk.androidsdk.ThermalSdkAndroid
import com.flir.thermalsdk.androidsdk.image.BitmapAndroid
import com.flir.thermalsdk.androidsdk.live.connectivity.UsbPermissionHandler
import com.flir.thermalsdk.image.CameraInformation
import com.flir.thermalsdk.image.ImageBuffer
import com.flir.thermalsdk.live.Camera
import com.flir.thermalsdk.live.CommunicationInterface
import com.flir.thermalsdk.live.Identity
import com.flir.thermalsdk.live.connectivity.ConnectionStatusListener
import com.flir.thermalsdk.live.discovery.DiscoveredCamera
import com.flir.thermalsdk.live.discovery.DiscoveryEventListener
import com.flir.thermalsdk.live.discovery.DiscoveryFactory
import com.flir.thermalsdk.live.remote.OnReceived
import com.flir.thermalsdk.live.remote.OnRemoteError
import com.flir.thermalsdk.live.streaming.Stream
import com.flir.thermalsdk.live.streaming.ThermalStreamer
import java.io.ByteArrayOutputStream
import java.io.File
import java.lang.ref.WeakReference
import java.util.Date
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** The camera states of bridge contract v1, with their wire names. */
internal enum class CameraState(val wire: String) {
  DISCONNECTED("disconnected"),
  CONNECTING("connecting"),
  CONNECTED("connected"),
  PREVIEWING("previewing"),
  CAPTURING("capturing"),
  DEVICE_ERROR("device_error"),
}

internal data class StatusSnapshot(val state: CameraState, val device: DeviceInfo?, val error: BridgeError?)

/** One preview frame, already a JPEG at most [FlirOneCamera.MAX_PREVIEW_WIDTH] wide. `width` and `height` are the JPEG's. */
internal class PreviewFrame(val jpeg: ByteArray, val width: Int, val height: Int, val scaleMinC: Double?, val scaleMaxC: Double?, val at: Date)

internal sealed class CaptureResult {
  abstract val requestId: String

  /** The camera's own radiometric file as `ThermalImage.saveAs` wrote it, read back into memory; the file itself is already deleted. */
  class Ok(
    override val requestId: String,
    val bytes: ByteArray,
    val fileName: String,
    val capturedAt: Date,
    val capturedAtSource: String,
    val device: DeviceInfo,
    val stats: SdkStats?,
  ) : CaptureResult()

  class Failed(override val requestId: String, val error: BridgeError) : CaptureResult()
}

/** What [FlirOneCamera] reports. Always called on the camera's own thread; the bridge moves events to the UI thread. */
internal interface CameraEvents {
  fun onStatus(snapshot: StatusSnapshot)
  fun onFrame(frame: PreviewFrame)
  fun onCapture(result: CaptureResult)
}

/**
 * One FLIR ONE on USB, through the FLIR Atlas Android SDK: discovery, the USB permission, connection, the live thermal stream rendered
 * to small JPEGs, and capture of the camera's radiometric file.
 *
 * Threading. The javadoc says `Camera` "is not guaranteed to be thread-safe" and that `connect` and `disconnect` block, that discovery
 * and `Stream.start` callbacks come on background threads, and that `ThermalStreamer.update()` should not run on the stream's thread.
 * So every call into the SDK and every change of state happens on one thread of our own ([sdk]); the SDK's callbacks only post work to
 * it. A capture runs on that thread too, so it is serialised with rendering and with every other camera call.
 *
 * States. `connected` only after `Camera.connect` returned without throwing and `Camera.isConnected()` is true. `previewing` only while
 * frames arrive: back to `connected` after [FRAME_STALL_MS] without one. `device_error` carries the SDK's `ErrorCode` text, and every
 * connect attempt that fails (no camera within [DISCOVERY_TIMEOUT_MS], USB access refused, not a FLIR ONE, an SDK error) ends there, so
 * a page waiting for the outcome of `connect()` always hears one. `disconnected` after `disconnect()`, on
 * `ConnectionStatusListener.onDisconnected` and on `DiscoveryEventListener.onCameraLost` for a connected camera.
 *
 * Lifecycle. `stopPreview()` (the page's, or the host's `pausePreview()` in onPause) leaves the camera `connected`, and `startPreview()`
 * from `connected` starts the stream again; a stream that has stalled is stopped and started afresh. The bridge never restarts the live
 * view by itself: after a pause the page hears `connected` and offers to start it.
 *
 * Only `CommunicationInterface.USB` is scanned, and only an identity the SDK says is a FLIR ONE (`UsbPermissionHandler.isFlirOne`) is
 * connected. The SDK's EMULATOR interface is never scanned here: what it produces is not a measurement and would reach ADAXAI as a live
 * capture (see docs/THERMAL_CAMERA.md, "Testing without hardware").
 *
 * The host Activity is held only weakly ([ui]): it is needed as the UI context of the SDK's USB permission dialog, and nothing here may
 * keep it alive after the host is destroyed.
 */
internal class FlirOneCamera(activity: Activity, private val events: CameraEvents) {
  companion object {
    private const val TAG = "AdaxaiThermal"
    const val MAX_PREVIEW_WIDTH = 480
    private const val JPEG_QUALITY = 70
    /** No more than about 9 preview frames a second reach the page. */
    private const val FRAME_INTERVAL_MS = 110L
    private const val FRAME_STALL_MS = 3000L
    /** How long a started stream may take to deliver its first frame before the page is told. */
    private const val FIRST_FRAME_MS = 5000L
    /**
     * How long USB discovery may take to find a FLIR ONE. It stops when one is found; the USB permission dialog that may follow, and
     * `Camera.connect`, have no limit of the bridge's own. The web page waits longer than this (docs/THERMAL_CAMERA.md, "Timing").
     */
    const val DISCOVERY_TIMEOUT_MS = 20_000L
    private const val MAX_RENDER_FAILURES = 20

    @Volatile private var sdkReady = false
    @Volatile private var sdkInitError: String? = null

    /**
     * `ThermalSdkAndroid.init` "must be called before any other interaction with Android SDK classes". The 2.4.0 javadoc says its
     * context "*MUST* be a UI context otherwise errors can intermittently occur during scanning for / connecting to - devices", and that
     * initialisation "must be done from UI code eg Activity / Fragment / View". So the host Activity is passed, on the UI thread, from
     * the bridge's constructor. (The one-argument overload's example passes `getApplicationContext()`; the bridge follows the MUST.)
     *
     * `init` is static and the javadoc does not say what it keeps of the context, which may outlive the Activity. So every new bridge
     * (every new host Activity) calls it again with its own Activity, and the SDK is not left with only a destroyed one. The javadoc
     * documents an IllegalStateException only for re-initialising with a different log level; the same one-argument overload is used
     * every time. Not documented, and to check on the device: whether a second `init` replaces the context the SDK holds. If it does
     * not, a host relaunched in the same process leaves the first, destroyed Activity referenced by the SDK until the process ends. The
     * host is single-instance (`singleTask`, rotation handled in place), so in normal use there is one Activity per process.
     */
    fun initSdk(activity: Activity) {
      synchronized(this) {
        try {
          ThermalSdkAndroid.init(activity)
          sdkReady = true
          sdkInitError = null
        } catch (e: Throwable) {
          // A missing or mismatched native library shows up here (UnsatisfiedLinkError is an Error, hence Throwable). A refused
          // re-initialisation counts too: the SDK would be left with the context of an Activity that is gone.
          sdkReady = false
          sdkInitError = e.message ?: e.javaClass.simpleName
          Log.e(TAG, "FLIR SDK initialisation failed: ${e.javaClass.simpleName}")
        }
      }
    }

    fun sdkInfo(): SdkInfo {
      if (!sdkReady) return SdkInfo(null, null)
      val version = try { ThermalSdkAndroid.getVersion() } catch (e: RuntimeException) { null }
      val commit = try { ThermalSdkAndroid.getCommitHash() } catch (e: RuntimeException) { null }
      return SdkInfo(version, commit)
    }
  }

  /** Model, serial, firmware and article number as `CameraInformation` gave them. */
  private class ImageCameraInfo(val model: String?, val serialNumber: String?, val programVersion: String?, val articleNumber: String?)

  private class Encoded(val bytes: ByteArray, val width: Int, val height: Int)

  /** The host Activity: the UI context of the USB permission dialog. Weak, so that it is never kept alive from here. */
  private val ui = WeakReference(activity)
  /** For what the javadoc asks an application context for (`hasFlirOnePermission`), and for the cache directory. Holds no Activity. */
  private val appContext: Context = activity.applicationContext
  private val sdk = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "adaxai-thermal-sdk") }
  private val main = Handler(Looper.getMainLooper())
  private val usbPermission = UsbPermissionHandler()

  // Owned by the [sdk] thread: read and written only there.
  private var session = 0
  private var identity: Identity? = null
  private var camera: Camera? = null
  private var stream: Stream? = null
  private var streamer: ThermalStreamer? = null
  private var imageInfo: ImageCameraInfo? = null
  private var discoveryTimeout: ScheduledFuture<*>? = null
  private var watchdog: ScheduledFuture<*>? = null
  /** Which run of the stream a callback belongs to: changed on every start and stop, so a late callback of a stopped stream is ignored. */
  private var previewRun = 0
  private var streamStartedAt = 0L
  private var lastFrameAt = 0L
  private var renderFailures = 0

  // Read from other threads.
  @Volatile var status = StatusSnapshot(CameraState.DISCONNECTED, null, null)
    private set
  private val renderQueued = AtomicBoolean(false)
  private val lastRenderScheduledAt = AtomicLong(0)
  private val captureInFlight = AtomicBoolean(false)

  private fun post(block: () -> Unit) {
    try {
      sdk.execute { runGuarded(block) }
    } catch (e: RejectedExecutionException) {
      // Released: nothing more is done.
    }
  }

  /** An exception escaping a task would end it silently; it is reported as a device error instead, with the live view stopped. */
  private fun runGuarded(block: () -> Unit) {
    try {
      block()
    } catch (e: Exception) {
      Log.e(TAG, "Camera task failed: ${e.javaClass.simpleName}")
      stopStreaming()
      setStatus(CameraState.DEVICE_ERROR, deviceInfo(), errorFrom(e, "bridge_error"))
    }
  }

  private fun setStatus(state: CameraState, device: DeviceInfo?, error: BridgeError?) {
    status = StatusSnapshot(state, device, error)
    events.onStatus(status)
  }

  private fun deviceInfo(): DeviceInfo? {
    val id = identity ?: return null
    val info = imageInfo
    return DeviceInfo(info?.model, info?.serialNumber, info?.programVersion, info?.articleNumber, id.deviceId, id.communicationInterface.name)
  }

  private fun sdkError(error: ErrorCode?, fallbackCode: String, fallbackMessage: String): BridgeError {
    if (error == null || !error.isError()) return BridgeError(fallbackCode, fallbackMessage)
    val text = error.getMessage()
    return BridgeError("sdk_${error.getCode()}", if (text.isNullOrBlank()) error.toString() else text)
  }

  private fun errorFrom(e: Exception, fallbackCode: String): BridgeError =
    if (e is ErrorCodeException) sdkError(e.errorCode, fallbackCode, e.message ?: fallbackCode)
    else BridgeError(fallbackCode, e.message ?: e.javaClass.simpleName)

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------------------------------------------------------------

  /**
   * Scan USB for a FLIR ONE, ask for USB access if needed, connect. Ends in `connected` or in `device_error` with a code and a message.
   * A call while connecting or connected only repeats the status.
   */
  fun connect() = post {
    val s = status.state
    if (s != CameraState.DISCONNECTED && s != CameraState.DEVICE_ERROR) {
      events.onStatus(status)
      return@post
    }
    if (!sdkReady) {
      setStatus(CameraState.DEVICE_ERROR, null, BridgeError("sdk_unavailable", "The FLIR SDK could not be initialised: ${sdkInitError ?: "unknown reason"}."))
      return@post
    }
    // After a device error the old camera may still be held: let it go before starting again.
    releaseCamera()
    session += 1
    val mine = session
    setStatus(CameraState.CONNECTING, null, null)
    try {
      DiscoveryFactory.getInstance().scan(discoveryListener(mine), CommunicationInterface.USB)
    } catch (e: Exception) {
      setStatus(CameraState.DEVICE_ERROR, null, errorFrom(e, "discovery_failed"))
      return@post
    }
    discoveryTimeout = sdk.schedule(Runnable {
      runGuarded {
        if (session == mine && status.state == CameraState.CONNECTING && identity == null) {
          stopDiscovery()
          val seconds = DISCOVERY_TIMEOUT_MS / 1000
          setStatus(CameraState.DEVICE_ERROR, null, BridgeError("camera_not_found", "No FLIR ONE was found on USB within $seconds seconds. Check that it is plugged into the tablet's USB-C port and switched on, then connect again."))
        }
      }
    }, DISCOVERY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
  }

  private fun discoveryListener(mine: Int) = object : DiscoveryEventListener {
    override fun onCameraFound(discoveredCamera: DiscoveredCamera?) {
      val id = discoveredCamera?.getIdentity() ?: return
      post { onFound(mine, id) }
    }

    override fun onDiscoveryError(communicationInterface: CommunicationInterface?, error: ErrorCode?) {
      post {
        if (session == mine && status.state == CameraState.CONNECTING) {
          discoveryTimeout?.cancel(false)
          stopDiscovery()
          setStatus(CameraState.DEVICE_ERROR, null, sdkError(error, "discovery_error", "Discovery failed."))
        }
      }
    }

    override fun onCameraLost(identity: Identity?) {
      post { if (session == mine && identity != null && identity == this@FlirOneCamera.identity) lost(null) }
    }

    override fun onDiscoveryFinished(communicationInterface: CommunicationInterface?) {
      // The scan was ended from outside. A camera not found by then is reported by the discovery timeout.
    }
  }

  private fun onFound(mine: Int, id: Identity) {
    if (session != mine || status.state != CameraState.CONNECTING || identity != null) return
    // Only USB is scanned; anything else is ignored, never connected.
    if (id.communicationInterface != CommunicationInterface.USB) return
    // Found: the discovery limit no longer applies. What follows (the permission dialog, then Camera.connect) has no limit of ours.
    discoveryTimeout?.cancel(false)
    stopDiscovery()
    if (!UsbPermissionHandler.isFlirOne(id)) {
      setStatus(CameraState.DEVICE_ERROR, null, BridgeError("unsupported_camera", "A FLIR camera was found on USB, but the SDK does not identify it as a FLIR ONE. Only the FLIR ONE is supported."))
      return
    }
    identity = id
    // The javadoc names this parameter `applicationContext`.
    if (UsbPermissionHandler.hasFlirOnePermission(id, appContext)) {
      doConnect(mine, id)
      return
    }
    // The permission dialog is UI: asked for on the UI thread with the Activity (the javadoc's `uiContext`), answered on ours.
    main.post {
      val activity = ui.get()
      if (activity == null || activity.isFinishing || activity.isDestroyed) {
        post { if (session == mine) connectFailed(BridgeError("usb_permission_error", "USB access could not be asked for: the app's screen was closed. Open it and connect again.")) }
      } else {
        try {
          usbPermission.requestFlirOnePermisson(id, activity, permissionListener(mine))
        } catch (e: Exception) {
          post { if (session == mine) connectFailed(errorFrom(e, "usb_permission_error")) }
        }
      }
    }
  }

  private fun permissionListener(mine: Int) = object : UsbPermissionHandler.UsbPermissionListener {
    override fun permissionGranted(identity: Identity) {
      post { if (session == mine) doConnect(mine, identity) }
    }

    override fun permissionDenied(identity: Identity) {
      post { if (session == mine) connectFailed(BridgeError("usb_permission_denied", "Access to the FLIR ONE over USB was refused on this tablet. Connect again and allow access when Android asks.")) }
    }

    // The javadoc: "The Identity was not a recognized as a FLIR ONE".
    override fun error(errorType: UsbPermissionHandler.UsbPermissionListener.ErrorType?, identity: Identity?) {
      post { if (session == mine) connectFailed(BridgeError("usb_permission_error", "The SDK did not ask for USB access: it did not recognise the camera as a FLIR ONE (${errorType?.toString() ?: "unknown"}).")) }
    }
  }

  /** A connect attempt that will not succeed: `device_error`, so that a page waiting for the outcome stops waiting. */
  private fun connectFailed(error: BridgeError) {
    if (status.state != CameraState.CONNECTING) return
    identity = null
    setStatus(CameraState.DEVICE_ERROR, null, error)
  }

  private fun doConnect(mine: Int, id: Identity) {
    if (session != mine || status.state != CameraState.CONNECTING) return
    val cam = Camera()
    try {
      // Blocking, as the javadoc says; this is the camera's own thread, never the UI thread.
      cam.connect(id, ConnectionStatusListener { error -> post { onDisconnected(cam, error) } }, null)
    } catch (e: Exception) {
      closeQuietly(cam)
      connectFailed(errorFrom(e, "connect_failed"))
      return
    }
    if (!cam.isConnected()) {
      closeQuietly(cam)
      connectFailed(BridgeError("connect_failed", "The SDK returned from connect, but the camera is not connected."))
      return
    }
    camera = cam
    identity = id
    imageInfo = null
    setStatus(CameraState.CONNECTED, deviceInfo(), null)
  }

  private fun onDisconnected(cam: Camera, error: ErrorCode?) {
    if (camera !== cam) return // a camera this bridge already let go of
    lost(error)
  }

  private fun lost(error: ErrorCode?) {
    val wasConnecting = status.state == CameraState.CONNECTING
    session += 1
    releaseCamera()
    val e = if (error != null && error.isError()) sdkError(error, "disconnected", "The camera disconnected.") else null
    // Lost before it was connected: that connect attempt failed, and a page waiting for it must hear so.
    if (wasConnecting) setStatus(CameraState.DEVICE_ERROR, null, e ?: BridgeError("camera_lost", "The FLIR ONE went away while it was being connected."))
    else setStatus(CameraState.DISCONNECTED, null, e)
  }

  /** Stop everything: discovery, preview, connection. The camera's own disconnect callback is then ignored. */
  fun disconnect() = post {
    session += 1
    releaseCamera()
    setStatus(CameraState.DISCONNECTED, null, null)
  }

  private fun stopDiscovery() {
    if (!sdkReady) return // DiscoveryFactory is an SDK class: nothing of the SDK is touched before init succeeded
    try {
      DiscoveryFactory.getInstance().stop(CommunicationInterface.USB)
    } catch (e: Exception) {
      Log.w(TAG, "Stopping discovery failed: ${e.javaClass.simpleName}")
    }
  }

  private fun releaseCamera() {
    discoveryTimeout?.cancel(false)
    discoveryTimeout = null
    stopDiscovery()
    stopStreaming()
    val cam = camera
    camera = null
    identity = null
    imageInfo = null
    if (cam != null) {
      try {
        if (cam.isConnected()) cam.disconnect()
      } catch (e: Exception) {
        Log.w(TAG, "Disconnect failed: ${e.javaClass.simpleName}")
      }
      closeQuietly(cam)
    }
  }

  private fun closeQuietly(cam: Camera) {
    try {
      cam.close()
    } catch (e: Exception) {
      Log.w(TAG, "Closing the camera failed: ${e.javaClass.simpleName}")
    }
  }

  /**
   * Send the current state again as a `status` event (the host calls it in onResume). Queued behind any pending camera work, so it
   * reports the state after it: `connected` after a pause that stopped the live view, `disconnected` if the camera went away meanwhile.
   */
  fun reportStatus() = post { events.onStatus(status) }

  /** Called by the host when it is destroyed. Nothing is reported after this. */
  fun release() {
    post {
      session += 1
      releaseCamera()
    }
    sdk.shutdown()
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Live preview
  // ---------------------------------------------------------------------------------------------------------------------------------

  /**
   * Start the thermal stream. The state becomes `previewing` with the first rendered frame, not before. Works from `connected` however
   * the camera got there: just connected, after `stopPreview()` (the page's, or the host's pause), or after the stream stalled; a
   * stream that has delivered no frame for [FRAME_STALL_MS] is stopped and started afresh. A stream that is live, or started less than
   * [FRAME_STALL_MS] ago, is left alone and the call only repeats the status.
   */
  fun startPreview() = post {
    val cam = camera
    val state = status.state
    if (cam == null || (state != CameraState.CONNECTED && state != CameraState.PREVIEWING)) {
      events.onStatus(status)
      return@post
    }
    if (streamer != null) {
      val quietFor = SystemClock.elapsedRealtime() - maxOf(lastFrameAt, streamStartedAt)
      if (state == CameraState.PREVIEWING || quietFor <= FRAME_STALL_MS) {
        events.onStatus(status)
        return@post
      }
      stopStreaming()
    }
    val thermal = cam.getStreams().firstOrNull { it.isThermal() }
    if (thermal == null) {
      setStatus(CameraState.DEVICE_ERROR, deviceInfo(), BridgeError("no_thermal_stream", "The camera offers no thermal stream."))
      return@post
    }
    val ts = ThermalStreamer(thermal)
    // The scale range of a frame is read only with auto scale on (getScaleRangeMin/Max throw otherwise).
    ts.setAutoScale(true)
    stream = thermal
    streamer = ts
    previewRun += 1
    val run = previewRun
    streamStartedAt = SystemClock.elapsedRealtime()
    lastFrameAt = 0L
    renderFailures = 0
    try {
      thermal.start(OnReceived<Void> { onStreamFrame(run) }, OnRemoteError { error -> post { onStreamError(run, error) } })
    } catch (e: Exception) {
      stopStreaming()
      setStatus(CameraState.DEVICE_ERROR, deviceInfo(), errorFrom(e, "stream_start_failed"))
      return@post
    }
    // A stall reported earlier (frames_stopped, no_frames) no longer holds: the page hears `connected` without it.
    if (status.error != null) setStatus(CameraState.CONNECTED, deviceInfo(), null)
    watchdog = sdk.scheduleWithFixedDelay(Runnable { runGuarded { checkFrames(run) } }, 1000L, 1000L, TimeUnit.MILLISECONDS)
  }

  /** Stop the thermal stream; the camera stays `connected`, and `startPreview()` starts it again. */
  fun stopPreview() = post {
    if (streamer == null) {
      events.onStatus(status)
      return@post
    }
    stopStreaming()
    if (status.state == CameraState.PREVIEWING || status.state == CameraState.CONNECTED) setStatus(CameraState.CONNECTED, deviceInfo(), null)
  }

  private fun stopStreaming() {
    previewRun += 1
    watchdog?.cancel(false)
    watchdog = null
    val s = stream
    val ts = streamer
    stream = null
    streamer = null
    try {
      if (s != null && s.isStreaming()) s.stop()
    } catch (e: Exception) {
      Log.w(TAG, "Stopping the stream failed: ${e.javaClass.simpleName}")
    }
    try {
      ts?.close()
    } catch (e: Exception) {
      Log.w(TAG, "Closing the streamer failed: ${e.javaClass.simpleName}")
    }
  }

  /** On the SDK's streaming thread: only decide whether to render, and hand the work to our thread. */
  private fun onStreamFrame(run: Int) {
    val now = SystemClock.elapsedRealtime()
    if (now - lastRenderScheduledAt.get() < FRAME_INTERVAL_MS) return
    if (!renderQueued.compareAndSet(false, true)) return
    lastRenderScheduledAt.set(now)
    post {
      renderQueued.set(false)
      renderFrame(run)
    }
  }

  private fun onStreamError(run: Int, error: ErrorCode?) {
    if (run != previewRun || streamer == null) return
    if (error != null && ThermalStreamer.isTemporaryStreamError(error)) return
    stopStreaming()
    setStatus(CameraState.DEVICE_ERROR, deviceInfo(), sdkError(error, "stream_error", "The thermal stream failed."))
  }

  /** Once a second while streaming. The state stays `connected` either way, with an error saying why there is no picture. */
  private fun checkFrames(run: Int) {
    if (run != previewRun || streamer == null) return
    val now = SystemClock.elapsedRealtime()
    if (status.state == CameraState.PREVIEWING && now - lastFrameAt > FRAME_STALL_MS) {
      setStatus(CameraState.CONNECTED, deviceInfo(), BridgeError("frames_stopped", "No frame has arrived from the camera for ${FRAME_STALL_MS / 1000} seconds. Start the live view again."))
    } else if (status.state == CameraState.CONNECTED && lastFrameAt == 0L && status.error == null && now - streamStartedAt > FIRST_FRAME_MS) {
      setStatus(CameraState.CONNECTED, deviceInfo(), BridgeError("no_frames", "The live view was started, but no frame has arrived from the camera within ${FIRST_FRAME_MS / 1000} seconds. Start the live view again."))
    }
  }

  private fun renderFailed(e: Exception) {
    renderFailures += 1
    Log.w(TAG, "Frame not rendered: ${e.javaClass.simpleName}")
    if (renderFailures >= MAX_RENDER_FAILURES) {
      stopStreaming()
      setStatus(CameraState.DEVICE_ERROR, deviceInfo(), errorFrom(e, "render_failed"))
    }
  }

  private fun renderFrame(run: Int) {
    val ts = streamer ?: return
    // A frame of a stopped run, or one arriving in any state but these two, is not shown.
    if (run != previewRun || (status.state != CameraState.CONNECTED && status.state != CameraState.PREVIEWING)) return
    try {
      ts.update()
    } catch (e: ErrorCodeException) {
      // The javadoc: a temporary stream error means a corrupted frame; skip it and wait for the next.
      if (!ThermalStreamer.isTemporaryStreamError(e.errorCode)) renderFailed(e)
      return
    } catch (e: RuntimeException) {
      renderFailed(e)
      return
    }
    val learned = imageInfo == null && readImageInfo(ts)
    val buffer = ts.getImage() ?: return
    val jpeg = try {
      encode(buffer)
    } catch (e: RuntimeException) {
      renderFailed(e)
      return
    }
    renderFailures = 0
    lastFrameAt = SystemClock.elapsedRealtime()
    val minC = try { ts.getScaleRangeMin()?.asCelsius()?.value } catch (e: RuntimeException) { null }
    val maxC = try { ts.getScaleRangeMax()?.asCelsius()?.value } catch (e: RuntimeException) { null }
    if (status.state == CameraState.CONNECTED) setStatus(CameraState.PREVIEWING, deviceInfo(), null)
    else if (learned) setStatus(status.state, deviceInfo(), status.error)
    events.onFrame(PreviewFrame(jpeg.bytes, jpeg.width, jpeg.height, minC, maxC, Date()))
  }

  /** Model, serial, firmware and article number from the streamed image's `CameraInformation`. True when they were read. */
  private fun readImageInfo(ts: ThermalStreamer): Boolean {
    var info: CameraInformation? = null
    try {
      ts.withThermalImage { image -> info = image.getCameraInformation() }
    } catch (e: RuntimeException) {
      return false
    }
    val i = info ?: return false
    imageInfo = ImageCameraInfo(i.model, i.serialNumber, i.programVersion, i.articleNumber)
    return true
  }

  /** The rendered (colourised) frame as a JPEG no wider than [MAX_PREVIEW_WIDTH]. A picture for the screen: it holds no temperatures. */
  private fun encode(buffer: ImageBuffer): Encoded {
    val bmp = BitmapAndroid.createBitmap(buffer)
    try {
      val src = bmp.getBitMap()
      val scaled = if (src.width > MAX_PREVIEW_WIDTH) Bitmap.createScaledBitmap(src, MAX_PREVIEW_WIDTH, maxOf(1, src.height * MAX_PREVIEW_WIDTH / src.width), true) else src
      try {
        val out = ByteArrayOutputStream()
        if (!scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) throw IllegalStateException("JPEG encoding failed")
        return Encoded(out.toByteArray(), scaled.width, scaled.height)
      } finally {
        if (scaled !== src) scaled.recycle()
      }
    } finally {
      // getImage() returned a deep copy; this frees it.
      bmp.recycle()
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------------------------------------------------------------------

  /**
   * Save the current thermal image with the SDK (`ThermalImage.saveAs`: the camera's radiometric JPEG), read it into memory, delete the
   * file, report it. One capture at a time: a second request while one is in progress is refused, not queued.
   */
  fun capture(requestId: String) {
    if (!captureInFlight.compareAndSet(false, true)) {
      events.onCapture(CaptureResult.Failed(requestId, BridgeError("capture_in_progress", "A capture is already in progress.")))
      return
    }
    try {
      sdk.execute {
        try {
          runGuarded { doCapture(requestId) }
        } finally {
          captureInFlight.set(false)
        }
      }
    } catch (e: RejectedExecutionException) {
      captureInFlight.set(false)
    }
  }

  private fun doCapture(requestId: String) {
    val ts = streamer
    if (ts == null || status.state != CameraState.PREVIEWING) {
      events.onCapture(CaptureResult.Failed(requestId, BridgeError("not_previewing", "Start the live view and wait for the image before capturing.")))
      return
    }
    setStatus(CameraState.CAPTURING, deviceInfo(), null)
    val file = File(appContext.cacheDir, "${UUID.randomUUID()}.jpg")
    try {
      try {
        ts.update()
      } catch (e: ErrorCodeException) {
        // A corrupted newest frame leaves the last good one in the streamer; anything else fails the capture.
        if (!ThermalStreamer.isTemporaryStreamError(e.errorCode)) throw e
      }
      var seen = false
      var taken: Date? = null
      var stats: SdkStats? = null
      var info: CameraInformation? = null
      var failure: Exception? = null
      ts.withThermalImage { image ->
        seen = true
        try {
          info = image.getCameraInformation()
          taken = image.getDateTaken()
          val s = image.getStatistics()
          if (s != null) stats = SdkStats(s.min?.asCelsius()?.value, s.max?.asCelsius()?.value, s.average?.asCelsius()?.value, s.standardDeviation?.asCelsius()?.value)
          image.saveAs(file.absolutePath)
        } catch (e: Exception) {
          failure = e
        }
      }
      failure?.let { throw it }
      if (!seen) throw IllegalStateException("The SDK had no thermal image to save.")
      val bytes = file.readBytes()
      if (bytes.isEmpty()) throw IllegalStateException("The SDK wrote an empty file.")
      val i = info
      if (i != null) imageInfo = ImageCameraInfo(i.model, i.serialNumber, i.programVersion, i.articleNumber)
      val device = deviceInfo() ?: throw IllegalStateException("The camera is no longer connected.")
      // `getDateTaken()` is "null if date can't be retrieved". Then the tablet's clock is sent, marked `tablet`, never passed off as the
      // camera's: the page must not record it as the time the camera took the image (docs/THERMAL_CAMERA.md, "Events").
      val at = taken
      events.onCapture(CaptureResult.Ok(requestId, bytes, file.name, at ?: Date(), if (at != null) "camera" else "tablet", device, stats))
    } catch (e: Exception) {
      events.onCapture(CaptureResult.Failed(requestId, errorFrom(e, "capture_failed")))
    } finally {
      if (file.exists() && !file.delete()) Log.w(TAG, "The temporary capture file could not be deleted")
      if (status.state == CameraState.CAPTURING) {
        val live = streamer != null && SystemClock.elapsedRealtime() - lastFrameAt <= FRAME_STALL_MS
        setStatus(if (live) CameraState.PREVIEWING else CameraState.CONNECTED, deviceInfo(), null)
      }
    }
  }
}
