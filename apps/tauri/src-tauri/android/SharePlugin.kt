// The phone's share sheet (Receive's Share): text, and with a request its QR
// code's picture beside it, as a message app sends a photo with a caption.
// The picture is written to the app's cache and handed over through the
// FileProvider Tauri's Android project declares (`<cache-path>`), read-only,
// to the app the person picks; only the last one shared is kept.
//
// Copied into the generated Android project by build.rs, as the other
// plugins are, and registered by src/android.rs as the plugin "dusk-share".

package network.dusk.wallet

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareArgs {
  var text: String = ""
  var title: String = ""
  // A PNG, base64, and the name it's shared as.
  var image: String = ""
  var name: String = ""
}

@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
  private fun answer(invoke: Invoke, ok: Boolean) {
    val out = JSObject()
    out.put("ok", ok)
    invoke.resolve(out)
  }

  /** Opens the share sheet: `text`, and `image` with it where there's one. */
  @Command
  fun share(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    try {
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, args.text)
      }
      if (args.image.isNotEmpty()) {
        val dir = File(activity.cacheDir, "shared").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val name = args.name.replace(Regex("[^A-Za-z0-9._-]"), "-").ifEmpty { "dusk-request.png" }
        val file = File(dir, name)
        file.writeBytes(Base64.decode(args.image, Base64.DEFAULT))
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        send.type = "image/png"
        send.putExtra(Intent.EXTRA_STREAM, uri)
        send.clipData = ClipData.newRawUri(name, uri)
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(Intent.createChooser(send, args.title.ifEmpty { null }))
      answer(invoke, true)
    } catch (_: Exception) {
      answer(invoke, false)
    }
  }
}
