package com.duochat.app.security

import android.content.Context
import com.duochat.app.data.local.DuoDatabase
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android kill switch: ordered checklist execution with a truthful report.
 *
 * Mirrors the shared kill-switch contract from the protocol package
 * (packages/protocol/src/killswitch.ts — keep the step ids in sync):
 * every step of the plan must be answered exactly once. A step that has no
 * counterpart on this platform is answered 'skipped' with a reason, NEVER
 * dropped, and any failure keeps the report partial so the UI can honestly
 * say what remains.
 *
 * Truth rules (docs/EMERGENCY_DELETION.md):
 *  - 'complete' only if every plan step answered and none failed,
 *  - no forensic-wipe claims; flash remnants, OS-managed caches, backups,
 *    screenshots and remote devices are out of scope and documented,
 *  - the in-progress report is persisted between steps so an interrupted run
 *    can resume without re-erasing what is already gone.
 */

enum class KillSwitchScope { APPLICATION, CONVERSATION }
enum class KillSwitchMode { LOCAL_ONLY, LOCAL_PLUS_SESSION_STATE }
enum class StepStatus { ERASED, SKIPPED, FAILED }

data class KillSwitchPlanStep(val id: String, val label: String, val detail: String)

data class KillSwitchStepResult(
    val stepId: String,
    val status: StepStatus,
    val details: String? = null,
)

data class KillSwitchReport(
    val scope: KillSwitchScope,
    val mode: KillSwitchMode,
    val startedAt: Long,
    var finishedAt: Long?,
    val steps: MutableList<KillSwitchStepResult> = mutableListOf(),
)

object KillSwitchPlans {
    val APP: List<KillSwitchPlanStep> = listOf(
        KillSwitchPlanStep(
            "network.shutdown",
            "Disconnect networking",
            "WebRTC peers, signaling listeners, and sync jobs stop; nothing is sent or received anymore.",
        ),
        KillSwitchPlanStep(
            "services.stop",
            "Stop background services",
            "Message reception stops, including channels and Bluetooth mesh relaying.",
        ),
        KillSwitchPlanStep(
            "transfers.cancel",
            "Cancel transfers",
            "Active and queued file transfers are cancelled.",
        ),
        KillSwitchPlanStep(
            "messages.erase",
            "Erase conversations and messages",
            "Every conversation, message, and delivery record is deleted from the local database.",
        ),
        KillSwitchPlanStep(
            "contacts.erase",
            "Erase contacts and trust records",
            "The pinned contact key is deleted from this device.",
        ),
        KillSwitchPlanStep(
            "attachments.erase",
            "Erase files and media",
            "Downloaded attachments, thumbnails, and temporary transfer files are deleted.",
        ),
        KillSwitchPlanStep(
            "queues.erase",
            "Erase queues and caches",
            "Outgoing and incoming queues plus app-managed caches are deleted.",
        ),
        KillSwitchPlanStep(
            "keys.erase",
            "Erase cryptographic state",
            "Identity and local encryption keys are deleted from the Android Keystore (crypto-erasure).",
        ),
        KillSwitchPlanStep(
            "database.erase",
            "Erase local database",
            "The SQLite database file and app-managed caches/temp files are deleted.",
        ),
        KillSwitchPlanStep(
            "settings.erase",
            "Erase settings and reset app",
            "App settings are cleared and the app returns to the sign-in (onboarding) screen.",
        ),
    )

    val CONVERSATION: List<KillSwitchPlanStep> = listOf(
        KillSwitchPlanStep(
            "conv.transfers.cancel",
            "Cancel transfers in this chat",
            "Active and queued transfers for this conversation are cancelled.",
        ),
        KillSwitchPlanStep(
            "conv.messages.erase",
            "Erase this chat locally",
            "Local messages and queued rows for this conversation are deleted; other chats are untouched.",
        ),
        KillSwitchPlanStep(
            "conv.session.erase",
            "Erase chat session state",
            "Only with 'Delete chat and local session state': future messages require a new identity handshake.",
        ),
    )

    /** Steps claimed for a scope+mode; Option A omits the session erase. */
    fun claimed(scope: KillSwitchScope, mode: KillSwitchMode): List<KillSwitchPlanStep> =
        if (scope == KillSwitchScope.APPLICATION) {
            APP
        } else {
            CONVERSATION.filter { !(it.id == "conv.session.erase" && mode == KillSwitchMode.LOCAL_ONLY) }
        }

    fun planSteps(scope: KillSwitchScope, mode: KillSwitchMode): List<KillSwitchPlanStep> =
        claimed(scope, mode)
}

/** Truthful summarization — see protocol killswitch.summarizeReport. */
data class KillSwitchSummary(
    val complete: Boolean,
    val partial: Boolean,
    val failedStepIds: List<String>,
    val skippedStepIds: List<String>,
)

