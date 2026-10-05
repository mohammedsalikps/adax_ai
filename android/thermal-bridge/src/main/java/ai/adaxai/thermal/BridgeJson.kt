// NOT COMPILED, NOT RUN on hardware. Written against the FLIR Atlas Android SDK 2.4.0 javadoc without an Android SDK, a JDK, the FLIR
// SDK, a tablet or a FLIR ONE. Nothing in this file has been tested. See android/README.md and docs/THERMAL_CAMERA.md.
package ai.adaxai.thermal

import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** What the SDK says about itself (`ThermalSdkAndroid.getVersion()` and `getCommitHash()`); null when it could not be read. */
internal data class SdkInfo(val version: String?, val commitHash: String?)

/**
 * DeviceInfo of bridge contract v1. Every field is what the SDK reported, or null: model, serial number, firmware ("program version") and
 * article number from the `CameraInformation` of a streamed or captured `ThermalImage`; device id and interface from the `Identity` the
 * camera was discovered with. `Identity.deviceId` is "a per session unique Id" in the javadoc: it identifies the camera for this
 * connection, not the hardware. The serial number is what identifies the hardware.
 */
internal data class DeviceInfo(
  val model: String?,
  val serialNumber: String?,
  val programVersion: String?,
  val articleNumber: String?,
  val deviceId: String?,
  val iface: String?,
)

/** An error as the page sees it: a short code and a sentence. SDK errors carry the SDK's own `ErrorCode` text. */
internal data class BridgeError(val code: String, val message: String)

/** The SDK's statistics of a captured image, in °C. Shown for comparison only; ADAXAI computes its own from the file. */
internal data class SdkStats(val minC: Double?, val maxC: Double?, val meanC: Double?, val stdC: Double?)

/** Bridge contract v1: every JSON the page receives is built here, so the shapes live in one place. */
internal object BridgeJson {
  const val BRIDGE_NAME = "adaxai-thermal-android"
  const val BRIDGE_VERSION = "1"
  const val SDK_NAME = "FLIR Atlas Android SDK"
  const val EVENT_NAME = "adaxai-thermal"

  // org.json drops a key whose value is Kotlin null, and refuses NaN and infinities: the contract wants an explicit null instead.
  private fun orNull(v: Any?): Any = v ?: JSONObject.NULL
  private fun num(v: Double?): Any = if (v == null || v.isNaN() || v.isInfinite()) JSONObject.NULL else v

  /** ISO 8601 in UTC with milliseconds. SimpleDateFormat is not thread-safe, so one is made per call. */
  fun iso(date: Date): String {
    val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    f.timeZone = TimeZone.getTimeZone("UTC")
    return f.format(date)
  }

  private fun sdk(sdk: SdkInfo): JSONObject = JSONObject().put("name", SDK_NAME).put("version", orNull(sdk.version)).put("commitHash", orNull(sdk.commitHash))

  private fun error(e: BridgeError?): Any = if (e == null) JSONObject.NULL else JSONObject().put("code", e.code).put("message", e.message)

  fun bridgeInfo(sdk: SdkInfo): JSONObject = JSONObject().put("bridge", BRIDGE_NAME).put("version", BRIDGE_VERSION).put("sdk", sdk(sdk))

  fun capabilities(): JSONObject = JSONObject().put("radiometric", true).put("livePreview", true).put("capture", true)

  /** DeviceInfo, or JSON null (its `toString()` is "null", which `JSON.parse` reads as null). */
  fun deviceInfo(d: DeviceInfo?): Any =
    if (d == null) JSONObject.NULL
    else JSONObject()
      .put("model", orNull(d.model))
      .put("serialNumber", orNull(d.serialNumber))
      .put("programVersion", orNull(d.programVersion))
      .put("articleNumber", orNull(d.articleNumber))
      .put("deviceId", orNull(d.deviceId))
      .put("interface", orNull(d.iface))

  /** getStatus(), or the `status` event when [event] is true (the same fields with `"type":"status"`). */
  fun status(s: StatusSnapshot, event: Boolean): JSONObject {
    val o = JSONObject()
    if (event) o.put("type", "status")
    return o.put("state", s.state.wire).put("device", deviceInfo(s.device)).put("error", error(s.error))
  }

  fun frame(jpegBase64: String, width: Int, height: Int, scaleMinC: Double?, scaleMaxC: Double?, at: Date): JSONObject =
    JSONObject()
      .put("type", "frame")
      .put("jpegBase64", jpegBase64)
      .put("width", width)
      .put("height", height)
      .put("scaleMinC", num(scaleMinC))
      .put("scaleMaxC", num(scaleMaxC))
      .put("at", iso(at))

  /**
   * A successful capture. `device` is DeviceInfo with `sdk` and `bridge` added: the shape of `ThermalDeviceReported` in
   * packages/contracts/src/thermal.ts. `capturedAtSource` is an addition to contract v1 and says where `capturedAt` came from: `camera`
   * when the image carried a date (`ThermalImage.getDateTaken()`), `tablet` when it did not and the tablet's clock at the capture was
   * used. Only a `camera` time is the camera's capture time; a page must not record a `tablet` time as one.
   */
  fun captureOk(
    requestId: String,
    fileBase64: String,
    fileName: String,
    capturedAt: Date,
    capturedAtSource: String,
    device: DeviceInfo,
    sdk: SdkInfo,
    stats: SdkStats?,
  ): JSONObject {
    val dev = deviceInfo(device) as JSONObject
    dev.put("sdk", sdk(sdk)).put("bridge", JSONObject().put("name", BRIDGE_NAME).put("version", BRIDGE_VERSION))
    val st = if (stats == null) JSONObject.NULL else JSONObject().put("minC", num(stats.minC)).put("maxC", num(stats.maxC)).put("meanC", num(stats.meanC)).put("stdC", num(stats.stdC))
    return JSONObject()
      .put("type", "capture")
      .put("requestId", requestId)
      .put("ok", true)
      .put("fileBase64", fileBase64)
      .put("fileName", fileName)
      .put("capturedAt", iso(capturedAt))
      .put("capturedAtSource", capturedAtSource)
      .put("device", dev)
      .put("sdkStats", st)
  }

  fun captureFailed(requestId: String, e: BridgeError): JSONObject =
    JSONObject().put("type", "capture").put("requestId", requestId).put("ok", false).put("error", error(e))

  /** What a call from a page outside the configured origin gets back from a method that returns a value. */
  fun refused(): JSONObject = JSONObject().put("error", error(BridgeError("origin_not_allowed", "This page is not allowed to use the thermal camera bridge.")))

  /**
   * The script that hands one event to the page: a `CustomEvent` named `adaxai-thermal` on `window`, with the JSON as `detail`. JSON is
   * a JavaScript expression except for U+2028 and U+2029 inside strings in older engines, so those two are escaped.
   */
  fun eventScript(json: JSONObject): String {
    val safe = json.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return "window.dispatchEvent(new CustomEvent('$EVENT_NAME',{detail:$safe}))"
  }
}
