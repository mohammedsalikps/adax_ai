// NOT COMPILED, NOT RUN on hardware. A minimal WebView host showing how the ADAXAI thermal bridge is attached and kept to the ADAXAI
// origin. No Android SDK, JDK, tablet or FLIR ONE was available when it was written; nothing here has been tested.
//
// It belongs in an Android application module that depends on :thermal-bridge and packages the FLIR SDK (see android/README.md). The
// application's AndroidManifest.xml needs, besides what the bridge's library manifest merges in (android.hardware.usb.host):
//
//   <uses-permission android:name="android.permission.INTERNET" />
//   <application android:usesCleartextTraffic="false" ...>
//     <activity
//       android:name="ai.adaxai.thermal.host.MainActivity"
//       android:exported="true"
//       android:launchMode="singleTask"
//       android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboardHidden">
//       <intent-filter>
//         <action android:name="android.intent.action.MAIN" />
//         <category android:name="android.intent.category.LAUNCHER" />
//       </intent-filter>
//       <!-- Plugging in a FLIR USB device offers to open this app; accepting also grants it USB access to that device. -->
//       <intent-filter>
//         <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
//       </intent-filter>
//       <meta-data android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" android:resource="@xml/flir_usb_device_filter" />
//     </activity>
//   </application>
//
// configChanges keeps the Activity (and with it the WebView, the bridge and the camera connection) when the tablet is rotated.
// singleTask keeps one instance. Both matter to the FLIR SDK too: the bridge hands it this Activity as its UI context, and a second
// Activity in the same process means a second init (see FlirOneCamera.initSdk).
package ai.adaxai.thermal.host

import ai.adaxai.thermal.AdaxaiThermalBridge
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.util.Locale

class MainActivity : Activity() {
  companion object {
    /**
     * The ADAXAI deployment this tablet uses: scheme, host and port only. The bridge answers pages of this origin and no other. Set it
     * per deployment (a build config field, a managed configuration); the value here is a placeholder that resolves nowhere.
     */
    const val ADAXAI_ORIGIN = "https://adaxai.example.invalid"
    private const val FILE_CHOOSER_REQUEST = 1001
  }

  private lateinit var webView: WebView
  private lateinit var bridge: AdaxaiThermalBridge
  private var fileCallback: ValueCallback<Array<Uri>>? = null

  private fun isAdaxai(uri: Uri): Boolean {
    val allowed = Uri.parse(ADAXAI_ORIGIN)
    fun port(u: Uri) = if (u.port != -1) u.port else if (u.scheme.equals("https", ignoreCase = true)) 443 else 80
    return uri.scheme.equals(allowed.scheme, ignoreCase = true) &&
      uri.host != null &&
      uri.host!!.lowercase(Locale.ROOT) == allowed.host?.lowercase(Locale.ROOT) &&
      port(uri) == port(allowed)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)

    webView = WebView(this)
    setContentView(webView)
    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      // Nothing from the tablet's files reaches the page except through the file chooser below.
      allowFileAccess = false
      allowContentAccess = false
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      setGeolocationEnabled(false)
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
    }

    webView.webViewClient = object : WebViewClient() {
      // The WebView stays on ADAXAI: other web pages open in the browser, other schemes not at all. The bridge checks the origin on
      // every call as well, so a page that gets here another way (a redirect) still cannot use it.
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (isAdaxai(url)) return false
        if (request.isForMainFrame && (url.scheme == "https" || url.scheme == "http")) {
          try {
            startActivity(Intent(Intent.ACTION_VIEW, url))
          } catch (e: ActivityNotFoundException) {
            // No browser: the link is not followed.
          }
        }
        return true
      }
    }

    webView.webChromeClient = object : WebChromeClient() {
      // <input type="file"> in a WebView needs this: it is how "Import from the tablet" chooses an earlier radiometric file.
      override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        return try {
          startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST)
          true
        } catch (e: ActivityNotFoundException) {
          fileCallback = null
          false
        }
      }
    }

    bridge = AdaxaiThermalBridge(this, webView, ADAXAI_ORIGIN)
    bridge.attach()
    webView.loadUrl("$ADAXAI_ORIGIN/")
  }

  // android.app.Activity's result API keeps this example free of AndroidX; an AndroidX host would use registerForActivityResult.
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode == FILE_CHOOSER_REQUEST) {
      fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
      fileCallback = null
      return
    }
    super.onActivityResult(requestCode, resultCode, data)
  }

  override fun onPause() {
    // No live view while the app is not on screen: another app, the screen locked, the file chooser of "Import from the tablet" (and
    // perhaps Android's USB permission dialog) in front. The camera stays connected; the page is told `connected` by a status event.
    bridge.pausePreview()
    webView.onPause()
    super.onPause()
  }

  override fun onResume() {
    super.onResume()
    webView.onResume()
    // The page hears the camera's state again and offers to start the live view; the bridge does not restart it by itself.
    bridge.reportStatus()
  }

  override fun onDestroy() {
    bridge.release()
    webView.destroy()
    super.onDestroy()
  }
}