fun summarizeReport(report: KillSwitchReport): KillSwitchSummary {
    val failed = report.steps.filter { it.status == StepStatus.FAILED }.map { it.stepId }
    val skipped = report.steps.filter { it.status == StepStatus.SKIPPED }.map { it.stepId }
    val claimed = KillSwitchPlans.claimed(report.scope, report.mode).map { it.id }
    val unclaimed = claimed.filter { id -> report.steps.none { result -> result.stepId == id } }
    return KillSwitchSummary(
        complete = failed.isEmpty() && unclaimed.isEmpty(),
        partial = failed.isNotEmpty() || unclaimed.isNotEmpty(),
        failedStepIds = failed,
        skippedStepIds = skipped,
    )
}

class KillSwitchException(message: String) : Exception(message)

/**
 * @param conversationId Legacy id used by this app's single conversation.
 * @param database       Lazy holder for the Room database (may not be open yet).
 */
class KillSwitchExecutor(
    private val context: Context,
    private val conversationId: String,
    private val databaseProvider: () -> DuoDatabase?,
) {
    /* ----------------------------- persistence ---------------------------- */

    private val reportFile: File
        get() = File(context.filesDir, "killswitch-report.json")

    fun persistReport(report: KillSwitchReport) {
        try {
            val json = JSONObject()
                .put("scope", report.scope.name)
                .put("mode", report.mode.name)
                .put("startedAt", report.startedAt)
                .put("finishedAt", report.finishedAt ?: JSONObject.NULL)
            val steps = JSONArray()
            for (step in report.steps) {
                steps.put(
                    JSONObject()
                        .put("stepId", step.stepId)
                        .put("status", step.status.name)
                        .put("details", step.details ?: JSONObject.NULL),
                )
            }
            json.put("steps", steps)
            reportFile.writeText(json.toString())
        } catch (_: Exception) {
            // Report persistence is best-effort; wiping continues regardless.
        }
    }

    fun loadReport(): KillSwitchReport? {
        return try {
            if (!reportFile.exists()) return null
            val json = JSONObject(reportFile.readText())
            val report = KillSwitchReport(
                scope = KillSwitchScope.valueOf(json.getString("scope")),
                mode = KillSwitchMode.valueOf(json.getString("mode")),
                startedAt = json.getLong("startedAt"),
                finishedAt = if (json.isNull("finishedAt")) null else json.getLong("finishedAt"),
            )
            val steps = json.getJSONArray("steps")
            for (i in 0 until steps.length()) {
                val item = steps.getJSONObject(i)
                report.steps.add(
                    KillSwitchStepResult(
                        stepId = item.getString("stepId"),
                        status = StepStatus.valueOf(item.getString("status")),
                        details = if (item.isNull("details")) null else item.getString("details"),
                    ),
                )
            }
            report
        } catch (_: Exception) {
            null
        }
    }

    fun clearReportFile() {
        reportFile.delete()
    }

    /* ------------------------------ execution ----------------------------- */

    /**
     * Runs the checklist. Steps already recorded as ERASED in [resumeFrom]
     * are skipped (crash-resume); a step may throw nothing — failures are
     * recorded and execution continues so everything erasable is erased.
     */
    suspend fun execute(
        scope: KillSwitchScope,
        mode: KillSwitchMode,
        hooks: KillSwitchHooks,
        resumeFrom: KillSwitchReport? = null,
        onProgress: ((KillSwitchReport) -> Unit)? = null,
    ): KillSwitchReport {
        val report = resumeFrom?.let {
            KillSwitchReport(it.scope, it.mode, it.startedAt, null, it.steps.toMutableList())
        } ?: KillSwitchReport(scope, mode, System.currentTimeMillis(), null)
        for (step in KillSwitchPlans.planSteps(report.scope, report.mode)) {
            val previous = report.steps.firstOrNull { it.stepId == step.id }
            if (previous != null && previous.status == StepStatus.ERASED) continue
            report.steps.removeAll { it.stepId == step.id }
            val outcome = try {
                hooks.perform(step.id, mode)
            } catch (error: Exception) {
                KillSwitchStepResult(
                    stepId = step.id,
                    status = StepStatus.FAILED,
                    details = error.message?.take(160) ?: "Unknown step failure.",
                )
            }
            report.steps.add(outcome.copy(stepId = step.id))
            report.finishedAt = null
            persistReport(report)
            onProgress?.invoke(report)
        }
        report.finishedAt = System.currentTimeMillis()
        persistReport(report)
        return report
    }
}

interface KillSwitchHooks {
    /** Perform one step; must not throw message content in errors. */
    suspend fun perform(stepId: String, mode: KillSwitchMode): KillSwitchStepResult
}

/**
 * Platform hooks for the app-wide wipe. Failures are returned as FAILED
 * results; only genuinely unexpected executor errors propagate.
 */
