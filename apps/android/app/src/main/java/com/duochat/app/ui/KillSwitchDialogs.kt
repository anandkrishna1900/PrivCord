package com.duochat.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.duochat.app.security.KillSwitchMode
import com.duochat.app.security.KillSwitchPlanStep
import com.duochat.app.security.KillSwitchPlans
import com.duochat.app.security.KillSwitchReport
import com.duochat.app.security.KillSwitchScope
import com.duochat.app.security.KillSwitchStepResult
import com.duochat.app.security.StepStatus
import com.duochat.app.security.summarizeReport

/**
 * Emergency deletion dialogs (NUKE DUOCHAT + per-chat options).
 *
 * Renders the shared truthful checklist report: a check = erased, muted text
 * = not applicable on this platform (skipped), red = failed, spinner = not
 * done yet. A partial report is always labeled as partial — never as
 * complete — so the UI cannot lie about deletion.
 */

@Composable
private fun statusColor(status: StepStatus) = when (status) {
    StepStatus.ERASED -> MaterialTheme.colorScheme.primary
    StepStatus.FAILED -> MaterialTheme.colorScheme.error
    StepStatus.SKIPPED -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun StepList(steps: List<KillSwitchPlanStep>, report: KillSwitchReport?) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (step in steps) {
            val result: KillSwitchStepResult? =
                report?.steps?.firstOrNull { it.stepId == step.id }
            Row(verticalAlignment = Alignment.Top) {
                when {
                    result == null -> CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                    )
                    result.status == StepStatus.ERASED -> Icon(
                        Icons.Filled.Check,
                        contentDescription = null,
                        tint = statusColor(result.status),
                        modifier = Modifier.size(16.dp),
                    )
                    else -> Icon(
                        Icons.Filled.Warning,
                        contentDescription = null,
                        tint = statusColor(result.status),
                        modifier = Modifier.size(16.dp),
                    )
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(step.label, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        result?.details ?: step.detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* NUKE DUOCHAT (Settings → Security → Emergency Actions)              */
/* ------------------------------------------------------------------ */

@Composable
fun NukeDialog(
    onDismiss: () -> Unit,
    onRun: () -> Unit,
    report: KillSwitchReport?,
    onDone: () -> Unit,
) {
    val steps = remember {
        KillSwitchPlans.planSteps(KillSwitchScope.APPLICATION, KillSwitchMode.LOCAL_ONLY)
    }
    var understood by remember { mutableStateOf(false) }
    var armed by remember { mutableStateOf("") }
    var launched by remember { mutableStateOf(false) }
    // Progress is only present once the executor persisted its first report;
    // between pressing the button and that point show a spinner.
    val running = launched && (report == null || report.finishedAt == null)
    val finished = launched && report != null && report.finishedAt != null

    Dialog(onDismissRequest = { if (!running) onDismiss() }) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(24.dp),
            color = MaterialTheme.colorScheme.surface,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.Warning,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(22.dp),
                    )
                    Spacer(Modifier.width(10.dp))
                    Text(
                        "NUKE DUOCHAT",
                        style = MaterialTheme.typography.headlineSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "This action permanently deletes the local DuoChat identity, " +
                        "conversations, contacts, files, cryptographic state, and " +
                        "application data. You will need your separately backed-up " +
                        "12-word recovery phrase to restore your identity.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "Deletion never affects the other person's device, screenshots, " +
                        "exports, or external backups.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
                Spacer(Modifier.height(12.dp))

                Text("What gets erased on this device:", style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(6.dp))
                StepList(steps, if (launched) report else null)

                when {
                    !launched -> {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = understood, onCheckedChange = { understood = it })
                            Text(
                                "I understand this is irreversible on this device and that " +
                                    "remote data and copies already received cannot be deleted.",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = onDismiss) { Text("Cancel") }
                            Button(
                                onClick = { launched = true; onRun() },
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = MaterialTheme.colorScheme.error,
                                ),
                                enabled = understood,
                            ) { Text("ARM ERASE") }
                        }
                    }
                    !finished -> {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                            Text(
                                "Erasing… keep this screen open until the report is finished.",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                    else -> {
                        val summary = summarizeReport(report!!)
                        if (summary.complete) {
                            Text(
                                "Erase finished. Everything DuoChat could remove on this " +
                                    "device was removed.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        } else {
                            Text(
                                "Partial erase. Red steps could not be deleted; the erase can " +
                                    "be re-run after signing in again.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.error,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        Spacer(Modifier.height(8.dp))
                        Button(onClick = onDone) {
                            Text(if (summary.complete) "Done — return to sign in" else "Close")
                        }
                    }
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* Per-conversation: Conversation → Menu → Security → Clear Everything */
/* ------------------------------------------------------------------ */

@Composable
fun ClearChatDialog(
    onDismiss: () -> Unit,
    onRun: (DeleteChatMode) -> Unit,
    report: KillSwitchReport?,
    onDone: () -> Unit,
) {
    val stepsMode = remember {
        KillSwitchPlans.planSteps(
            KillSwitchScope.CONVERSATION,
            KillSwitchMode.LOCAL_PLUS_SESSION_STATE,
        )
    }
    var selection by remember { mutableStateOf(DeleteChatMode.CLEAR_ONLY) }
    var understood by remember { mutableStateOf(false) }
    var confirmation by remember { mutableStateOf(false) }
    var launched by remember { mutableStateOf(false) }
    val mode = when (selection) {
        DeleteChatMode.CLEAR_ONLY -> KillSwitchMode.LOCAL_ONLY
        DeleteChatMode.CLEAR_AND_SESSION -> KillSwitchMode.LOCAL_PLUS_SESSION_STATE
    }
    val running = launched && (report == null || report.finishedAt == null)
    val finished = launched && report != null && report.finishedAt != null

    Dialog(onDismissRequest = { if (!running) onDismiss() }) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(24.dp),
            color = MaterialTheme.colorScheme.surface,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
            ) {
                Text(
                    "Clear Everything",
                    style = MaterialTheme.typography.headlineSmall,
                )
                Text(
                    "Emergency deletion for this conversation only. Your global identity " +
                        "keys stay; other conversations are not affected. The remote side " +
                        "keeps its copy — no app can delete that.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
                Spacer(Modifier.height(6.dp))

                if (!launched) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(
                            selected = selection == DeleteChatMode.CLEAR_ONLY,
                            onClick = { selection = DeleteChatMode.CLEAR_ONLY },
                        )
                        Column(Modifier.weight(1f)) {
                            Text(
                                "CLEAR LOCAL CHAT",
                                style = MaterialTheme.typography.titleSmall,
                            )
                            Text(
                                "Deletes every local message, delivery record, and draft " +
                                    "for this conversation. The contact stays in the list; " +
                                    "the encryption session is kept.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(
                            selected = selection == DeleteChatMode.CLEAR_AND_SESSION,
                            onClick = { selection = DeleteChatMode.CLEAR_AND_SESSION },
                        )
                        Column(Modifier.weight(1f)) {
                            Text(
                                "DELETE CHAT AND LOCAL SESSION STATE",
                                style = MaterialTheme.typography.titleSmall,
                            )
                            Text(
                                "Everything from CLEAR LOCAL CHAT, plus this conversation's " +
                                    "session trust state on this device. Future communication " +
                                    "requires a new secure-session handshake first.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (selection == DeleteChatMode.CLEAR_AND_SESSION) {
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                "Group safety: this deletes only this device's local group " +
                                    "state. Other members' devices and their membership stay " +
                                    "byte-identical. A new subject handshake may be needed " +
                                    "before the next exchange.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(10.dp),
                            )
                        }
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(top = 6.dp),
                    ) {
                        Checkbox(checked = understood, onCheckedChange = { understood = it })
                        Text(
                            "I understand that only local data is deleted and that " +
                                "screenshots and exports cannot be deleted.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (!confirmation) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = onDismiss) { Text("Cancel") }
                            Button(
                                onClick = { confirmation = true },
                                enabled = understood,
                            ) { Text("Continue") }
                        }
                    } else {
                        Text(
                            "Final confirmation: press the button to erase. Cancel leaves " +
                                "everything intact.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { confirmation = false }) { Text("Back") }
                            Button(
                                onClick = { launched = true; onRun(selection) },
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = MaterialTheme.colorScheme.error,
                                ),
                            ) {
                                Text(
                                    if (selection == DeleteChatMode.CLEAR_ONLY) {
                                        "CLEAR LOCAL CHAT"
                                    } else {
                                        "DELETE CHAT AND LOCAL SESSION STATE"
                                    },
                                )
                            }
                        }
                    }
                } else {
                    StepList(stepsMode.filter { step ->
                        !running || step.id != "conv.session.erase" || mode == KillSwitchMode.LOCAL_PLUS_SESSION_STATE
                    }, if (launched) report else null)
                    when {
                        !finished -> {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                                Text(
                                    "Erasing… keep this screen open until the report is finished.",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                        else -> {
                            val summary = summarizeReport(report!!)
                            if (summary.complete) {
                                Text(
                                    "Erase finished. The conversation was removed from this device.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            } else {
                                Text(
                                    "Partial erase. Red steps could not be deleted; open the " +
                                        "menu and re-run the erase.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.error,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                            Spacer(Modifier.height(8.dp))
                            Button(onClick = onDone) { Text("Close") }
                        }
                    }
                }
            }
        }
    }
}

enum class DeleteChatMode { CLEAR_ONLY, CLEAR_AND_SESSION }
