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

/** Backup passphrases: at least this long (the engine refuses shorter ones too). */
private const val MIN_PASS = 12

/**
 * Encrypted backup of chats, groups, photos and files to a file you choose, and automatic weekly backups to a folder.
 * For a one-off backup the passphrase is never stored; for automatic ones it is kept on the phone, Keystore-encrypted.
 */
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
            "Save your chats, groups, photos and files (the newest 50 MB) to a file, locked with a passphrase you " +
                "choose (at least $MIN_PASS characters). Restoring adds what is missing; it never overwrites newer " +
                "messages. Your recovery phrase is not in the backup: keep your 12 words too.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        DuoTextField(
            value = pass, onValueChange = { pass = it }, label = { Text("Backup passphrase") },
            visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        Row {
            OutlinedButton(enabled = pass.length >= MIN_PASS, onClick = {
                onExport(pass) { r -> r.onSuccess { pendingText = it; saver.launch("privcord-backup.txt") }.onFailure { status = it.message ?: "Could not create the backup." } }
            }) { Text("Save backup") }
            Spacer(Modifier.width(8.dp))
            OutlinedButton(enabled = pass.length >= MIN_PASS, onClick = { opener.launch(arrayOf("*/*")) }) { Text("Restore") }
        }
        status?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth()) }
        Spacer(Modifier.height(16.dp))
        AutomaticBackups(pass, onExport)
    }
}

/** Weekly backups to a folder, made with nobody there (the passphrase typed above is kept, Keystore-encrypted). */
@Composable
private fun AutomaticBackups(pass: String, onExport: (String, (Result<String>) -> Unit) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var folder by remember { mutableStateOf(com.duochat.app.data.AutoBackup.folder(context)) }
    var note by remember { mutableStateOf<String?>(null) }
    val export: suspend (String) -> Result<String> = { p ->
        kotlinx.coroutines.suspendCancellableCoroutine { cont -> onExport(p) { r -> if (cont.isActive) cont.resumeWith(Result.success(r)) } }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        runCatching { com.duochat.app.data.AutoBackup.enable(context, uri, pass) }
            .onSuccess {
                folder = uri
                scope.launch {
                    val ok = com.duochat.app.data.AutoBackup.runIfDue(context, export, force = true)
                    note = if (ok == true) "Automatic backups are on. The first one is saved." else com.duochat.app.data.AutoBackup.lastError(context)
                }
            }
            .onFailure { note = "That folder can't be used. Choose another one." }
    }
    Text("Automatic backups", style = MaterialTheme.typography.titleSmall)
    val current = folder
    if (current == null) {
        Text(
            "Once a week, save a backup to a folder you choose (on this phone, an SD card, or a synced cloud folder). " +
                "Uses the passphrase above, which is then kept on this phone, encrypted. The three newest are kept.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        OutlinedButton(enabled = pass.length >= MIN_PASS, onClick = { picker.launch(null) }) { Text("Choose folder and turn on") }
    } else {
        val last = com.duochat.app.data.AutoBackup.lastAt(context)
        Text(
            if (last > 0) "On. Last backup: " + java.text.DateFormat.getDateTimeInstance().format(java.util.Date(last)) else "On. No backup yet.",
            style = MaterialTheme.typography.bodySmall,
        )
        com.duochat.app.data.AutoBackup.lastError(context)?.let {
            Text("Last try failed: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        Spacer(Modifier.height(8.dp))
        Row {
            OutlinedButton(onClick = {
                scope.launch {
                    val ok = com.duochat.app.data.AutoBackup.runIfDue(context, export, force = true)
                    note = if (ok == true) "Backup saved." else com.duochat.app.data.AutoBackup.lastError(context)
                }
            }) { Text("Back up now") }
            Spacer(Modifier.width(8.dp))
            OutlinedButton(onClick = { com.duochat.app.data.AutoBackup.disable(context); folder = null; note = "Automatic backups are off." }) { Text("Turn off") }
        }
    }
    note?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.fillMaxWidth()) }
}