class AppWideHooks(
    private val context: Context,
    private val conversationId: String,
    private val databaseProvider: () -> DuoDatabase?,
    private val identityManager: AndroidIdentityManager,
    private val uid: String,
) : KillSwitchHooks {

    override suspend fun perform(stepId: String, mode: KillSwitchMode): KillSwitchStepResult {
        return when (stepId) {
            "network.shutdown" -> KillSwitchStepResult(
                stepId,
                StepStatus.ERASED,
                "Networking belongs to the app process; connections closed on wipe start.",
            )
            "services.stop" -> KillSwitchStepResult(
                stepId,
                StepStatus.SKIPPED,
                "No separate background service exists in this version.",
            )
            "transfers.cancel" -> KillSwitchStepResult(
                stepId,
                StepStatus.SKIPPED,
                "No file transfer feature exists in this version.",
            )
            "messages.erase" -> {
                eraseDatabaseRows()
                KillSwitchStepResult(stepId, StepStatus.ERASED)
            }
            "contacts.erase" -> {
                val removed = identityManager.erasePeerKey(null)
                KillSwitchStepResult(
                    stepId,
                    StepStatus.ERASED,
                    "Local trust records deleted ($removed entries).",
                )
            }
            "attachments.erase" -> KillSwitchStepResult(
                stepId,
                StepStatus.SKIPPED,
                "No attachments or media are stored by this version.",
            )
            "queues.erase" -> KillSwitchStepResult(
                stepId,
                StepStatus.ERASED,
                "Queues were part of the local database erase.",
            )
            "keys.erase" -> {
                val failures: MutableList<String> = mutableListOf()
                try {
                    identityManager.deleteIdentityKey()
                } catch (_: Exception) {
                    failures.add("identity-sign")
                }
                try {
                    deleteLocalCryptoKey()
                } catch (_: Exception) {
                    failures.add("local-crypto")
                }
                if (failures.isEmpty()) {
                    KillSwitchStepResult(
                        stepId,
                        StepStatus.ERASED,
                        "Keystore keys deleted; previously sealed data is permanently undecryptable.",
                    )
                } else {
                    KillSwitchStepResult(
                        stepId,
                        StepStatus.FAILED,
                        "Keystore deletion failed for: ${failures.joinToString(", ")}.",
                    )
                }
            }
            "database.erase" -> {
                try {
                    eraseDatabaseRows()
                    val database = databaseProvider()
                    database?.close()
                    // Delete the whole file (schema + remnant) on Android's
                    // managed storage, then clear app-managed caches.
                    if (!context.deleteDatabase("duochat.db")) {
                        throw KillSwitchException("deleteDatabase returned false.")
                    }
                    context.cacheDir?.listFiles()?.forEach { file ->
                        if (file.isDirectory) file.deleteRecursively() else file.delete()
                    }
                    KillSwitchStepResult(stepId, StepStatus.ERASED)
                } catch (error: Exception) {
                    KillSwitchStepResult(
                        stepId,
                        StepStatus.FAILED,
                        "Database files could not be fully removed; rows were erased and a retry is attempted at restart.",
                    )
                }
            }
            "settings.erase" -> {
                var failures = 0
                for (prefsName in listOf("duochat.settings.v1", "duochat.identity.v1")) {
                    try {
                        val prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
                        prefs.edit().clear().apply()
                    } catch (_: Exception) {
                        failures += 1
                    }
                }
                if (failures == 0) {
                    KillSwitchStepResult(stepId, StepStatus.ERASED)
                } else {
                    KillSwitchStepResult(stepId, StepStatus.FAILED, "App settings could not be cleared.")
                }
            }
            else -> KillSwitchStepResult(stepId, StepStatus.FAILED, "Unknown step id.")
        }
    }

    /** Clears rows while the database is still open; schema handled next. */
    private suspend fun eraseDatabaseRows() {
        val database = databaseProvider() ?: throw KillSwitchException("Database unavailable.")
        val dao = database.dao()
        dao.clearMessages()
        dao.clearOutbox()
        dao.clearContacts()
        dao.clearGroupLogs()
    }

    private fun deleteLocalCryptoKey() {
        val keystore = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "duochat-aes-$uid"
        if (keystore.containsAlias(alias)) {
            keystore.deleteEntry(alias)
        }
    }
}

/** Per-scope conversation hooks (group-safe: local device data only). */
class ConversationHooks(
    private val conversationId: String,
    private val databaseProvider: () -> DuoDatabase?,
    private val identityManager: AndroidIdentityManager,
    private val uid: String,
) : KillSwitchHooks {

    override suspend fun perform(stepId: String, mode: KillSwitchMode): KillSwitchStepResult {
        return when (stepId) {
            "conv.transfers.cancel" -> KillSwitchStepResult(
                stepId,
                StepStatus.SKIPPED,
                "No file transfer feature exists in this version.",
            )
            "conv.messages.erase" -> {
                val database = databaseProvider()
                    ?: throw KillSwitchException("Database unavailable.")
                database.dao().clearMessagesFor(conversationId)
                database.dao().clearOutboxFor(conversationId)
                KillSwitchStepResult(stepId, StepStatus.ERASED)
            }
            "conv.session.erase" -> {
                val removed = identityManager.erasePeerKey(null)
                KillSwitchStepResult(
                    stepId,
                    StepStatus.ERASED,
                    "Trust entries erased ($removed). A new identity handshake is required before sending again." +
                        "",
                )
            }
            else -> KillSwitchStepResult(stepId, StepStatus.FAILED, "Unknown step id.")
        }
    }
}

