# Android thermal bridge (FLIR ONE on a tablet)

**Status: NOT COMPILED. NOT RUN. No FLIR ONE, tablet, Android SDK, JDK, Gradle or FLIR SDK was
available when this directory was written; nothing in it has been built or tested.** It was
written against the official javadoc of the FLIR Atlas Android SDK 2.4.0, and every FLIR name it
uses is listed below with the page it was checked on. It does not work until someone builds it
and runs it with a FLIR ONE (docs/THERMAL_CAMERA.md, "Status" and the 15 verification steps).

What it is: the native half of live thermal capture in the ADAXAI web app. A small Android app
(a WebView showing ADAXAI) hosts a bridge object that talks to a FLIR ONE through the FLIR
Atlas Android SDK and hands the page the camera's state, a live preview and, on capture, the
camera's own radiometric JPEG. The page uploads that file to ADAXAI like any thermal image. The
full description (hardware, permissions, contract, security, states) is in
[docs/THERMAL_CAMERA.md](../docs/THERMAL_CAMERA.md).

## Files

| File | What it is |
| --- | --- |
| `thermal-bridge/build.gradle.kts` | Android library module `ai.adaxai.thermal` (Kotlin, compileSdk 34, minSdk 26, Java 17) |
| `thermal-bridge/src/main/AndroidManifest.xml` | Library manifest: `android.hardware.usb.host` required; no camera permission (see the note there) |
| `thermal-bridge/src/main/res/xml/flir_usb_device_filter.xml` | USB device filter: FLIR's vendor id 2507 (0x09CB) only; product ids to be taken from the SDK's sample app |
| `thermal-bridge/src/main/java/ai/adaxai/thermal/AdaxaiThermalBridge.kt` | The `@JavascriptInterface` object (`window.AdaxaiThermalNative`), origin check, events to the page |
| `thermal-bridge/src/main/java/ai/adaxai/thermal/FlirOneCamera.kt` | Discovery, USB permission, connection, live stream, preview JPEGs, capture; one thread for all SDK calls |
| `thermal-bridge/src/main/java/ai/adaxai/thermal/BridgeJson.kt` | Every JSON of contract v1 |
| `host-example/MainActivity.kt` | A minimal host Activity: WebView settings, navigation kept on ADAXAI, file chooser, bridge lifecycle; the manifest it needs is in its header comment |

## Building it (not done)

1. Create a FLIR developer account, accept FLIR's online licence and download the **FLIR Atlas
   Android SDK** (see docs/THERMAL_CAMERA.md, "Obtaining the SDK"). Note the exact version.
2. Read that version's javadoc for every name in the table below. If one differs from 2.4.0,
   change the code, not the table's claims.
3. Create an Android Studio project (Android Gradle plugin 8.x, Kotlin Android plugin 2.x, JDK 17)
   with this directory as its root, or add the two modules to an existing one:

   ```kotlin
   // settings.gradle.kts
   include(":thermal-bridge", ":app")
   ```

   Make `:app` an application module, copy `host-example/MainActivity.kt` into it, add the
   manifest entries from that file's header comment, and in `app/build.gradle.kts`:

   ```kotlin
   dependencies {
     implementation(project(":thermal-bridge"))
     // The same FLIR .aar files as the bridge's libs/: the app packages them (classes and native libraries).
     implementation(fileTree(mapOf("dir" to "../thermal-bridge/libs", "include" to listOf("*.aar"))))
   }
   ```

   The bridge's build file sets Kotlin's JVM target with `kotlin { compilerOptions { … } }`,
   because the older `android { kotlinOptions {} }` block is a build error from Kotlin 2.2.0.
   With Android Gradle plugin 9.0 or later (built-in Kotlin, on by default), remove the
   `org.jetbrains.kotlin.android` line from the bridge's `plugins {}`: AGP 9 refuses it. Nothing
   has been built with either.

4. Put the SDK's `.aar` files in `thermal-bridge/libs/`. **Do not commit them**: the SDK is
   licensed by FLIR, not redistributable by this repository. Git-ignore `android/**/libs/*.aar`,
   `android/**/build/`, `android/.gradle/` and `android/local.properties`.
