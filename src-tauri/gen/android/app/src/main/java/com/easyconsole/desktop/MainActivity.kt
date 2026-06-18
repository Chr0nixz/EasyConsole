package com.easyconsole.desktop

import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    Log.i("EasyConsole", "MainActivity.onCreate() called")
    WebView.setWebContentsDebuggingEnabled(true)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    Log.i("EasyConsole", "MainActivity.onCreate() completed")
  }
}
