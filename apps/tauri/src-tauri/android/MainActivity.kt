package network.dusk.wallet

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

/**
 * The app's activity, as `cargo tauri android init` makes it, with one thing
 * more: a new intent becomes the activity's own (`setIntent`). A notice's tap
 * on an app Android ended in the background, its task still there, starts it
 * again with the intent it first had, and hands the tap's as a new intent
 * before the plugins are loaded, which Tauri gives only to those loaded: the
 * tap was lost, and the app opened on Home (Sofía's). Kept as the activity's
 * intent, a plugin reads it as it loads (NoticesPlugin's `load`).
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
  }
}
