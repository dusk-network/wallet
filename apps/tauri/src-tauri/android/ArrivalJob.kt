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
// And money coming in (`Incoming`): the open wallet's public accounts, looked
// at by another job about every 15 minutes, each payment in told once, as it
// came while the app was away from the screen.
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
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

object Arrivals {
  /** The intent's extra a notice's tap carries: the transaction to open. */
  const val EXTRA_TX = "network.dusk.wallet.TX"
  /** And what its notice knew of it: "executed" or "failed", and its block, where it knew. */
  const val EXTRA_OUTCOME = "network.dusk.wallet.TX_OUTCOME"
  const val EXTRA_BLOCK = "network.dusk.wallet.TX_BLOCK"
  /**
   * And the token the wallet gave its send's notice (src/wallet/localBus.js):
   * any app can open the wallet with extras of its own, so the page takes a
   * tap as its notice's only with the token kept with that send.
   */
  const val EXTRA_TOKEN = "network.dusk.wallet.TX_TOKEN"
  /** And, for money that came in, the account it came to: the page opens that profile. */
  const val EXTRA_ACCOUNT = "network.dusk.wallet.TX_ACCOUNT"

  private const val CHANNEL = "payments"
  private const val PREFS = "dusk-wallet-arrivals"
  private const val JOB_ID = 7441
  // Looked for no longer than this after it was sent.
  private const val WATCHED_MS = 2 * 60 * 60 * 1000L
  // Waits between looks: every 10 to 30 seconds the first two minutes, as a
  // block comes every 10 seconds, then less often. They start over as the
  // app leaves the screen: a send still on its way is in a block soon.
  private val DELAYS = longArrayOf(10_000, 10_000, 10_000, 15_000, 15_000, 20_000, 20_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000)
  private val HASH = Regex("^[0-9a-f]{64}$")
  private val TOKEN = Regex("^[0-9a-f]{32}$")

