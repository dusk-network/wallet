// Fingerprint unlock: the wallet's password, kept only encrypted under an
// Android Keystore key that opens for a fresh fingerprint and for nothing else.
//
// The key is AES-256-GCM in the Keystore, made to need a strong biometric for
// every use (a CryptoObject bound to BiometricPrompt), and Android throws it
// away when the phone's fingerprints change. What's kept in the app's data is
// the password encrypted with it, and its IV: nothing there opens the vault
// without a fingerprint. Android 11 and later (BIOMETRIC_STRONG).
//
// Copied into the generated Android project by build.rs, as the icon is, and
// registered by src/android.rs as the plugin "dusk-keystore". Each command
// answers { ok, ... } and never rejects: `reason` says why not.

package network.dusk.wallet

import android.app.Activity
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class PromptArgs {
  var title: String = "Unlock your wallet"
  var cancel: String = "Use password"
}

@InvokeArg
class EnableArgs {
  var secret: String = ""
  var title: String = "Unlock with fingerprint"
  var cancel: String = "Cancel"
}

@TauriPlugin
class KeystorePlugin(private val activity: Activity) : Plugin(activity) {
  private val alias = "dusk-wallet-fingerprint"
  private val prefs = activity.getSharedPreferences("dusk-wallet-fingerprint", Context.MODE_PRIVATE)

  private fun answer(invoke: Invoke, ok: Boolean, reason: String? = null, secret: String? = null) {
    val out = JSObject()
    out.put("ok", ok)
    if (reason != null) out.put("reason", reason)
    if (secret != null) out.put("secret", secret)
    invoke.resolve(out)
  }

  // A strong biometric enrolled on Android 11 or later: what can guard the key.
  private fun available(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
    val manager = activity.getSystemService(BiometricManager::class.java) ?: return false
    return manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun forget() {
    prefs.edit().remove("iv").remove("secret").commit()
    try {
      keyStore().deleteEntry(alias)
    } catch (_: Exception) {
    }
  }

  private fun newKey(): SecretKey {
    forget()
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        // Each use takes a fingerprint, bound to that use: no time window.
        .setUserAuthenticationRequired(true)
        .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        // A fingerprint added later can't open what this one guarded.
        .setInvalidatedByBiometricEnrollment(true)
        .build()
    )
    return generator.generateKey()
  }

  private fun cipher(): Cipher = Cipher.getInstance("AES/GCM/NoPadding")

  // BiometricPrompt over `cipher`; `done` gets the cipher it unlocked, or null
  // with why not: "password" for the person's own choice, else "error".
  private fun prompt(cipher: Cipher, title: String, cancel: String, done: (Cipher?, String?) -> Unit) {
    activity.runOnUiThread {
      var answered = false
      val once = { c: Cipher?, reason: String? ->
        if (!answered) {
          answered = true
          done(c, reason)
        }
      }
      val executor = activity.mainExecutor
      val prompt = BiometricPrompt.Builder(activity)
        .setTitle(title)
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .setNegativeButton(cancel, executor) { _, _ -> once(null, "password") }
        .build()
      prompt.authenticate(
        BiometricPrompt.CryptoObject(cipher),
        CancellationSignal(),
        executor,
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            once(result.cryptoObject?.cipher, null)
          }

          override fun onAuthenticationError(code: Int, message: CharSequence) {
            val chose = code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED || code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
            once(null, if (chose) "password" else "error")
          }
        }
      )
    }
  }

  /** Whether fingerprint unlock can be had here, and whether it's on. */
  @Command
  fun status(invoke: Invoke) {
    val out = JSObject()
    out.put("ok", true)
    out.put("available", available())
    out.put("on", prefs.contains("secret"))
    invoke.resolve(out)
  }

  /** Turns it on: `secret`, the password, encrypted under a new key, after a fingerprint. */
  @Command
  fun enable(invoke: Invoke) {
    val args = invoke.parseArgs(EnableArgs::class.java)
    if (!available()) return answer(invoke, false, "unavailable")
    if (args.secret.isEmpty()) return answer(invoke, false, "error")
    val encrypt = try {
      cipher().apply { init(Cipher.ENCRYPT_MODE, newKey()) }
    } catch (_: Exception) {
      forget()
      return answer(invoke, false, "error")
    }
    prompt(encrypt, args.title, args.cancel) { done, reason ->
      if (done == null) {
        forget()
        answer(invoke, false, reason)
      } else {
        try {
          val sealed = done.doFinal(args.secret.toByteArray(Charsets.UTF_8))
          prefs.edit()
            .putString("iv", Base64.encodeToString(done.iv, Base64.NO_WRAP))
            .putString("secret", Base64.encodeToString(sealed, Base64.NO_WRAP))
            .commit()
          answer(invoke, true)
        } catch (_: Exception) {
          forget()
          answer(invoke, false, "error")
        }
      }
    }
  }

  /** The password back, after a fingerprint; "invalidated" once the phone's fingerprints changed. */
  @Command
  fun unlock(invoke: Invoke) {
    val args = invoke.parseArgs(PromptArgs::class.java)
    val iv = prefs.getString("iv", null)
    val sealed = prefs.getString("secret", null)
    if (iv == null || sealed == null) return answer(invoke, false, "off")
    if (!available()) return answer(invoke, false, "unavailable")
    val decrypt = try {
      val key = keyStore().getKey(alias, null) as? SecretKey
      if (key == null) {
        forget()
        return answer(invoke, false, "invalidated")
      }
      cipher().apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))) }
    } catch (_: KeyPermanentlyInvalidatedException) {
      forget()
      return answer(invoke, false, "invalidated")
    } catch (_: Exception) {
      return answer(invoke, false, "error")
    }
    prompt(decrypt, args.title, args.cancel) { done, reason ->
      if (done == null) {
        answer(invoke, false, reason)
      } else {
        try {
          answer(invoke, true, secret = String(done.doFinal(Base64.decode(sealed, Base64.NO_WRAP)), Charsets.UTF_8))
        } catch (_: Exception) {
          answer(invoke, false, "error")
        }
      }
    }
  }

  /** Turns it off: the key and what it guarded, gone. */
  @Command
  fun disable(invoke: Invoke) {
    forget()
    answer(invoke, true)
  }
}
