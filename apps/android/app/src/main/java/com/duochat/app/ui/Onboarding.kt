package com.duochat.app.ui

import android.app.Activity
import android.view.WindowManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.duochat.app.security.Bip39

private enum class Step { INTRO, SHOW, CONFIRM, RESTORE }

/**
 * First run: the 12-word recovery phrase is mandatory. There is no skip: the chat does not open until an
 * identity exists, either from a new phrase (shown once, two words re-entered) or from an existing one.
 */
@Composable
fun OnboardingScreen(onCreate: (phrase: String, passphrase: String, onResult: (Result<Unit>) -> Unit) -> Unit) {
    var step by remember { mutableStateOf(Step.INTRO) }
    var phrase by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // The recovery phrase is shown on this screen: block screenshots and the recent-apps thumbnail.
    val context = LocalContext.current
    DisposableEffect(Unit) {
        val window = (context as? Activity)?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }

    fun finish(words: String, passphrase: String) {
        busy = true
        error = null
        onCreate(words, passphrase) { result ->
            busy = false
            error = result.exceptionOrNull()?.message
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier.statusBarsPadding().padding(24.dp).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(Icons.Filled.Shield, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(40.dp))
            Spacer(Modifier.height(8.dp))
            Text("DuoChat", style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(16.dp))
            when (step) {
                Step.INTRO -> {
                    Text("Your identity is a 12-word phrase", style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "There are no accounts. These 12 words create your identity and restore it on a new phone " +
                            "or after a wipe. DuoChat never stores them and cannot show them again.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(20.dp))
                    Button(
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            phrase = Bip39.generate()
                            step = Step.SHOW
                        },
                    ) { Text("Create a new identity") }
                    TextButton(onClick = { step = Step.RESTORE }) { Text("I already have a phrase") }
                }

                Step.SHOW -> ShowPhrase(phrase, onBack = { step = Step.INTRO }, onNext = { step = Step.CONFIRM })

                Step.CONFIRM -> ConfirmPhrase(phrase, busy, error, onBack = { step = Step.SHOW }) { finish(phrase, "") }

                Step.RESTORE -> RestorePhrase(busy, error, onBack = { step = Step.INTRO }) { words, pass -> finish(words, pass) }
            }
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ShowPhrase(phrase: String, onBack: () -> Unit, onNext: () -> Unit) {
    var saved by remember { mutableStateOf(false) }
    Text("Write these 12 words down, in order", style = MaterialTheme.typography.titleLarge)
    Spacer(Modifier.height(8.dp))
    Text(
        "Keep them offline and never share them. Anyone with these words is you; without them a lost phone " +
            "cannot be recovered.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(14.dp))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        phrase.split(' ').forEachIndexed { index, word ->
            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                Text(
                    "${index + 1}. $word",
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
    Spacer(Modifier.height(14.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = saved, onCheckedChange = { saved = it })
        Text("I wrote the 12 words down", style = MaterialTheme.typography.bodyMedium)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onBack) { Text("Back") }
        Button(onClick = onNext, enabled = saved) { Text("Continue") }
    }
}

@Composable
private fun ConfirmPhrase(phrase: String, busy: Boolean, error: String?, onBack: () -> Unit, onDone: () -> Unit) {
    val words = phrase.split(' ')
    // Two fixed random positions, one from each half, so a screenshot of the first half is not enough.
    val picks = remember(phrase) { listOf((0..5).random(), (6..11).random()) }
    var first by remember { mutableStateOf("") }
    var second by remember { mutableStateOf("") }
    var wrong by remember { mutableStateOf(false) }
    Text("Confirm your phrase", style = MaterialTheme.typography.titleLarge)
    Spacer(Modifier.height(8.dp))
    Text("Type the words you wrote down.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(12.dp))
    OutlinedTextField(first, { first = it; wrong = false }, label = { Text("Word #${picks[0] + 1}") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(second, { second = it; wrong = false }, label = { Text("Word #${picks[1] + 1}") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    (if (wrong) "One or both words do not match your phrase. Check and try again." else error)?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
    Spacer(Modifier.height(12.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onBack, enabled = !busy) { Text("Back") }
        Button(
            enabled = !busy && first.isNotBlank() && second.isNotBlank(),
            onClick = {
                if (first.trim().lowercase() == words[picks[0]] && second.trim().lowercase() == words[picks[1]]) onDone() else wrong = true
            },
        ) { Text(if (busy) "Creating…" else "Create identity") }
    }
}

@Composable
private fun RestorePhrase(busy: Boolean, error: String?, onBack: () -> Unit, onDone: (String, String) -> Unit) {
    var words by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    Text("Restore your identity", style = MaterialTheme.typography.titleLarge)
    Spacer(Modifier.height(8.dp))
    Text(
        "Enter your 12 words. The same phrase gives the same identity on every device, so your paired friend still recognizes you.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(12.dp))
    OutlinedTextField(words, { words = it; problem = null }, label = { Text("12-word recovery phrase") }, minLines = 3, modifier = Modifier.fillMaxWidth())
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(pass, { pass = it }, label = { Text("Passphrase (only if you set one)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    (problem ?: error)?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
    Spacer(Modifier.height(12.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onBack, enabled = !busy) { Text("Back") }
        Button(
            enabled = !busy && words.isNotBlank(),
            onClick = {
                val message = Bip39.validate(words)
                if (message != null) problem = message else onDone(words, pass)
            },
        ) { Text(if (busy) "Restoring…" else "Restore") }
    }
}
