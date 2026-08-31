package com.easyconsole.desktop

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    WebView.setWebContentsDebuggingEnabled(true)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * Starts Android's package installer with a content URI that grants the
   * installer temporary read access to the cached APK.
   */
  fun installApk(path: String): String {
    return try {
      val apk = File(path).canonicalFile
      if (!apk.isFile || !apk.name.endsWith(".apk", ignoreCase = true)) {
        return "error:APK file does not exist or has an invalid extension"
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
        val settingsIntent = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:$packageName"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(settingsIntent)
        return "permission-required"
      }

      val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apk)
      val installIntent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        clipData = ClipData.newRawUri("EasyConsole update", uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      startActivity(installIntent)
      "launched"
    } catch (error: Exception) {
      "error:${error.message ?: error.javaClass.simpleName}"
    }
  }
}
