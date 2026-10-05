# Thermal camera: FLIR ONE on an Android tablet (V6)

**Status: the native bridge in `android/` is not compiled, not run, and has never talked to a
camera.** It is written against the official javadoc of the FLIR Atlas Android SDK 2.4.0 and
describes how a FLIR ONE plugged into a tablet would reach ADAXAI. Until the verification steps
at the end have been done on hardware, ADAXAI has **no working FLIR integration**: thermal images
reach it as uploaded radiometric files (since V1 of thermal), or as generated numbers from the
simulator, marked SIMULATED. See [Status](#status).

## Hardware targeted

| Item | Targeted | Notes |
| --- | --- | --- |
| Camera | **FLIR ONE Gen 3 for Android (USB-C)** and **FLIR ONE Pro for Android (USB-C)** | Plugs into the device's USB-C port. FLIR's figures: Gen 3 80 × 60 thermal pixels, Pro 160 × 120; both 8.7 Hz; accuracy "±3°C or ±5%, typical"; object range −20 to 120 °C (Pro also 0 to 400 °C); battery about 1 h. FLIR ONE models made for iOS are not targeted |
| Not targeted | **FLIR ONE Edge / Edge Pro** | Wireless: Bluetooth to set up, then Wi-Fi from the camera. The SDK has `CommunicationInterface.FLIR_ONE_WIRELESS` for it; the bridge scans `USB` only |
| Not targeted | Other FLIR cameras on USB | The device filter matches FLIR's USB vendor id (all FLIR devices), but the bridge connects only to an identity the SDK reports as a FLIR ONE (`UsbPermissionHandler.isFlirOne`) and refuses the rest (`unsupported_camera`) |
| Tablet | An Android tablet with a USB-C port that works as **USB host (OTG)** | Not chosen and not tested. See below |

The camera's accuracy is FLIR's specification, not something ADAXAI measured. A ±3 °C absolute
error is large next to the differences doctors look at; the product shows temperatures as
measurements with their capture conditions and never as findings.

### Tablet requirements (none verified)

- **USB host on the USB-C port.** The app declares `android.hardware.usb.host` as required, so
  stores and installers refuse tablets without it. Some tablets offer OTG only on one port or
  only after a setting is turned on: check the tablet's own documentation.
- **Fit.** The FLIR ONE is made to plug straight into a phone. On a tablet, check that its
  connector reaches the port with the tablet's case on. A USB-C extension or adapter between the
  two is untested and may not work.
- **Power.** The FLIR ONE runs on its own battery (about one hour, FLIR's figure) and is charged
  separately. The bridge does not report its battery level; a flat camera appears as a
  disconnection or as not found.
- **USB permission.** Android asks the user before an app may use a USB device: either when the
  camera is plugged in ("Open ADAXAI when this device is connected?", from the host's
  `USB_DEVICE_ATTACHED` filter; accepting grants access until the camera is unplugged) or, when
  the app is already open, through the SDK's `UsbPermissionHandler.requestFlirOnePermisson`
  dialog. Refusing ends the connect attempt in `device_error` with `usb_permission_denied`.
- **Android version.** **No Android version has been tested.** The bridge's build file says
  `minSdk = 26` (Android 8.0) as a placeholder; the real minimum is the higher of that and the
  FLIR SDK's own `minSdkVersion`, read from its AAR when it is downloaded.

## Integration method

```
FLIR ONE ──USB-C──▶ FLIR Atlas Android SDK ──▶ FlirOneCamera (android/thermal-bridge)
                                                  │ one thread for every SDK call
                                                  ▼
                                    AdaxaiThermalBridge  (@JavascriptInterface "AdaxaiThermalNative")
                                                  │ origin check on every call; events on the UI thread
                                                  ▼
                       WebView in the host app ── ADAXAI web app (thermal workspace) ──HTTPS──▶ ADAXAI API
```

- A **host app**: one Activity with a WebView that shows the ADAXAI web app
  (`android/host-example/MainActivity.kt`). Staff log in and work in the web app as on any
  device; nothing clinical is in the native code.
- A **bridge**: `AdaxaiThermalBridge`, registered with
  `webView.addJavascriptInterface(bridge, "AdaxaiThermalNative")`. The web app finds
  `window.AdaxaiThermalNative` and uses it; in a normal browser it is absent, and live capture is
  not available there.
- The **FLIR Atlas Android SDK**, written against the **2.4.0** javadoc. The version actually
  downloaded must be checked against that javadoc, name by name: `android/README.md` lists every
  SDK name the bridge uses and the page it was checked on.

### Obtaining the SDK

- FLIR's Android SDK is free but not public: "sign up for a free developer account and accept
  the online license agreement" (FLIR developer blog). The download is on FLIR's developer site
  (flir.com/developer/mobile-sdk, "Create Your Developer Account", "Download SDK").
- **Apps for the FLIR ONE must be reviewed and approved by FLIR before release** ("all iOS and
  Android apps for FLIR ONE and FLIR ONE Pro need to be reviewed and approved prior to release",
  FLIR developer blog). ADAXAI's host app has not been submitted.
- The SDK's files must not be committed to this repository (FLIR's licence); `android/README.md`
  says where they go and what to git-ignore.

### Permissions

| Permission or declaration | Where | Why |
| --- | --- | --- |
| `<uses-feature android:name="android.hardware.usb.host" android:required="true"/>` | bridge library manifest | The FLIR ONE is a USB device; the tablet is the host |
| `USB_DEVICE_ATTACHED` intent filter with `@xml/flir_usb_device_filter` | host Activity | Offers to open the app when a FLIR device is plugged in, and grants USB access if accepted |
| Device filter: `vendor-id="2507"` (0x09CB, FLIR Systems) | bridge resources | No product id: the FLIR ONE product ids are to be copied from the SDK's sample app, not guessed |
| `android.permission.INTERNET` | host app | The WebView loads ADAXAI. The bridge makes no network call |
| `android.permission.CAMERA` | **not declared** | The bridge does not use the tablet's cameras. **Unverified** whether the FLIR ONE needs it: Android grants access to a USB device of class "video" only to apps that also hold `CAMERA` when they target API 28 or higher. Check the SDK sample's manifest and test on the tablet |

## Bridge contract v1

The web app implements against exactly this. All JSON; temperatures in °C (`asCelsius()`).

### Methods (`window.AdaxaiThermalNative`)

| Method | Returns |
| --- | --- |
| `bridgeInfo()` | `{"bridge":"adaxai-thermal-android","version":"1","sdk":{"name":"FLIR Atlas Android SDK","version":<ThermalSdkAndroid.getVersion()>,"commitHash":<getCommitHash()>}}` |
| `getStatus()` | `{"state":"disconnected"\|"connecting"\|"connected"\|"previewing"\|"capturing"\|"device_error","device":DeviceInfo\|null,"error":{"code","message"}\|null}` |
| `getCapabilities()` | `{"radiometric":true,"livePreview":true,"capture":true}` |
| `getDeviceInfo()` | `DeviceInfo` or `null` |
| `connect()`, `disconnect()`, `startPreview()`, `stopPreview()` | nothing; the result arrives as `status` events |
| `capture(requestId)` | nothing; the result arrives as a `capture` event with the same `requestId` (1 to 100 characters) |

`DeviceInfo` = `{"model","serialNumber","programVersion","articleNumber","deviceId","interface"}`,
each a string or null. Model, serial number, firmware (`programVersion`) and article number come
from the `CameraInformation` of the first streamed `ThermalImage` (so they are null between
`connected` and the first frame); `deviceId` and `interface` (`"USB"`) from the SDK's `Identity`.
`Identity.deviceId` is "a per session unique Id" in the javadoc: it is not a hardware identifier.
The **serial number** is what ADAXAI matches against its device registry.

Every method first checks the page's origin; from another origin, the methods that return a value
return `{"error":{"code":"origin_not_allowed","message":…}}` and the others do nothing.

### Events

`window.dispatchEvent(new CustomEvent('adaxai-thermal', {detail: …}))`, always on the UI thread:

| `type` | Fields |
| --- | --- |
| `status` | as `getStatus()`; sent on every change of state, device or error, repeated when a call changes nothing (e.g. `startPreview()` while previewing), and sent again when the host app resumes |
| `frame` | `jpegBase64`, `width`, `height` (of the JPEG), `scaleMinC`, `scaleMaxC` (the SDK's auto-scale range of that frame, or null), `at` (ISO, tablet clock). At most about 9 a second (the FLIR ONE delivers 8.7); rendered with `ThermalStreamer.update()` → `getImage()` → `BitmapAndroid` → JPEG quality 70, at most 480 px wide. A colour picture for the screen: **it holds no temperatures and is never uploaded** |
| `capture` (success) | `requestId`, `ok: true`, `fileBase64`, `fileName`, `capturedAt` (ISO), `capturedAtSource` (`"camera"` or `"tablet"`, see below), `device` (DeviceInfo plus `sdk: {name, version, commitHash}` and `bridge: {name: "adaxai-thermal-android", version: "1"}`: the shape of `ThermalDeviceReported`), `sdkStats: {minC, maxC, meanC, stdC}` (the SDK's statistics of that image, or null) |
| `capture` (failure) | `requestId`, `ok: false`, `error: {code, message}` |

A capture: `ThermalStreamer.withThermalImage { image -> image.saveAs(cacheDir/<uuid>.jpg) }`
(the SDK writes the camera's radiometric JPEG), the file is read into memory, sent as base64 and
deleted. Only one capture at a time: a second request while one is running gets
`capture_in_progress`.

**`capturedAt` and `capturedAtSource`** (an addition to v1; the bridge always sends both):

| `capturedAtSource` | `capturedAt` is |
| --- | --- |
| `"camera"` | `ThermalImage.getDateTaken()`: the date the SDK read from the image, i.e. the camera's own capture time |
| `"tablet"` | the tablet's clock at the moment of the capture, because `getDateTaken()` returned null ("null if date can't be retrieved", javadoc) |

Only a `camera` time is the camera's capture time. A page must not record or show a `tablet`
time as one: ADAXAI stores `capturedAt` as "when the camera says it took the image", so a page
that sends it without looking at `capturedAtSource` would make a claim the camera did not make.
The ADAXAI page sends `capturedAt` to the server only when `capturedAtSource` is `camera` (a
missing or unknown value counts as `tablet`); otherwise the record has no camera time and shows
when ADAXAI received the image.

### States

| State | When |
| --- | --- |
| `disconnected` | At start; after `disconnect()`; on `ConnectionStatusListener.onDisconnected` (with the SDK's error, if it gave one); on `DiscoveryEventListener.onCameraLost` for a connected camera |
| `connecting` | After `connect()`: USB discovery running, the USB permission dialog open, or `Camera.connect` in progress |
| `connected` | Only after `Camera.connect` returned without throwing **and** `Camera.isConnected()` is true. Also after `stopPreview()` (the page's, or the host's when the app is paused); when no frame has arrived for 3 s during the preview (`frames_stopped`); and when a started preview has delivered no frame within 5 s (`no_frames`). `startPreview()` starts the live view from here in every case |
| `previewing` | From the first rendered frame after `startPreview()`, and only while frames keep arriving |
| `capturing` | From `capture(requestId)` until its `capture` event |
| `device_error` | **Every failed connect attempt**: no FLIR ONE found on USB within 20 s (`camera_not_found`), USB access refused (`usb_permission_denied`), the SDK's permission request failed or did not recognise the camera (`usb_permission_error`), the camera found is not a FLIR ONE (`unsupported_camera`), the camera went away while connecting (`camera_lost`), discovery error, `connect` threw or left the camera unconnected (`connect_failed`), SDK not initialised (`sdk_unavailable`). And errors after connecting: no thermal stream (`no_thermal_stream`), a stream error that `ThermalStreamer.isTemporaryStreamError` does not call temporary, 20 frames in a row that could not be rendered (`render_failed`); the live view is stopped. When the SDK gave an `ErrorCode`, `code` is `sdk_<number>` and `message` is the SDK's message. `connect()` starts again from here |

A page waiting for the outcome of `connect()` can therefore stop at the first `connected` or
`device_error`; it never has to guess from a timer while the bridge still knows more.

### Timing

- **Discovery:** up to **20 s** (`DISCOVERY_TIMEOUT_MS` in `FlirOneCamera.kt`), then
  `device_error` / `camera_not_found`. The limit stops as soon as a FLIR ONE is found.
- **USB permission:** if the app does not yet have access, Android's dialog is shown next. The
  bridge waits for the answer **with no time limit of its own**, then runs `Camera.connect`
  (blocking, as the javadoc says). So a connect takes up to 20 s plus however long the user
  takes on the dialog plus the connection itself.
- **The web page waits up to 45 s** (`CONNECT_TIMEOUT_MS` in `apps/web/src/lib/thermalCamera.ts`)
  for `connected` or a failure. That is longer than discovery, so when no camera is there the
  page shows the bridge's own `camera_not_found` message rather than a guess of its own, and a
  slow answer to the dialog still has time.
- If the dialog is still open when the page stops waiting, the bridge stays `connecting` until
  the user answers. The outcome arrives later as a `status` event: `connected` (the page shows it
  and offers to start the live view) or `device_error`. `disconnect()` cancels the attempt; an
  answer to the dialog after that is ignored.

### Lifecycle

The bridge never restarts the live view by itself; it tells the page the truth, and the page
offers **Start live view**, which calls `startPreview()`.

| What happens | Bridge | The page hears |
| --- | --- | --- |
| The host Activity is paused (another app, the screen locked, the file chooser of "Import from the tablet"; perhaps the USB permission dialog) | the host calls `pausePreview()`: the stream stops, the camera stays connected | `status` `connected` |
| The host Activity is resumed | the host calls `reportStatus()`: the current state is sent again, after any camera work still queued | `status` `connected`, or `disconnected` if the camera was unplugged meanwhile |
| The thermal workspace is closed and opened again | the page's `stopPreview()` leaves the camera connected | the new page reads `connected` from `getStatus()` |
| The preview stalls: no frame for 3 s while previewing, or none within 5 s of a start | the stream is left running; a frame that comes back returns the state to `previewing` | `status` `connected` with `frames_stopped` or `no_frames` |
| `startPreview()` from `connected` | starts the stream; a stream that has delivered no frame for 3 s is stopped and started afresh; a live one, or one started less than 3 s ago, is left alone | `previewing` from the first frame |
| The host Activity is destroyed | the host calls `release()`: the camera is disconnected and nothing more is sent | nothing |

The host Activity is the FLIR SDK's UI context: the javadoc of `ThermalSdkAndroid.init` says the
context "\*MUST\* be a UI context otherwise errors can intermittently occur during scanning for /
connecting to - devices", and `requestFlirOnePermisson` takes a `uiContext` for its dialog. Every
new bridge passes its own Activity to `init`; the bridge holds the Activity only through a weak
reference, and the host is single-instance. Whether the SDK lets go of an earlier Activity when
`init` is called again is not documented and is checked in step 14 below.

Threading: the javadoc says `Camera` is not thread-safe and `connect`/`disconnect` block, and that
discovery and stream callbacks arrive on background threads. Every SDK call and every change of
state runs on one thread of the bridge's own; SDK callbacks only post to it; events go to the page
on the UI thread. Capture runs on that same thread, so it is serialised with rendering and with
every other camera call.

## Security

- **Origin check on every call.** Each `@JavascriptInterface` method reads the WebView's current
  URL (on the UI thread; no answer within a second counts as refused) and compares scheme, host
  and port exactly with the origin the host configured (`ADAXAI_ORIGIN`). Events, frames and files
  are handed over only while the WebView shows that origin, checked again at the moment of hand-
  over.
- **Frames.** Android injects a JavaScript interface into every frame of the page, iframes
  included, and the app cannot tell which frame called. The check is therefore on the top-level
  page, and **the ADAXAI web app must not embed pages from other origins** (its content security
  policy should keep it so). A stronger mechanism exists (`WebViewCompat.addWebMessageListener`
  in AndroidX WebKit, which checks each frame's origin); moving to it would be a contract v2.
- **The host stays on ADAXAI.** Links to other web pages open in the browser, other schemes not
  at all; file and content access in the WebView are off; mixed content is refused.
- **Nothing leaves the tablet except through the page.** The bridge has no network access of its
  own, keeps no image (a capture's temporary file in the app's cache is deleted once read) and
  logs no image contents and no page URL (URLs can carry patient ids). The page uploads a capture
  to ADAXAI over its own authenticated session; the server applies the patient's consent to
  thermal imaging, the `thermal:write` permission, facility isolation and the audit log as for any
  thermal upload.
- **What ADAXAI cannot verify.** That a file marked `live_capture` came from this bridge, and
  anything in `deviceReported`: both are what the sending application says. The file itself is
  checked to be a FLIR radiometric JPEG either way.

## What the web app does with a capture

The thermal workspace uploads the file from the `capture` event (`fileBase64` decoded, named
`fileName`) to **`POST /api/patients/:id/thermal`**, with the capture details (body site, view,
room temperature, acclimatisation, distance), the consultation, and the V6 provenance:
`captureSource` = `live_capture`, `capturedAt` (only when `capturedAtSource` is `camera`, see
[Events](#events)), and the event's `device` as `deviceReported`
(`ThermalDeviceReported` in `packages/contracts/src/thermal.ts`). The server extracts the
per-pixel temperatures from the file with `flyr` as for any upload, stores the file unchanged
with its SHA-256, matches the camera to the device registry by serial number, and records the
source; the source, the device and the file cannot be changed afterwards (database trigger
`thermal_capture_provenance_guard`). The temperatures ADAXAI stores and shows are the ones it
computed from the file; `sdkStats` are the SDK's own figures, at most shown beside them for
comparison. Preview frames are never uploaded or stored.

For the audit log, the workspace reports what happened to the camera, never a frame or an image
(`ThermalWorkspaceEventRequest`): `camera_connected`, `connect_failed`, `camera_disconnected` and
`capture_failed` with `adapter: native_bridge`, the bridge's `state` or error message as
`state`/`reason`, and the reported `device.model` as `deviceModel`.

If the file the SDK writes is not one `flyr` can read, the upload is refused (`unsupported_format`)
and nothing is stored. That is unverified and is step 11 below.

## Testing without hardware

- **Today:** the web app's simulator (`packages/contracts/src/thermalSim.ts`, the server's
  simulator route) generates thermal matrices for named cases. Everything it produces is
  `captureSource: simulator`, `simulated: true`, data origin `synthetic` (database constraints),
  labelled SIMULATED, and by rule kept out of the patient portal, every model and AI context,
  Mana, dataset exports and consultation notes. It does not exercise this bridge.
- **Next step for the bridge: the FLIR SDK's emulator.** `CommunicationInterface.EMULATOR`
  ("Emulating device interface") would let the bridge discover, connect, stream and capture with
  no camera. It is deliberately not scanned now, because an emulated image would reach ADAXAI as
  a `live_capture`. Before it is enabled (in a debug build only): the bridge reports
  `interface: "EMULATOR"`, the web app never uploads such a capture as `live_capture`, and the
  server refuses a `live_capture` whose `deviceReported.interface` is not `USB`. None of this is
  built.

## Status

**Not compiled. Not run. No FLIR ONE, tablet or FLIR SDK was available; nothing in this directory
has been tested.** (This applies to everything under `android/`.) Every Kotlin file says so in
its first line. The FLIR SDK names were checked against the 2.4.0 javadoc on 5 October 2026; the
Android framework names were not compiled. The timing and lifecycle above are what the code is
written to do, not observed behaviour.

### Verification on hardware

To be done in this order, recording the result of each (tablet make, model and Android version;
FLIR ONE model, serial number and firmware; SDK version). Only what passes may be described as
working.

1. Create the FLIR developer account, accept the licence and download the FLIR Atlas Android SDK.
   Record its exact version and the SHA-256 of the archive.
2. Check every SDK name listed in `android/README.md` against that version's javadoc; correct the
   code where it differs. Copy the FLIR ONE product ids from the sample app's device filter into
   `flir_usb_device_filter.xml` and compare the sample's manifest with ours (the `CAMERA`
   permission question in particular).
3. Build the bridge and the host app (Android Gradle plugin 8.x, Kotlin Android plugin 2.x,
   JDK 17; with AGP 9 or later remove the Kotlin Android plugin line, see `android/README.md`);
   fix compile errors. Record the plugin, Kotlin and compileSdk versions. Run Android lint.
4. Install on the target tablet. Confirm USB host on its USB-C port (any OTG test app), and that
   the FLIR ONE physically fits with the tablet's case on.
5. Set `ADAXAI_ORIGIN` to a test deployment (synthetic data only), log in, and check that
   `bridgeInfo()` returns the SDK's version and that a page of another origin gets
   `origin_not_allowed` and receives no event.
6. Plug in the FLIR ONE and switch it on. Check the "open ADAXAI" prompt and the USB permission
   dialog; refuse once (`device_error` with `usb_permission_denied`, and the page stops waiting
   at once), then allow.
7. `connect()`: `connecting` then `connected` only once the camera really is; `device.interface`
   is `USB`. Unplug during `connecting`: an error, never `connected`. Connect with no camera
   plugged in: `device_error` with `camera_not_found` after 20 s, shown by the page. Time
   discovery, the permission dialog and `Camera.connect` separately. Leave the permission
   dialog open for more than 45 s: the page stops waiting; allow afterwards and check that the
   page then shows `connected` and offers Start live view. Repeat connect and disconnect at
   least 20 times: record any intermittent discovery or connection error (the SDK's UI-context
   requirement).
8. `startPreview()`: `previewing` only once frames arrive; measure the frame rate (at most about
   9 a second), the delay, the frame size (at most 480 px wide), and the tablet's CPU and memory.
9. After the first frame, compare `model`, `serialNumber`, `programVersion` and `articleNumber`
   with the camera's label and FLIR's own app.
10. `capture()`: one `capture` event with `ok: true`; a second request during it gets
    `capture_in_progress`; the temporary file is gone from the app's cache afterwards.
11. Upload from the thermal workspace: the server accepts the SDK's file (flyr reads it), stores
    it with `captureSource: live_capture`, and matches the registered device by serial number.
    If the server answers `unsupported_format`, record it and stop: live capture does not work
    with this SDK output.
12. Compare the server's min, max, mean and standard deviation with `sdkStats` and with FLIR's own
    app on the same scene; against a reference (a calibrated contact thermometer on a matte
    surface at room temperature, or a blackbody source), record the differences. Claim nothing
    beyond FLIR's stated accuracy.
13. Compare `capturedAt` with the tablet's clock and the camera's file date; record
    `capturedAtSource`. With `camera`, the stored capture time is the camera's; with `tablet`,
    check that the record shows no camera capture time.
14. Unplug the camera during the preview, let its battery run out, switch it off: each ends in
    `disconnected` (or `device_error` with the SDK's text), the preview stops, and `connect()`
    works again. Rotate the tablet: the preview continues. Put the app in the background and
    back, lock and unlock the screen, open "Import from the tablet" and cancel: each time the
    preview stops while the app is not on screen, the page shows `connected` on return, and
    Start live view brings the picture back; nothing crashes. Close and reopen the thermal
    workspace: the same. If the stream stalls during any of these tests, check that the page
    shows `frames_stopped` and that Start live view restarts it. Finish the app and
    relaunch it in the same process, then check with Android Studio's memory profiler (heap
    dump) that no destroyed `MainActivity` is still referenced, by the bridge or by the SDK.
15. Run a 30-minute preview with periodic captures: no memory growth, no stalls, temperatures of
    the tablet and the camera, battery use. Then update this document (what was verified, on
    which hardware), remove "not run" only for what was run, and submit the app to FLIR for
    review before any release.

## Sources

- FLIR Atlas Android SDK 2.4.0, javadoc (official):
  https://update2flir2se.blob.core.windows.net/update/SSF/Atlas/2.4.0/Android/javadoc/index.html
  (each class page used is listed in `android/README.md`)
- FLIR, Mobile SDK (developer account, download): https://www.flir.com/developer/mobile-sdk/
- FLIR developer blog, Android SDK 1.0.1 released (free developer account, online licence
  agreement): https://www.flir.com/developer/blog/android-sdk-1.0.1-released
- FLIR developer blog, FLIR ONE Developer Community Summer Update (third-generation FLIR ONE and
  FLIR ONE Pro for Android USB-C; apps reviewed and approved before release):
  https://www.flir.com/developer/blog/flir-one-developer-community-summer-update/
- FLIR ONE Gen 3 specifications: https://www.flir.com/products/flir-one-gen-3/
- FLIR ONE Pro specifications: https://www.flir.com/products/flir-one-pro/
- FLIR ONE Edge Pro (wireless): https://www.flir.com/products/flir-one-edge-pro/
- Android, USB host overview (feature, intent filter, device filter, permission):
  https://developer.android.com/develop/connectivity/usb/host
- Android, `UsbManager` (USB video class devices and the `CAMERA` permission):
  https://developer.android.com/reference/android/hardware/usb/UsbManager
- Android, `WebView.addJavascriptInterface`:
  https://developer.android.com/reference/android/webkit/WebView#addJavascriptInterface(java.lang.Object,%20java.lang.String)
- Chromium, Java Bridge (objects injected into every frame; the app cannot tell the calling
  frame's origin): https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/java-bridge.md
- AndroidX WebKit, `WebViewCompat.addWebMessageListener`:
  https://developer.android.com/reference/androidx/webkit/WebViewCompat
- USB vendor id 0x09CB, FLIR Systems: https://devicehunt.com/view/type/usb/vendor/09CB
- Kotlin 2.2.0, `kotlinOptions{}` raised to an error: https://kotlinlang.org/docs/whatsnew22.html;
  migration to `compilerOptions{}`: https://kotlinlang.org/docs/gradle-compiler-options.html
- Android, built-in Kotlin in Android Gradle plugin 9.0 (the Kotlin Android plugin refused):
  https://developer.android.com/build/migrate-to-built-in-kotlin
