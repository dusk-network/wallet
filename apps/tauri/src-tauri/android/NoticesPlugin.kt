// Arrival notices on the phone (src/shared/phoneNotices.js): Android's
// question for leave to show them, asked only when the person taps Tell me
// when it arrives, and a payment's notice once they may show.
//
// Copied into the generated Android project by build.rs, as the icon is, and
// registered by src/android.rs as the plugin "dusk-notices". Each command
// answers and never rejects.

package network.dusk.wallet

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import android.app.Notification

@InvokeArg
class NoticeArgs {
  var title: String = ""
  var body: String = ""
}

@TauriPlugin(permissions = [Permission(strings = ["android.permission.POST_NOTIFICATIONS"], alias = "notices")])
class NoticesPlugin(private val activity: Activity) : Plugin(activity) {
  private val channel = "payments"
  private val manager: NotificationManager? get() = activity.getSystemService(NotificationManager::class.java)

  // Whether a notice would show: leave given on Android 13 and later, and notices
  // not turned off for the app in the phone's settings.
  private fun allowed(): Boolean {
    val granted = Build.VERSION.SDK_INT < 33 ||
      activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED
    return granted && (manager?.areNotificationsEnabled() == true)
  }

  private fun answer(invoke: Invoke, allowed: Boolean) {
    val out = JSObject()
    out.put("allowed", allowed)
    invoke.resolve(out)
  }

  /** Whether notices may show. */
  @Command
  fun status(invoke: Invoke) {
    answer(invoke, allowed())
  }

  /** Android's question, where it has one to ask: Android 13 and later. */
  @Command
  fun ask(invoke: Invoke) {
    if (allowed() || Build.VERSION.SDK_INT < 33 || getPermissionState("notices") == PermissionState.GRANTED) {
      answer(invoke, allowed())
      return
    }
    requestPermissionForAlias("notices", invoke, "asked")
  }

  @PermissionCallback
  private fun asked(invoke: Invoke) {
    answer(invoke, allowed())
  }

  /** A payment's notice; tapping it opens the wallet. */
  @Command
  fun notify(invoke: Invoke) {
    val args = invoke.parseArgs(NoticeArgs::class.java)
    val notices = manager
    if (!allowed() || notices == null) {
      answer(invoke, false)
      return
    }
    if (notices.getNotificationChannel(channel) == null) {
      notices.createNotificationChannel(NotificationChannel(channel, "Payments", NotificationManager.IMPORTANCE_DEFAULT))
    }
    val open = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
      ?.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val tap = open?.let { PendingIntent.getActivity(activity, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
    // The Dusk mark's shape, as the status bar draws a notice's icon.
    val mark = activity.resources.getIdentifier("ic_launcher_foreground", "mipmap", activity.packageName)
    val notice = Notification.Builder(activity, channel)
      .setSmallIcon(Icon.createWithResource(activity, if (mark != 0) mark else activity.applicationInfo.icon))
      .setContentTitle(args.title)
      .setContentText(args.body)
      .setAutoCancel(true)
      .apply { if (tap != null) setContentIntent(tap) }
      .build()
    notices.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notice)
    answer(invoke, true)
  }
}
