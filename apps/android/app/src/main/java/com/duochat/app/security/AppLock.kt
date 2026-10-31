package com.duochat.app.security

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * App lock: fingerprint or face (when the phone has them) or the screen-lock PIN, pattern or password.
 * The system shows the prompt and decides; PrivCord never sees or stores any of it.
 *
 * It keeps other people who pick up an unlocked phone out of the app. It does not replace the encryption
 * of the data on the phone (that key lives in the Android Keystore).
 */
object AppLock {
    /** "Weak" biometrics (face unlock) and the screen lock: the combination every supported Android version accepts. */
    private const val AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL

    /** How long the app may be out of sight before it asks again. */
    const val GRACE_MS = 30_000L

    /** Does this phone have a biometric or a screen lock the prompt can use? */
    fun available(context: Context): Boolean =
        BiometricManager.from(context).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS

    /**
     * Should the app be locked right now? [leftAt] is when the screen last left the foreground (0 = this is a
     * fresh start of the app, which always asks).
     */
    fun shouldLock(enabled: Boolean, available: Boolean, leftAt: Long, now: Long, graceMs: Long = GRACE_MS): Boolean {
        if (!enabled || !available) return false
        if (leftAt == 0L) return true
        return now - leftAt > graceMs
    }

    /** Shows the system prompt. [onResult] gets (true, null) on success, otherwise (false, a readable reason). */
    fun prompt(activity: FragmentActivity, title: String, onResult: (Boolean, String?) -> Unit) {
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onResult(true, null)
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onResult(false, errString.toString())
            // A wrong finger just lets the user try again inside the same prompt: nothing to report.
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setAllowedAuthenticators(AUTHENTICATORS)
            .build()
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info)
    }
}
