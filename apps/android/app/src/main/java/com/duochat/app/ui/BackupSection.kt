package com.duochat.app.ui

import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Encrypted backup of chats and groups to a file you choose; the passphrase is never stored. */
@Composable
fun BackupSection(
    onExport: (String, (Result<String>) -> Unit) -> Unit,
    onImport: (String, String, (Result<String>) -> Unit) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pass by remember { mutableStateOf("") }
    var pendingText by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri: Uri? ->
        val text = pendingText; pendingText = null
        if (uri != null && text != null) scope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { context.contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) } ?: error("no stream") }.isSuccess
            }
            status = if (ok) "Backup saved." else "Could not save the backup."
        }
    }
    val opener = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val text = withContext(Dispatchers.IO) {
                runCatching { context.contentResolver.openInputStream(uri)?.use { String(it.readBytes()) } }.getOrNull()
            }
            if (text == null) { status = "Could not read that file."; return@launch }
            onImport(text, pass) { r -> status = r.fold({ it }, { it.message ?: "Could not restore." }) }
        }
    }
    Column(Modifier.fillMaxWidth()) {
        Text(
            "Save your chats and groups to a file, locked with a passphrase you choose (at least 8 characters). " +
                "Restoring adds what is missing; it never overwrites newer messages. Your recovery phrase is not in the backup.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = pass, onValueChange = { pass = it }, label = { Text("Backup passphrase") },
            visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        Row {
            OutlinedButton(enabled = pass.length >= 8, onClick = {
                onExport(pass) { r -> r.onSuccess { pendingText = it; saver.launch("privcord-backup.txt") }.onFailure { status = it.message ?: "Could not create the backup." } }
            }) { Text("Save backup") }
            Spacer(Modifier.width(8.dp))
            OutlinedButton(enabled = pass.length >= 8, onClick = { opener.launch(arrayOf("*/*")) }) { Text("Restore") }
        }
        status?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth()) }
    }
}
