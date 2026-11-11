// A send's arrival, looked up with the app in the background: Android cuts
// the app's network a few seconds after it leaves the screen, and the page's
// own watcher with it. A send the person asked to hear about is kept here
// (`watch`, from src/wallet/localBus.js through NoticesPlugin.kt), and a job
// of Android's JobScheduler asks its node for it once the phone is online:
// soon after the app leaves the screen, then less often, for two hours at
// most. In a block, its notice shows, as the page's would, and it's dropped;
// one the page heard of first is dropped by the page (`settled`). Each send's
// notice shows once, whichever told it first. A wallet removed, reset or
// restored takes its sends with it (`forget`): none is looked for or told
// after, even by a look already under way.
//
// Copied into the generated Android project by build.rs, as the plugins are;
// build.rs also declares the job's service in the manifest.

package network.dusk.wallet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object Arrivals {
  /** The intent's extra a notice's tap carries: the transaction to open. */
  const val EXTRA_TX = "network.dusk.wallet.TX"

  private const val CHANNEL = "payments"
  private const val PREFS = "dusk-wallet-arrivals"
  private const val JOB_ID = 7441
  // Looked for no longer than this after it was sent.
  private const val WATCHED_MS = 2 * 60 * 60 * 1000L
  // Waits between looks: soon, then less often.
  private val DELAYS = longArrayOf(15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000)
  private val HASH = Regex("^[0-9a-f]{64}$")

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun list(context: Context, key: String): JSONArray =
    try {
      JSONArray(prefs(context).getString(key, "[]"))
    } catch (_: Exception) {
      JSONArray()
    }

  private fun keep(context: Context, key: String, value: JSONArray) {
    prefs(context).edit().putString(key, value.toString()).commit()
  }

  /** Whether a notice would show: leave given on Android 13 and later, and notices on for the app. */
  fun allowed(context: Context): Boolean {
    val granted = Build.VERSION.SDK_INT < 33 ||
      context.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED
    return granted && (context.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() == true)
  }

  // Android 8 and later show a notice in a channel, made the first time; the
  // app runs from Android 7 (minSdk 24), which has none.
  @Suppress("DEPRECATION")
  private fun builder(context: Context, notices: NotificationManager): Notification.Builder {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return Notification.Builder(context)
    if (notices.getNotificationChannel(CHANNEL) == null) {
      notices.createNotificationChannel(NotificationChannel(CHANNEL, "Payments", NotificationManager.IMPORTANCE_DEFAULT))
    }
    return Notification.Builder(context, CHANNEL)
  }

  /**
   * A notice, once for each transaction (`hash`): tapping it opens the wallet
   * on that transaction, or on its first screen for none. False where it
   * can't show, or showed already.
   */
  @Synchronized
  fun post(context: Context, title: String, body: String, hash: String): Boolean {
    val notices = context.getSystemService(NotificationManager::class.java)
    if (!allowed(context) || notices == null) return false
    val told = list(context, "told")
    if (hash.isNotEmpty()) {
      for (i in 0 until told.length()) if (told.optString(i) == hash) return false
    }
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      ?.apply { if (hash.isNotEmpty()) putExtra(EXTRA_TX, hash) }
    val tap = open?.let {
      PendingIntent.getActivity(context, hash.hashCode(), it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    // The Dusk mark's shape, as the status bar draws a notice's icon.
    val mark = context.resources.getIdentifier("ic_launcher_foreground", "mipmap", context.packageName)
    val notice = builder(context, notices)
      .setSmallIcon(Icon.createWithResource(context, if (mark != 0) mark else context.applicationInfo.icon))
      .setContentTitle(title)
      .setContentText(body)
      .setAutoCancel(true)
      .apply { if (tap != null) setContentIntent(tap) }
      .build()
    notices.notify(if (hash.isNotEmpty()) hash.hashCode() else (System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notice)
    if (hash.isNotEmpty()) {
      told.put(hash)
      // The last fifty told are enough to tell each once.
      val kept = JSONArray()
      for (i in maxOf(0, told.length() - 50) until told.length()) kept.put(told.optString(i))
      keep(context, "told", kept)
    }
    return true
  }

  /** A send to look for while the app is away: its node, the notice for each outcome, and the wallet it's from. */
  @Synchronized
  fun watch(context: Context, hash: String, nodeUrl: String, title: String, failTitle: String, body: String, wallet: String) {
    if (!HASH.matches(hash) || !(nodeUrl.startsWith("https://") || nodeUrl.startsWith("http://"))) return
    val pending = list(context, "pending")
    val next = JSONArray()
    for (i in 0 until pending.length()) {
      val entry = pending.optJSONObject(i) ?: continue
      if (entry.optString("hash") != hash) next.put(entry)
    }
    next.put(
      JSONObject()
        .put("hash", hash)
        .put("nodeUrl", nodeUrl)
        .put("title", title)
        .put("failTitle", failTitle)
        .put("body", body)
        .put("wallet", wallet)
        .put("at", System.currentTimeMillis())
    )
    keep(context, "pending", next)
    prefs(context).edit().putInt("tries", 0).commit()
    schedule(context, DELAYS[0])
  }

  // No need to look for it any more: what's left.
  @Synchronized
  private fun drop(context: Context, hash: String): Int {
    val pending = list(context, "pending")
    val next = JSONArray()
    for (i in 0 until pending.length()) {
      val entry = pending.optJSONObject(i) ?: continue
      if (entry.optString("hash") != hash) next.put(entry)
    }
    keep(context, "pending", next)
    return next.length()
  }

  // Still looked for: not told yet, nor forgotten.
  private fun watched(context: Context, hash: String): Boolean {
    val pending = list(context, "pending")
    for (i in 0 until pending.length()) if (pending.optJSONObject(i)?.optString("hash") == hash) return true
    return false
  }

  /** Heard of by the page: no need to look for it, nor for the job while nothing's left. */
  fun settled(context: Context, hash: String) {
    if (drop(context, hash) == 0) context.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID)
  }

  /**
   * A wallet removed (`wallet`), or every one, reset or restored (""): its
   * sends aren't looked for any more, and the job goes once none is left.
   * Every one: the notices shown go too.
   */
  @Synchronized
  fun forget(context: Context, wallet: String) {
    val pending = list(context, "pending")
    val next = JSONArray()
    if (wallet.isNotEmpty()) {
      for (i in 0 until pending.length()) {
        val entry = pending.optJSONObject(i) ?: continue
        if (entry.optString("wallet") != wallet) next.put(entry)
      }
    }
    keep(context, "pending", next)
    if (next.length() == 0) context.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID)
    if (wallet.isEmpty()) context.getSystemService(NotificationManager::class.java)?.cancelAll()
  }

  /** The app left the screen: a send still kept is looked for soon. */
  fun away(context: Context) {
    if (list(context, "pending").length() > 0) schedule(context, DELAYS[0])
  }

  private fun schedule(context: Context, delay: Long) {
    val jobs = context.getSystemService(JobScheduler::class.java) ?: return
    val job = JobInfo.Builder(JOB_ID, ComponentName(context, ArrivalJob::class.java))
      .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
      .setMinimumLatency(delay)
      .build()
    try {
      jobs.schedule(job)
    } catch (_: Exception) {
      // Not scheduled: the page looks again as the app comes back.
    }
  }

  // What the node says of `hash`: true in a block and went through, false in
  // a block and failed, null not in a block (yet) or not heard.
  private fun outcome(nodeUrl: String, hash: String): Boolean? {
    var connection: HttpURLConnection? = null
    return try {
      connection = (URL(URL(nodeUrl), "/on/graphql/query").openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 10_000
        readTimeout = 10_000
        doOutput = true
        setRequestProperty("Content-Type", "text/plain")
      }
      connection.outputStream.use { it.write("query { tx(hash: \"$hash\") { id err } }".toByteArray(Charsets.UTF_8)) }
      if (connection.responseCode !in 200..299) return null
      val json = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
      val tx = json.optJSONObject("tx") ?: return null
      tx.isNull("err") || tx.optString("err").isEmpty()
    } catch (_: Exception) {
      null
    } finally {
      connection?.disconnect()
    }
  }

  /**
   * Looks each kept send up once, shows the notice of each one in a block,
   * and drops those and the ones looked for too long. True while some are left.
   */
  fun check(context: Context): Boolean {
    val pending = synchronized(this) { list(context, "pending") }
    val now = System.currentTimeMillis()
    for (i in 0 until minOf(pending.length(), 5)) {
      val entry = pending.optJSONObject(i) ?: continue
      val hash = entry.optString("hash")
      if (now - entry.optLong("at") > WATCHED_MS) {
        drop(context, hash)
        continue
      }
      val went = outcome(entry.optString("nodeUrl"), hash) ?: continue
      // Forgotten while the node answered (its wallet reset or removed): nothing told.
      synchronized(this) {
        if (watched(context, hash)) {
          post(context, if (went) entry.optString("title") else entry.optString("failTitle"), entry.optString("body"), hash)
          drop(context, hash)
        }
      }
    }
    return synchronized(this) { list(context, "pending").length() > 0 }
  }

  /** Once more, a little later than the last time, while some send is left to look for. */
  @Synchronized
  fun again(context: Context) {
    if (list(context, "pending").length() == 0) return
    val tries = prefs(context).getInt("tries", 0) + 1
    prefs(context).edit().putInt("tries", tries).commit()
    schedule(context, DELAYS[minOf(tries, DELAYS.size - 1)])
  }
}

/** JobScheduler's job: the sends kept looked up, off the main thread. */
class ArrivalJob : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    Thread {
      val left = try {
        Arrivals.check(applicationContext)
      } catch (_: Exception) {
        true
      }
      if (left) Arrivals.again(applicationContext)
      jobFinished(params, false)
    }.start()
    return true
  }

  // Stopped before it was done (the network went): Android runs it again.
  override fun onStopJob(params: JobParameters): Boolean = true
}
