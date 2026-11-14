// Arrival notices on the phone (src/shared/phoneNotices.js): Android's
// question for leave to show them, asked only when the person taps Tell me
// when it arrives, a payment's notice once they may show, the sends to look
// for once the app leaves the screen (ArrivalJob.kt), forgotten with their
// wallet, the accounts to look at for money coming in (`incoming`), and the
// transaction a notice's tap opened the app on.
//
// Copied into the generated Android project by build.rs, as the icon is, and
// registered by src/android.rs as the plugin "dusk-notices". Each command
// answers and never rejects.

package network.dusk.wallet

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class NoticeArgs {
  var title: String = ""
  var body: String = ""
  var publicBody: String = ""
  var hash: String = ""
  var token: String = ""
}

@InvokeArg
class WatchArgs {
  var hash: String = ""
  var nodeUrl: String = ""
  var title: String = ""
  var failTitle: String = ""
  var body: String = ""
  var publicBody: String = ""
  var wallet: String = ""
  var token: String = ""
}

@InvokeArg
class IncomingArgs {
  // What to look for, as JSON (ArrivalJob.kt's Incoming.watch): "" for nothing.
  var setup: String = ""
}

@InvokeArg
class ForgetArgs {
  // The wallet whose sends are forgotten: "" for every wallet's.
  var wallet: String = ""
}

@TauriPlugin(permissions = [Permission(strings = ["android.permission.POST_NOTIFICATIONS"], alias = "notices")])
class NoticesPlugin(private val activity: Activity) : Plugin(activity) {
  // The transaction a notice's tap opened the app on, till the page takes it,
  // with what its notice knew of it: its outcome and its block, where known,
  // and its send's token. Any app can open the wallet with these extras: the
  // page takes them as a notice's only with the token kept with that send.
  private var opened = ""
  private var openedOutcome = ""
  private var openedBlock = 0L
  private var openedToken = ""
  private var openedAccount = ""
  // Its token, the one this app's notice carried: checked here, for the page to open it at once.
  private var openedOurs = false

  private fun answer(invoke: Invoke, allowed: Boolean) {
    val out = JSObject()
    out.put("allowed", allowed)
    invoke.resolve(out)
  }

  private fun take(intent: Intent?) {
    val hash = intent?.getStringExtra(Arrivals.EXTRA_TX) ?: return
    val outcome = intent.getStringExtra(Arrivals.EXTRA_OUTCOME) ?: ""
    val block = intent.getLongExtra(Arrivals.EXTRA_BLOCK, 0L)
    val token = intent.getStringExtra(Arrivals.EXTRA_TOKEN) ?: ""
    val account = intent.getStringExtra(Arrivals.EXTRA_ACCOUNT) ?: ""
    intent.removeExtra(Arrivals.EXTRA_TX)
    intent.removeExtra(Arrivals.EXTRA_OUTCOME)
    intent.removeExtra(Arrivals.EXTRA_BLOCK)
    intent.removeExtra(Arrivals.EXTRA_TOKEN)
    intent.removeExtra(Arrivals.EXTRA_ACCOUNT)
    // No notice's without a transaction's ID and a token as the wallet writes them.
    if (!Arrivals.isHash(hash) || !Arrivals.isToken(token)) return
    opened = hash
    openedOutcome = if (outcome == "executed" || outcome == "failed") outcome else ""
    openedBlock = if (block > 0L) block else 0L
    openedToken = token
    openedAccount = if (account.length <= 200) account else ""
    openedOurs = Arrivals.isOurs(activity.applicationContext, hash, token, openedAccount)
  }

  // Started by a notice's tap, or brought back by one.
  override fun load(webView: WebView) {
    take(activity.intent)
    Incoming.front(activity.applicationContext)
  }

  override fun onNewIntent(intent: Intent) {
    take(intent)
  }

  // Off the screen: Android cuts the page's network soon, so a send still on
  // its way is looked for by the job.
  override fun onStop() {
    Arrivals.away(activity.applicationContext)
  }

  // Back on the screen: money coming in shows there, not as a notice.
  override fun onResume() {
    Incoming.front(activity.applicationContext)
  }

  /** Whether notices may show. */
  @Command
  fun status(invoke: Invoke) {
    answer(invoke, Arrivals.allowed(activity))
  }

  /** Android's question, where it has one to ask: Android 13 and later. */
  @Command
  fun ask(invoke: Invoke) {
    if (Arrivals.allowed(activity) || Build.VERSION.SDK_INT < 33 || getPermissionState("notices") == PermissionState.GRANTED) {
      answer(invoke, Arrivals.allowed(activity))
      return
    }
    requestPermissionForAlias("notices", invoke, "asked")
  }

  @PermissionCallback
  private fun asked(invoke: Invoke) {
    answer(invoke, Arrivals.allowed(activity))
  }

  /** A payment's notice, once for its transaction (`hash`); tapping it opens the wallet on it. */
  @Command
  fun notify(invoke: Invoke) {
    val args = invoke.parseArgs(NoticeArgs::class.java)
    answer(invoke, Arrivals.post(activity.applicationContext, args.title, args.body, args.hash, token = args.token, publicBody = args.publicBody))
  }

  /** A send to look for once the app leaves the screen, with its notice for either outcome. */
  @Command
  fun watch(invoke: Invoke) {
    val args = invoke.parseArgs(WatchArgs::class.java)
    Arrivals.watch(activity.applicationContext, args.hash, args.nodeUrl, args.title, args.failTitle, args.body, args.wallet, args.token, args.publicBody)
    answer(invoke, Arrivals.allowed(activity))
  }

  /** A wallet removed, or every one reset or restored (""): none of its sends looked for or told. */
  @Command
  fun forget(invoke: Invoke) {
    val args = invoke.parseArgs(ForgetArgs::class.java)
    Arrivals.forget(activity.applicationContext, args.wallet)
    Incoming.forget(activity.applicationContext, args.wallet)
    answer(invoke, Arrivals.allowed(activity))
  }

  /** The accounts to look at for money coming in, and the notice's words: none ("") for nothing. */
  @Command
  fun incoming(invoke: Invoke) {
    val args = invoke.parseArgs(IncomingArgs::class.java)
    val setup = try {
      if (args.setup.isEmpty()) null else org.json.JSONObject(args.setup)
    } catch (_: Exception) {
      null
    }
    Incoming.watch(activity.applicationContext, setup)
    answer(invoke, Arrivals.allowed(activity))
  }

  /** A send the page heard the outcome of: not looked for any more. */
  @Command
  fun settled(invoke: Invoke) {
    val args = invoke.parseArgs(NoticeArgs::class.java)
    Arrivals.settled(activity.applicationContext, args.hash)
    answer(invoke, Arrivals.allowed(activity))
  }

  /**
   * The transaction a notice's tap opened the app on, once: "" for none; with
   * what its notice knew of it, "executed" or "failed" ("" where it didn't
   * say), its block (0 where it didn't say), and the token it carried, which
   * the page checks against its send's before it takes any of it.
   */
  @Command
  fun opened(invoke: Invoke) {
    val out = JSObject()
    out.put("allowed", Arrivals.allowed(activity))
    out.put("hash", opened)
    out.put("outcome", openedOutcome)
    out.put("block", openedBlock)
    out.put("token", openedToken)
    out.put("account", openedAccount)
    out.put("ours", openedOurs)
    opened = ""
    openedOutcome = ""
    openedBlock = 0L
    openedToken = ""
    openedAccount = ""
    openedOurs = false
    invoke.resolve(out)
  }
}