5. Copy the FLIR ONE product ids from the device filter of the sample app shipped with the SDK
   into `flir_usb_device_filter.xml`.
6. Compare the sample app's manifest with the bridge's and the host's (USB host, the camera
   permission question, anything the SDK requires).
7. Set `ADAXAI_ORIGIN` in `MainActivity.kt` to the deployment's origin. Release builds keep
   `@JavascriptInterface` methods only with the default `proguard-android-optimize.txt` rules
   (or an explicit keep rule); check the SDK's own R8 rules too.
8. Build, install on the tablet, then follow the verification steps in
   docs/THERMAL_CAMERA.md. Apps for the FLIR ONE must be reviewed and approved by FLIR before
   release.

## Lifecycle and timing (as written; not run)

The host Activity drives the bridge; the page only ever sees `status` events and `getStatus()`.

| Host or page does | Bridge does | Page sees |
| --- | --- | --- |
| Activity `onCreate` | `AdaxaiThermalBridge(activity, …)`: `ThermalSdkAndroid.init(activity)` (a UI context, as the javadoc requires), then `attach()` | `disconnected` |
| Page calls `connect()` | USB discovery for up to 20 s; once a FLIR ONE is found, Android's USB permission dialog if access is not yet granted (no time limit of the bridge's), then `Camera.connect` | `connecting`, then `connected`, or `device_error` with `camera_not_found`, `usb_permission_denied`, `usb_permission_error`, `unsupported_camera`, `camera_lost`, `connect_failed`, `sdk_unavailable` or the SDK's own code |
| Activity `onPause` (another app, screen locked, the file chooser of "Import from the tablet", possibly the USB permission dialog) | `pausePreview()`: the stream stops, the camera stays connected | `connected` |
| Activity `onResume` | `reportStatus()`: the current state is sent again; the live view is **not** restarted | `connected` (or `disconnected` if the camera went away meanwhile) |
| Page calls `stopPreview()` (e.g. the workspace closes) | the stream stops, the camera stays connected | `connected`; a page opened later reads `connected` from `getStatus()` |
| Page calls `startPreview()` from `connected` | starts the stream; a stream with no frame for 3 s is stopped and started afresh; a live or just-started one is left alone | `previewing` from the first frame |
| No frame for 3 s while previewing / none within 5 s of a start | nothing is stopped | `connected` with `frames_stopped` / `no_frames` |
| Activity `onDestroy` | `release()`: the camera is disconnected, the bridge stops, nothing more is sent | nothing |

The bridge never restarts the live view by itself. After any of the above the page shows the
state it was told and offers to start the live view again; `startPreview()` works from
`connected` however the camera got there.

Timing. A connect takes up to 20 s of discovery (`DISCOVERY_TIMEOUT_MS`), plus however long
the user takes on Android's USB permission dialog, plus `Camera.connect`. The web page waits up
to 45 s for `connected` or a failure. Every failed attempt ends in `device_error` with a code
and a message, so the page stops waiting as soon as the bridge knows. If the dialog is still
open when the page stops waiting, the bridge stays `connecting` until the user answers; the
outcome arrives as a later `status` event. `disconnect()` cancels a pending attempt (a later
answer to the dialog is then ignored).

## FLIR SDK names used, and where each was checked

All pages are under the official javadoc of the FLIR Atlas Android SDK 2.4.0:
`https://update2flir2se.blob.core.windows.net/update/SSF/Atlas/2.4.0/Android/javadoc/` (read on
5 October 2026; the pages of the names touched by the lifecycle changes were read again the same
day, from the raw HTML). "Page" below is the path under that address.