  /** A transaction's ID and a notice's token as the wallet writes them: anything else a tap brings is no notice's. */
  fun isHash(text: String) = HASH.matches(text)
  fun isToken(text: String) = TOKEN.matches(text)

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
   * on that transaction, or on its first screen for none, with what came of
   * it (`outcome`, "executed" or "failed") and its block, where known, and
   * the send's `token`, by which the page knows the tap is this notice's;
   * for money that came in, the `account` it came to. A locked phone that
   * hides what notices say shows `publicTitle` and `publicBody` (the network)
   * instead: no amount, no one's name. False where it can't show, or showed
   * already.
   */
  @Synchronized
  fun post(context: Context, title: String, body: String, hash: String, outcome: String = "", block: Long = 0L, token: String = "", publicBody: String = "", account: String = "", publicTitle: String = title): Boolean {
    val notices = context.getSystemService(NotificationManager::class.java)
    if (!allowed(context) || notices == null) return false
    val told = list(context, "told")
    if (hash.isNotEmpty()) {
      for (i in 0 until told.length()) if (told.optString(i) == hash) return false
    }
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      ?.apply {
        if (hash.isNotEmpty()) putExtra(EXTRA_TX, hash)
        if (hash.isNotEmpty() && (outcome == "executed" || outcome == "failed")) putExtra(EXTRA_OUTCOME, outcome)
        if (hash.isNotEmpty() && block > 0L) putExtra(EXTRA_BLOCK, block)
        if (hash.isNotEmpty() && isToken(token)) putExtra(EXTRA_TOKEN, token)
        if (hash.isNotEmpty() && account.isNotEmpty()) putExtra(EXTRA_ACCOUNT, account)
      }
    val tap = open?.let {
      PendingIntent.getActivity(context, hash.hashCode(), it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    // The Dusk mark's shape, as the status bar draws a notice's icon.
    val mark = context.resources.getIdentifier("ic_launcher_foreground", "mipmap", context.packageName)
    val icon = Icon.createWithResource(context, if (mark != 0) mark else context.applicationInfo.icon)
    // What a locked phone shows where it hides what notices say: what came of it and the network.
    val locked = builder(context, notices).setSmallIcon(icon).setContentTitle(publicTitle).setContentText(publicBody).build()
    val notice = builder(context, notices)
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(body)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPublicVersion(locked)
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
    // Each notice's token, by its transaction, for its tap to be known as this notice's (`isOurs`).
    if (hash.isNotEmpty() && isToken(token)) {
      val tokens = list(context, "tokens")
      val next = JSONArray()
      for (i in maxOf(0, tokens.length() - 49) until tokens.length()) next.put(tokens.optJSONArray(i) ?: continue)
      next.put(JSONArray().put(hash).put(token))
      keep(context, "tokens", next)
    }
    return true
  }

  /**
   * Whether a tap's `token` is the one a notice of this app carried for
   * `hash`, or for money that came in to `account`, the wallet's for those:
   * any app can open the wallet with these extras, never with a token the
   * wallet made. The page opens such a tap at once, and checks it again.
   */
  fun isOurs(context: Context, hash: String, token: String, account: String): Boolean {
    if (!isHash(hash) || !isToken(token)) return false
    if (account.isNotEmpty()) return Incoming.tokenFor(context, account) == token
    val tokens = list(context, "tokens")
    for (i in 0 until tokens.length()) {
      val pair = tokens.optJSONArray(i) ?: continue
      if (pair.optString(0) == hash && pair.optString(1) == token) return true
    }
    return false
  }

  /**
   * A send to look for while the app is away: its node, the notice for each
   * outcome, its body with the amount and without (`hiddenBody`, posted while
   * balances are hidden, `hide`), the wallet it's from, and its notice's token.
   */
  @Synchronized
  fun watch(context: Context, hash: String, nodeUrl: String, title: String, failTitle: String, body: String, wallet: String, token: String, publicBody: String = "", hiddenBody: String = "") {
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
        .put("hiddenBody", hiddenBody)
        .put("publicBody", publicBody)
        .put("wallet", wallet)
        .put("token", if (isToken(token)) token else "")
        .put("at", System.currentTimeMillis())
    )
    keep(context, "pending", next)
    prefs(context).edit().putInt("tries", 0).commit()
    schedule(context, DELAYS[0])
  }

  /** Whether balances are hidden in the wallet, as it says now: read as each send's notice is posted. */
  fun hide(context: Context, hidden: Boolean) {
    prefs(context).edit().putBoolean("hidden", hidden).commit()
  }

  // A send's body as it's posted: without the amount while balances are
  // hidden, the network alone where it was kept without such a body.
  private fun bodyOf(context: Context, entry: JSONObject): String =
    if (prefs(context).getBoolean("hidden", false)) entry.optString("hiddenBody").ifEmpty { entry.optString("publicBody") } else entry.optString("body")

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

  /** The app left the screen: a send still kept is looked for soon, and often at first again. */
  @Synchronized
  fun away(context: Context) {
    Incoming.away(context)
    if (list(context, "pending").length() == 0) return
    prefs(context).edit().putInt("tries", 0).commit()
    schedule(context, DELAYS[0])
  }

  private fun schedule(context: Context, delay: Long) {
    val jobs = context.getSystemService(JobScheduler::class.java) ?: return
    val job = JobInfo.Builder(JOB_ID, ComponentName(context, ArrivalJob::class.java))
      .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
      .setMinimumLatency(delay)
      // Run by then: without a deadline, Android 14 holds a job most of a
      // minute for the phone to charge or idle, and a send's notice is due
      // moments after its block. Without a network then, it's looked for again.
      .setOverrideDeadline(delay + 5_000)
      .build()
    try {
      jobs.schedule(job)
    } catch (_: Exception) {
      // Not scheduled: the page looks again as the app comes back.
    }
  }

  /** A node's answer to a GraphQL query: null where it gave none. */
  fun graphql(nodeUrl: String, query: String): JSONObject? {
    var connection: HttpURLConnection? = null
    return try {
      connection = (URL(URL(nodeUrl), "/on/graphql/query").openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 10_000
        readTimeout = 10_000
        doOutput = true
        setRequestProperty("Content-Type", "text/plain")
      }
      connection.outputStream.use { it.write(query.toByteArray(Charsets.UTF_8)) }
      if (connection.responseCode !in 200..299) return null
      JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
    } catch (_: Exception) {
      null
    } finally {
      connection?.disconnect()
    }
  }

  // What the node says of `hash`: whether it went through, in a block, and the
  // block (0 where the node didn't say); null not in a block (yet) or not heard.
  private fun outcome(nodeUrl: String, hash: String): Pair<Boolean, Long>? {
    val tx = graphql(nodeUrl, "query { tx(hash: \"$hash\") { id err blockHeight } }")?.optJSONObject("tx") ?: return null
    return Pair(tx.isNull("err") || tx.optString("err").isEmpty(), tx.optLong("blockHeight", 0L))
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
      val (went, block) = outcome(entry.optString("nodeUrl"), hash) ?: continue
      // Forgotten while the node answered (its wallet reset or removed): nothing told.
      synchronized(this) {
        if (watched(context, hash)) {
          post(context, if (went) entry.optString("title") else entry.optString("failTitle"), bodyOf(context, entry), hash, if (went) "executed" else "failed", block, entry.optString("token"), entry.optString("publicBody"))
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

/**
 * Money coming in to the open wallet's public accounts, looked for while the
 * app is away from the screen, with no server: a job of Android's
 * JobScheduler, about every 15 minutes (Android's shortest), reads each
 * account's payments in since its last look from the archive the wallet reads
 * its history from, and tells each that came after the app left the screen,
 * once: "You received 0.03 DUSK from …". Kept for it (`watch`, from the page,
 * src/ui/popup/incoming.js): the public accounts, with the names Activity
 * gives the wallet's own; the public .dusk names of those it was paid by; the
 * archive's address; the notice's words; the wallet's token for its taps.
 * Public data only: never a key or the recovery words, nor a contact. No
 * accounts, as with it turned off in Settings, and the job goes.
 */
object Incoming {
  private const val PREFS = "dusk-wallet-incoming"
  const val JOB_ID = 7442
  // A first look at once, for each account's start: what came before isn't told.
  const val SOON_ID = 7443
  private const val EVERY_MS = 15 * 60 * 1000L
  private const val TRANSFER = "0100000000000000000000000000000000000000000000000000000000000000"
  // Told at most this many at a look, the newest: the rest are in Activity.
  private const val MOST = 5
  // The archive's page of history, oldest first, and the pages read at most at a look.
  private const val PAGE = 50
  private const val PAGES = 20
  private val ACCOUNT = Regex("^[1-9A-HJ-NP-Za-km-z]{40,200}$")

  /** The app on the screen: nothing's told, it shows what came in. A process a job started has no screen. */
  @Volatile var inFront = false

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun setup(context: Context): JSONObject? =
    try {
      prefs(context).getString("setup", null)?.let { JSONObject(it) }
    } catch (_: Exception) {
      null
    }

  private fun since(context: Context): JSONObject =
    try {
      JSONObject(prefs(context).getString("since", "{}") ?: "{}")
    } catch (_: Exception) {
      JSONObject()
    }

  private fun accountsOf(setup: JSONObject): List<String> {
    val list = setup.optJSONArray("accounts") ?: return emptyList()
    return (0 until minOf(list.length(), 20)).mapNotNull { list.optJSONObject(it)?.optString("account") }.filter { ACCOUNT.matches(it) }
  }

  private fun jobs(context: Context) = context.getSystemService(JobScheduler::class.java)

  /**
   * What to look for, from the page: `accounts` ({ account, name }), `names`
   * ({ account: its .dusk name }), `archiveUrl`, `network`, `title` (with
   * {amount} and {name}), `wallet`, `token`, and the amount's `decimal` and
   * `group` marks. Without accounts, nothing is looked for any more.
   */
  @Synchronized
  fun watch(context: Context, next: JSONObject?) {
    val archive = next?.optString("archiveUrl") ?: ""
    if (next == null || accountsOf(next).isEmpty() || !(archive.startsWith("https://") || archive.startsWith("http://"))) {
      prefs(context).edit().clear().commit()
      jobs(context)?.cancel(JOB_ID)
      jobs(context)?.cancel(SOON_ID)
      return
    }
    val before = setup(context)
    // Another archive or wallet: where each account was looked at goes with it.
    val same = before != null && before.optString("archiveUrl") == archive && before.optString("wallet") == next.optString("wallet")
    val edit = prefs(context).edit().putString("setup", next.toString())
    if (!same) edit.remove("since")
    edit.commit()
    val jobs = jobs(context) ?: return
    try {
      if (jobs.getPendingJob(JOB_ID) == null) {
        jobs.schedule(JobInfo.Builder(JOB_ID, ComponentName(context, ArrivalJob::class.java)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(EVERY_MS).build())
      }
      // An account not looked at yet: looked at now, so what comes from here on is told.
      val looked = since(context)
      if (accountsOf(next).any { !looked.has(it) }) {
        jobs.schedule(JobInfo.Builder(SOON_ID, ComponentName(context, ArrivalJob::class.java)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).build())
      }
    } catch (_: Exception) {
      // Not scheduled: the page asks again as it draws.
    }
  }

  /** A wallet removed (`wallet`), or every one ("", a reset or a restore): nothing of it is looked for any more. */
  @Synchronized
  fun forget(context: Context, wallet: String) {
    if (wallet.isEmpty() || setup(context)?.optString("wallet") == wallet) watch(context, null)
  }

  /** The token of the notices for money that came in to `account`, one of the accounts looked at: "" for none. */
  fun tokenFor(context: Context, account: String): String {
    val setup = setup(context) ?: return ""
    return if (accountsOf(setup).contains(account)) setup.optString("token") else ""
  }

  /** On the screen again: nothing's told while it is. */
  fun front(context: Context) {
    inFront = true
    prefs(context).edit().putLong("awayAt", 0L).commit()
  }

  /** Away from the screen: what comes in from now on is told. */
  fun away(context: Context) {
    inFront = false
    if (setup(context) != null) prefs(context).edit().putLong("awayAt", System.currentTimeMillis()).commit()
  }

  // An amount of lux in DUSK, every decimal it has, with the page's marks.
  private fun dusk(lux: BigInteger, decimal: String, group: String): String {
    val text = lux.toString().padStart(10, '0')
    val whole = text.dropLast(9).reversed().chunked(3).joinToString(group).reversed()
    val fraction = text.takeLast(9).trimEnd('0')
    return if (fraction.isEmpty()) whole else "$whole$decimal$fraction"
  }

  private class Payment(val account: String, val hash: String, val height: Long, val value: BigInteger, val from: String, val memo: String)

  // At most this many characters of a memo in a notice, the rest "…".
  private const val MEMO_SHOWN = 100
  private val HEX = Regex("^[0-9a-fA-F]+$")

  /**
   * A payment's memo as its words, as Activity reads it (app-core's memoOf):
   * UTF-8 text, else nothing. Nothing either for one with a character that
   * can't be seen or that turns the text around, which Activity shows as its
   * code and a notice can't: its details show it.
   */
  private fun memoText(hex: String): String {
    if (hex.isEmpty() || hex.length % 2 != 0 || hex.length > 2048 || !HEX.matches(hex)) return ""
    val bytes = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    val text = try {
      StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
        .trim()
    } catch (_: Exception) {
      return ""
    }
    if (text.any { Character.isISOControl(it) || Character.getType(it) == Character.FORMAT.toInt() || it == '\u2028' || it == '\u2029' }) return ""
    if (text.codePointCount(0, text.length) <= MEMO_SHOWN) return text
    return text.substring(0, text.offsetByCodePoints(0, MEMO_SHOWN)).trimEnd() + "…"
  }

  /** One look: each account's payments in since the last, the newest told where the app was away when they came. */
  fun check(context: Context) {
    val setup = synchronized(this) { setup(context) } ?: return
    val accounts = accountsOf(setup)
    val archive = setup.optString("archiveUrl")
    val looked = synchronized(this) { since(context) }
    val fields = StringBuilder("pair: lastBlockPair { json }")
    accounts.forEachIndexed { i, account ->
      if (looked.has(account)) fields.append(" a$i: moonlightHistory(receiver: \"$account\", fromBlock: ${looked.optLong(account) + 1}, maxCount: $PAGE) { json }")
    }
    val data = Arrivals.graphql(archive, "query { $fields }") ?: return
    val finalized = data.optJSONObject("pair")?.optJSONObject("json")?.optJSONArray("last_finalized_block")?.optLong(0, -1L) ?: -1L
    if (finalized < 0) return
    val found = mutableListOf<Payment>()
    // How far each account was read: the last final block where every page of
    // it was, else up to the block before the last one read, which may go on.
    val readTo = mutableMapOf<String, Long>()
    accounts.forEachIndexed { i, account ->
      if (!looked.has(account)) return@forEachIndexed
      val start = looked.optLong(account) + 1
      val rows = mutableListOf<JSONObject>()
      var page = data.optJSONObject("a$i")?.optJSONArray("json")
      var pages = 1
      var whole = true
      while (true) {
        val count = page?.length() ?: 0
        for (r in 0 until count) page?.optJSONObject(r)?.let { rows += it }
        if (count < PAGE) break
        if (pages >= PAGES) {
          whole = false
          break
        }
        pages += 1
        val next = Arrivals.graphql(archive, "query { a: moonlightHistory(receiver: \"$account\", fromBlock: $start, toBlock: $finalized, maxCount: $PAGE, pageCount: $pages) { json } }")
        if (next == null) {
          whole = false
          break
        }
        page = next.optJSONObject("a")?.optJSONArray("json")
      }
      val last = rows.maxOfOrNull { it.optLong("block_height", -1L) } ?: -1L
      readTo[account] = if (whole) finalized else maxOf(start - 1, minOf(finalized, last - 1))
      for (row in rows) {
        val hash = row.optString("origin").lowercase()
        val height = row.optLong("block_height", -1L)
        if (!Arrivals.isHash(hash) || height < 0 || height > finalized) continue
        var value = BigInteger.ZERO
        var from = ""
        var memo = ""
        val events = row.optJSONArray("events") ?: continue
        for (e in 0 until events.length()) {
          val event = events.optJSONObject(e) ?: continue
          if (event.optBoolean("reverted") || event.optString("target").lowercase() != TRANSFER || event.optString("topic") != "moonlight") continue
          val d = event.optJSONObject("data") ?: continue
          val sender = d.optString("sender")
          if (d.optString("receiver") != account || sender == account) continue
          value += d.optString("value").toBigIntegerOrNull()?.takeIf { it.signum() > 0 } ?: BigInteger.ZERO
          if (from.isEmpty()) {
            from = sender
            memo = memoText(d.optString("memo"))
          }
        }
        if (value.signum() > 0) found += Payment(account, hash, height, value, from, memo)
      }
    }
    val awayAt = prefs(context).getLong("awayAt", 0L)
    // The newest of all read, each once (a block read again where a page stopped in it).
    val newest = found.distinctBy { it.hash }.sortedBy { it.height }.takeLast(MOST)
    // Not told for want of their blocks' times: looked at again from where it was, the next time.
    if (!inFront && awayAt > 0L && newest.isNotEmpty() && Arrivals.allowed(context) && !tell(context, setup, newest, awayAt)) return
    // Each account looked at as far as it was read, while it's still the one
    // looked for; one not looked at yet, from the last final block on.
    synchronized(this) {
      val now = setup(context) ?: return
      if (now.optString("wallet") != setup.optString("wallet") || now.optString("archiveUrl") != archive) return
      val next = since(context)
      for (account in accountsOf(now)) next.put(account, maxOf(readTo[account] ?: finalized, next.optLong(account, -1L)))
      prefs(context).edit().putString("since", next.toString()).commit()
    }
  }

  // Each payment that came after the app left the screen, by its block's time, told once.
  // False where a block's time couldn't be read: nothing is told, to be told the next time.
  private fun tell(context: Context, setup: JSONObject, payments: List<Payment>, awayAt: Long): Boolean {
    val heights = payments.map { it.height }.distinct()
    val blocks = Arrivals.graphql(setup.optString("archiveUrl"), "query { ${heights.mapIndexed { i, h -> "b$i: block(height: $h) { header { timestamp } }" }.joinToString(" ")} }") ?: return false
    val times = heights.indices.map { blocks.optJSONObject("b$it")?.optJSONObject("header")?.optLong("timestamp", -1L) ?: -1L }
    if (times.any { it < 0 }) return false
    val own = setup.optJSONArray("accounts") ?: JSONArray()
    val names = setup.optJSONObject("names") ?: JSONObject()
    for (payment in payments) {
      val seconds = times[heights.indexOf(payment.height)]
      if (seconds * 1000 < awayAt) continue
      // By the name Activity gives the wallet's own, else its .dusk name, else its short form.
      val ownName = (0 until own.length()).mapNotNull { own.optJSONObject(it) }.firstOrNull { it.optString("account") == payment.from }?.optString("name")
      val name = ownName?.takeIf { it.isNotEmpty() } ?: names.optString(payment.from).takeIf { it.isNotEmpty() }
        ?: if (payment.from.length > 15) "${payment.from.take(6)}…${payment.from.takeLast(6)}" else payment.from
      val title = setup.optString("title").replace("{amount}", dusk(payment.value, setup.optString("decimal", "."), setup.optString("group", ","))).replace("{name}", name)
      // Under it, the payer's memo where it has one, as the page words it (`memoBody`), else the network alone.
      val network = setup.optString("network")
      val memoBody = setup.optString("memoBody")
      val body = if (payment.memo.isNotEmpty() && memoBody.contains("{memo}")) memoBody.replace("{memo}", payment.memo) else network
      // Turned off, or the wallet gone, while the archive answered: nothing told.
      // A locked phone that hides what notices say: "Payment received", no amount, no name.
      synchronized(this) {
        if (setup(context)?.optString("wallet") == setup.optString("wallet")) {
          Arrivals.post(context, title, body, payment.hash, "executed", payment.height, setup.optString("token"), network, payment.account, setup.optString("publicTitle").ifEmpty { "Payment received" })
        }
      }
    }
    return true
  }
}

/**
 * A payment from Send that waits for the network while the app is away: the
 * app signs and sends only while it's open, never in the background, so it
 * goes out once the app's opened again. Kept here by the page (`set`, from
 * src/wallet/localBus.js), while one waits there: the node to ask, the wallet
 * it's from and the notice's words. As the app leaves the screen with one
 * waiting, its notice says it goes out when the app's opened again; once a job
 * finds the network back (its node answers), the notice says to open the
 * wallet to send it. Its title names the amount and whom it's to where the
 * phone shows a notice whole; a locked phone that hides what notices say shows
 * the neutral title (`publicTitle`). Tapping it opens the wallet, which shows
 * the waiting payment; back on the screen, the notice and the job go.
 */
object Waiting {
  private const val PREFS = "dusk-wallet-waiting"
  const val JOB_ID = 7444
  /** The intent's extra a notice's tap carries: its token, made here, the only one taken as this notice's. */
  const val EXTRA = "network.dusk.wallet.WAITING"
  // The notice's own number: one notice, whichever words it has now.
  private const val NOTICE_ID = 7444
  // Waits between looks for the network: often at first, then less.
  private val DELAYS = longArrayOf(5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000)
  // Looked for no longer than this after the app left.
  private const val LOOKED_FOR_MS = 2 * 60 * 60 * 1000L

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun setup(context: Context): JSONObject? =
    try {
      prefs(context).getString("setup", null)?.let { JSONObject(it) }
    } catch (_: Exception) {
      null
    }

  private fun jobs(context: Context) = context.getSystemService(JobScheduler::class.java)

  /**
   * One waits (`next`: `wallet`, `nodeUrl`, `title`, `publicTitle`, `away`
   * and `back`, the notice's words), or none (null): then its notice and the job go. Told
   * while the app's away already, as when its first try ended after it was
   * left, the notice says so then.
   */
  @Synchronized
  fun set(context: Context, next: JSONObject?) {
    val node = next?.optString("nodeUrl") ?: ""
    if (next == null || next.optString("title").isEmpty() || !(node.startsWith("https://") || node.startsWith("http://"))) {
      prefs(context).edit().remove("setup").remove("said").remove("back").remove("tries").commit()
      jobs(context)?.cancel(JOB_ID)
      context.getSystemService(NotificationManager::class.java)?.cancel(NOTICE_ID)
      return
    }
    val token = prefs(context).getString("token", null)?.takeIf { Arrivals.isToken(it) }
      ?: java.util.UUID.randomUUID().toString().replace("-", "")
    prefs(context).edit().putString("setup", next.toString()).putString("token", token).commit()
    if (prefs(context).getLong("awayAt", 0L) > 0L && !prefs(context).getBoolean("said", false)) {
      prefs(context).edit().putBoolean("said", true).putBoolean("back", false).putInt("tries", 0).commit()
      post(context, next, next.optString("away"))
      schedule(context, DELAYS[0])
    }
  }

  /** Whether a tap's `token` is the one this notice carried. */
  fun isOurs(context: Context, token: String): Boolean =
    Arrivals.isToken(token) && prefs(context).getString("token", null) == token

  // The notice, with the words for now: tapping it opens the wallet.
  private fun post(context: Context, setup: JSONObject, body: String) {
    val notices = context.getSystemService(NotificationManager::class.java) ?: return
    if (!Arrivals.allowed(context)) return
    val token = prefs(context).getString("token", "") ?: ""
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      ?.apply { putExtra(EXTRA, token) }
    val tap = open?.let { PendingIntent.getActivity(context, NOTICE_ID, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
    val mark = context.resources.getIdentifier("ic_launcher_foreground", "mipmap", context.packageName)
    val icon = Icon.createWithResource(context, if (mark != 0) mark else context.applicationInfo.icon)
    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) Notification.Builder(context) else {
      if (notices.getNotificationChannel("payments") == null) {
        notices.createNotificationChannel(NotificationChannel("payments", "Payments", NotificationManager.IMPORTANCE_DEFAULT))
      }
      Notification.Builder(context, "payments")
    }
    // Its title names the payment; a locked phone that hides what notices say
    // shows the neutral one, no amount and no one's name, with the same words.
    val publicTitle = setup.optString("publicTitle")
    @Suppress("DEPRECATION")
    val locked = (if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) Notification.Builder(context) else Notification.Builder(context, "payments"))
      .setSmallIcon(icon)
      .setContentTitle(publicTitle)
      .setContentText(body)
      .build()
    val notice = builder
      .setSmallIcon(icon)
      .setContentTitle(setup.optString("title"))
      .setContentText(body)
      .apply {
        if (publicTitle.isEmpty()) setVisibility(Notification.VISIBILITY_PUBLIC)
        else setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(locked)
      }
      .setAutoCancel(true)
      .apply { if (tap != null) setContentIntent(tap) }
      .build()
    notices.notify(NOTICE_ID, notice)
  }

  /**
   * The app left the screen: with a payment waiting, said so, and the network
   * looked for. Said a moment later, once the page has said whether leaving
   * ended it (a wallet that locks as it's left sends nothing).
   */
  @Synchronized
  fun away(context: Context) {
    val at = System.currentTimeMillis()
    prefs(context).edit().putLong("awayAt", at).putBoolean("said", false).putBoolean("back", false).putInt("tries", 0).commit()
    if (setup(context) == null) return
    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
      synchronized(this) {
        val setup = setup(context)
        if (setup != null && prefs(context).getLong("awayAt", 0L) == at && !prefs(context).getBoolean("said", false)) {
          prefs(context).edit().putBoolean("said", true).commit()
          post(context, setup, setup.optString("away"))
          schedule(context, DELAYS[0])
        }
      }
    }, 1_000)
  }

  /** Back on the screen: the wallet shows the payment itself. */
  @Synchronized
  fun front(context: Context) {
    prefs(context).edit().putLong("awayAt", 0L).commit()
    jobs(context)?.cancel(JOB_ID)
    context.getSystemService(NotificationManager::class.java)?.cancel(NOTICE_ID)
  }

  /** A wallet removed (`wallet`), or every one (""): its payment isn't waited on here any more. */
  @Synchronized
  fun forget(context: Context, wallet: String) {
    if (wallet.isEmpty() || setup(context)?.optString("wallet") == wallet) set(context, null)
  }

  private fun schedule(context: Context, delay: Long) {
    val job = JobInfo.Builder(JOB_ID, ComponentName(context, ArrivalJob::class.java))
      .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
      .setMinimumLatency(delay)
      .build()
    try {
      jobs(context)?.schedule(job)
    } catch (_: Exception) {
      // Not scheduled: the notice says what it said as the app left.
    }
  }

  /**
   * The job's look, with a network: once the node answers, the notice says to
   * open the wallet to send it, and the job's done. True to look again later.
   */
  fun check(context: Context): Boolean {
    val (setup, awayAt) = synchronized(this) { Pair(setup(context), prefs(context).getLong("awayAt", 0L)) }
    if (setup == null || awayAt <= 0L || prefs(context).getBoolean("back", false)) return false
    if (System.currentTimeMillis() - awayAt > LOOKED_FOR_MS) return false
    Arrivals.graphql(setup.optString("nodeUrl"), "query { block(height: 0) { header { height } } }") ?: return true
    synchronized(this) {
      // Still away, with the same payment waiting.
      val now = setup(context) ?: return false
      if (prefs(context).getLong("awayAt", 0L) <= 0L || now.optString("wallet") != setup.optString("wallet")) return false
      prefs(context).edit().putBoolean("back", true).commit()
      post(context, now, now.optString("back"))
    }
    return false
  }

  /** Once more, a little later than the last time. */
  @Synchronized
  fun again(context: Context) {
    if (setup(context) == null || prefs(context).getLong("awayAt", 0L) <= 0L) return
    val tries = prefs(context).getInt("tries", 0) + 1
    prefs(context).edit().putInt("tries", tries).commit()
    schedule(context, DELAYS[minOf(tries, DELAYS.size - 1)])
  }
}

/** JobScheduler's jobs: the sends kept looked up, money coming in looked for, and the network for a payment waiting, off the main thread. */
class ArrivalJob : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    Thread {
      if (params.jobId == Waiting.JOB_ID) {
        val again = try {
          Waiting.check(applicationContext)
        } catch (_: Exception) {
          true
        }
        jobFinished(params, false)
        if (again) Waiting.again(applicationContext)
        return@Thread
      }
      if (params.jobId == Incoming.JOB_ID || params.jobId == Incoming.SOON_ID) {
        try {
          Incoming.check(applicationContext)
        } catch (_: Exception) {
          // Looked at again with the next run.
        }
        jobFinished(params, false)
        return@Thread
      }
      val left = try {
        Arrivals.check(applicationContext)
      } catch (_: Exception) {
        true
      }
      jobFinished(params, false)
      // Once it's finished: scheduled while it runs, Android stops it.
      if (left) Arrivals.again(applicationContext)
    }.start()
    return true
  }

  // Stopped before it was done (the network went): Android runs it again.
  override fun onStopJob(params: JobParameters): Boolean = true
}