| Name | Used as | Page |
| --- | --- | --- |
| `com.flir.thermalsdk.androidsdk.ThermalSdkAndroid` | `init(Context uiContext)` (static; "must be called before any other interaction"; the context "\*MUST\* be a UI context otherwise errors can intermittently occur during scanning for / connecting to - devices"; "must be done from UI code eg Activity / Fragment / View"): the host **Activity** is passed, by every new bridge. The `IllegalStateException` is documented only for re-initialising "with a different log levels" (overloads with a `LogLevel`, not used). `getVersion()`, `getCommitHash()` (static, `String`) | `com/flir/thermalsdk/androidsdk/ThermalSdkAndroid.html` |
| `com.flir.thermalsdk.live.discovery.DiscoveryFactory` | `getInstance()` (static), `scan(DiscoveryEventListener, CommunicationInterface...)`, `stop(CommunicationInterface...)` | `com/flir/thermalsdk/live/discovery/DiscoveryFactory.html` |
| `com.flir.thermalsdk.live.discovery.DiscoveryEventListener` | `onCameraFound(DiscoveredCamera)`, `onDiscoveryError(CommunicationInterface, ErrorCode)`, `onCameraLost(Identity)` (default), `onDiscoveryFinished(CommunicationInterface)` (default); all "@BackgroundThread", no nullability annotations | `com/flir/thermalsdk/live/discovery/DiscoveryEventListener.html` |
| `com.flir.thermalsdk.live.discovery.DiscoveredCamera` | `getIdentity()` | `com/flir/thermalsdk/live/discovery/DiscoveredCamera.html` |
| `com.flir.thermalsdk.live.CommunicationInterface` | enum constant `USB` ("USB port"), `name` | `com/flir/thermalsdk/live/CommunicationInterface.html` |
| `com.flir.thermalsdk.live.Identity` | public final fields `communicationInterface` (@NotNull), `deviceId` (@NotNull `String`, "a per session unique Id"); `equals` | `com/flir/thermalsdk/live/Identity.html` |
| `com.flir.thermalsdk.androidsdk.live.connectivity.UsbPermissionHandler` | `UsbPermissionHandler()`, `requestFlirOnePermisson(@NonNull Identity, @NonNull Context uiContext, @NonNull UsbPermissionListener)` (**spelled so in the SDK**; "Will show a dialog prompting the user to allow access if permission is missing"; the Activity is passed, on the UI thread), static `hasFlirOnePermission(Identity, Context applicationContext)` (the application context is passed), static `isFlirOne(Identity)` ("emulators will return FALSE") | `com/flir/thermalsdk/androidsdk/live/connectivity/UsbPermissionHandler.html` |
| `UsbPermissionHandler.UsbPermissionListener` | `permissionGranted(@NonNull Identity)`, `permissionDenied(@NonNull Identity)`, `error(ErrorType, Identity)` ("The Identity was not a recognized as a FLIR ONE"); `ErrorType` only through `toString()` (its constants were not listed) | `com/flir/thermalsdk/androidsdk/live/connectivity/UsbPermissionHandler.UsbPermissionListener.html` |
| `com.flir.thermalsdk.live.Camera` | `Camera()` (public constructor, verified), `connect(Identity, ConnectionStatusListener, ConnectParameters /* @Nullable, null passed */)` (blocking, `throws IOException`), `isConnected()`, `disconnect()` (blocking), `close()`, `getStreams()`; "not guaranteed to be thread-safe" | `com/flir/thermalsdk/live/Camera.html` |
| `com.flir.thermalsdk.live.connectivity.ConnectionStatusListener` | `onDisconnected(@Nullable ErrorCode)` | `com/flir/thermalsdk/live/connectivity/ConnectionStatusListener.html` |
| `com.flir.thermalsdk.live.streaming.Stream` | `start(OnReceived<Void>, OnRemoteError)` (callbacks on a streaming / background thread; "The stream will be stopped automatically on error"), `stop()`, `isStreaming()`, `isThermal()` | `com/flir/thermalsdk/live/streaming/Stream.html` |
| `com.flir.thermalsdk.live.remote.OnReceived` | `onReceived(T)` (one method; used as a Kotlin SAM lambda) | `com/flir/thermalsdk/live/remote/OnReceived.html` |
| `com.flir.thermalsdk.live.remote.OnRemoteError` | `onRemoteError(ErrorCode)` | `com/flir/thermalsdk/live/remote/OnRemoteError.html` |
| `com.flir.thermalsdk.live.streaming.ThermalStreamer` | `ThermalStreamer(Stream)`, `update()`, `getImage()` (deep copy or null), `withThermalImage(Consumer<ThermalImage>)`, `setAutoScale(boolean)`, `getScaleRangeMin()`, `getScaleRangeMax()` (valid only with auto scale; throw otherwise), `close()`, static `isTemporaryStreamError(ErrorCode)` | `com/flir/thermalsdk/live/streaming/ThermalStreamer.html` |
| `com.flir.thermalsdk.utils.Consumer` | the parameter type of `withThermalImage` (`accept(T)`); used through a Kotlin lambda, not imported | `com/flir/thermalsdk/utils/Consumer.html` |
| `com.flir.thermalsdk.image.ImageBuffer` | type of `getImage()`, passed to `BitmapAndroid.createBitmap` | `com/flir/thermalsdk/image/ImageBuffer.html` |
| `com.flir.thermalsdk.androidsdk.image.BitmapAndroid` | static `createBitmap(@NotNull ImageBuffer)` (static: verified), `getBitMap()` (`android.graphics.Bitmap`), `recycle()` | `com/flir/thermalsdk/androidsdk/image/BitmapAndroid.html` |
| `com.flir.thermalsdk.image.ThermalImage` | `getStatistics()`, `getCameraInformation()`, `getDateTaken()` (`java.util.Date`, "or null if date can't be retrieved": then the capture's `capturedAtSource` is `tablet`), `saveAs(String)` (`throws IOException`) | `com/flir/thermalsdk/image/ThermalImage.html` |
| `com.flir.thermalsdk.image.ImageStatistics` | public fields `min`, `max`, `average` (`ThermalValue`), `standardDeviation` (`ThermalDelta`) | `com/flir/thermalsdk/image/ImageStatistics.html` |
| `com.flir.thermalsdk.image.ThermalValue` | `asCelsius()`, field `value` (`double`) | `com/flir/thermalsdk/image/ThermalValue.html` |
| `com.flir.thermalsdk.image.ThermalDelta` | `asCelsius()`, field `value` (`double`) | `com/flir/thermalsdk/image/ThermalDelta.html` |
| `com.flir.thermalsdk.image.CameraInformation` | public final `String` fields `model`, `serialNumber`, `programVersion`, `articleNumber` | `com/flir/thermalsdk/image/CameraInformation.html` |
| `com.flir.thermalsdk.ErrorCode` | `getCode()` (`int`), `getMessage()` (`String`), `isError()`, `toString()` (a class, not an enum) | `com/flir/thermalsdk/ErrorCode.html` |
| `com.flir.thermalsdk.ErrorCodeException` | `extends RuntimeException`; public final field `errorCode` | `com/flir/thermalsdk/ErrorCodeException.html` |

Checked but not used: `ThermalLog` (its `LogLevel` constants were not listed, so the one-argument
`init` is used), `TemperatureUnit` (`CELSIUS` exists; the bridge converts with `asCelsius()`
instead of changing the streamed image's unit), `ThermalImage.setTemperatureUnit`,
`DiscoveryFactory.isDiscovering()`, `CommunicationInterface.EMULATOR` and `FLIR_ONE_WIRELESS`.

Not verified, and to check when the SDK is downloaded:

- That `ThermalImage.saveAs` writes a radiometric JPEG that ADAXAI's thermal service (`flyr`,
  big-endian FFF records only) can read. If it cannot, the upload is refused with
  `unsupported_format` and nothing is stored: that is the expected honest failure, not a bug to
  work around.
- The UI context of `ThermalSdkAndroid.init`. The javadoc says it "\*MUST\* be a UI context",
  and the bridge passes the host Activity; yet the one-argument overload's own example passes
  `MainActivity.this.getApplicationContext()`. Compare with the sample app shipped with the SDK.
- Whether calling `init` again from a new host Activity replaces the context the SDK keeps. If
  it does not, a host relaunched in the same process leaves the first, destroyed Activity
  referenced by the SDK until the process ends (a leak of one Activity). The bridge itself holds
  the Activity only weakly. Check with Android Studio's memory profiler (docs/THERMAL_CAMERA.md,
  verification step 14).
- On which thread `UsbPermissionHandler`'s listener is called (the bridge does not depend on it),
  and whether the permission dialog pauses the host Activity (the bridge is written to cope
  either way).
- Whether any FLIR ONE USB interface is of USB class "video" (then Android 9+ grants USB access
  to apps targeting API 28+ only with `android.permission.CAMERA`, which is not declared).
- The FLIR ONE product ids, the SDK's own `minSdkVersion` and the `.aar` file names.
