package com.duochat.app.data

import com.duochat.app.security.PublicJwk
import kotlinx.coroutines.tasks.await
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.Source
import kotlinx.coroutines.withTimeout

class CloudRepository {
    private val db: FirebaseFirestore
        get() = FirebaseFirestore.getInstance()

    private fun messagesRef(conversationId: String) =
        db.collection("conversations").document(conversationId).collection("messages")

    private fun signalsRef(conversationId: String) =
        db.collection("conversations").document(conversationId).collection("signals")

    suspend fun loadAccess(expectedConversationId: String): AccessInfo {
        val snapshot = db.collection("config").document("access").get().await()
        if (!snapshot.exists()) {
            throw IllegalStateException(
                "Owner setup is incomplete: config/access does not exist. " +
                    "Seed it with scripts/seed-firebase.mjs.",
            )
        }
        val members = snapshot.get("memberIds") as? List<*>
        if (members == null || members.size != 2 || members.any { it !is String || it.isEmpty() }) {
            throw IllegalStateException("config/access must contain exactly two member IDs.")
        }
        val conversationId = snapshot.getString("conversationId")
        if (conversationId != expectedConversationId) {
            throw IllegalStateException(
                "config/access.conversationId must be \"$expectedConversationId\".",
            )
        }
        return AccessInfo(
            memberIds = listOf(members[0] as String, members[1] as String),
            conversationId = conversationId,
        )
    }

    suspend fun checkCloud(): Boolean = try {
        db.collection("config").document("access").get(Source.SERVER).await()
        true
    } catch (_: Exception) {
        false
    }

    suspend fun loadProfile(uid: String): UserProfile {
        val snapshot = db.collection("users").document(uid).get().await()
        return profileFrom(uid, snapshot)
    }

    fun subscribeProfile(
        uid: String,
        onChange: (UserProfile) -> Unit,
        onError: (Exception) -> Unit,
    ): ListenerRegistration =
        db.collection("users").document(uid).addSnapshotListener { snapshot, error ->
            if (error != null) {
                onError(error)
                return@addSnapshotListener
            }
            if (snapshot != null) onChange(profileFrom(uid, snapshot))
        }

    private fun profileFrom(uid: String, snapshot: DocumentSnapshot): UserProfile {
        val name = snapshot.getString("displayName")?.trim().orEmpty()
        return UserProfile(
            uid = uid,
            displayName = name.ifEmpty { "DuoChat user" },
            photoURL = snapshot.getString("photoURL"),
            lastSeenAt = snapshot.getTimestamp("lastSeenAt")?.toDate()?.time,
        )
    }

    suspend fun ensureOwnProfile(uid: String, email: String, displayName: String) {
        val ref = db.collection("users").document(uid)
        val snapshot = ref.get().await()
        val cleanName = displayName.trim().take(40).ifEmpty {
            email.substringBefore('@').take(40).ifEmpty { "DuoChat user" }
        }
        if (!snapshot.exists()) {
            ref.set(
                mapOf(
                    "displayName" to cleanName,
                    "createdAt" to FieldValue.serverTimestamp(),
                    "lastSeenAt" to FieldValue.serverTimestamp(),
                ),
            ).await()
        } else {
            ref.set(
                mapOf("lastSeenAt" to FieldValue.serverTimestamp()),
                com.google.firebase.firestore.SetOptions.merge(),
            ).await()
        }
    }

    suspend fun updateDisplayName(uid: String, displayName: String) {
        val clean = displayName.trim()
        if (clean.isEmpty() || clean.length > 40) {
            throw IllegalArgumentException("Display name must be between 1 and 40 characters.")
        }
        db.collection("users").document(uid).set(
            mapOf(
                "displayName" to clean,
                "lastSeenAt" to FieldValue.serverTimestamp(),
            ),
            com.google.firebase.firestore.SetOptions.merge(),
        ).await()
    }

    suspend fun touchLastSeen(uid: String) {
        try {
            db.collection("users").document(uid).set(
                mapOf("lastSeenAt" to FieldValue.serverTimestamp()),
                com.google.firebase.firestore.SetOptions.merge(),
            ).await()
        } catch (_: Exception) {
            // Presence is best-effort.
        }
    }

    suspend fun registerDevice(uid: String, deviceId: String, publicKeyJwk: PublicJwk) {
        db.collection("users").document(uid).collection("devices").document(deviceId).set(
            mapOf(
                "publicKeyJwk" to mapOf(
                    "kty" to "EC",
                    "crv" to "P-256",
                    "x" to publicKeyJwk.x,
                    "y" to publicKeyJwk.y,
                ),
                "lastSeenAt" to FieldValue.serverTimestamp(),
            ),
            com.google.firebase.firestore.SetOptions.merge(),
        ).await()
    }

    suspend fun fetchPeerDeviceKey(uid: String, deviceId: String): PublicJwk? {
        val snapshot = db.collection("users").document(uid)
            .collection("devices").document(deviceId).get().await()
        if (!snapshot.exists()) return null
        @Suppress("UNCHECKED_CAST")
        val jwk = snapshot.get("publicKeyJwk") as? Map<String, Any?> ?: return null
        val x = jwk["x"] as? String ?: return null
        val y = jwk["y"] as? String ?: return null
        return PublicJwk(x, y)
    }

    fun subscribeLatestMessages(
        conversationId: String,
        onPage: (List<ChatMessage>, DocumentSnapshot?) -> Unit,
        onError: (Exception) -> Unit,
    ): ListenerRegistration {
        val query = messagesRef(conversationId)
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(100)
        return query.addSnapshotListener { snapshot, error ->
            if (error != null) {
                onError(error)
                return@addSnapshotListener
            }
            val docs = snapshot?.documents ?: emptyList()
            val messages = docs.mapNotNull { messageFrom(it) }.reversed()
            onPage(messages, docs.lastOrNull())
        }
    }

    suspend fun fetchOlderMessages(
        conversationId: String,
        cursor: DocumentSnapshot,
    ): MessagePage {
        val snapshot = messagesRef(conversationId)
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .startAfter(cursor)
            .limit(50)
            .get()
            .await()
        val messages = snapshot.documents.mapNotNull { messageFrom(it) }.reversed()
        return MessagePage(
            messages = messages,
            cursor = snapshot.documents.lastOrNull() ?: cursor,
            hasMore = snapshot.documents.size == 50,
        )
    }

    private fun messageFrom(document: DocumentSnapshot): ChatMessage? {
        val data = document.data ?: return null
        return fromCloudMessage(
            id = document.id,
            data = data,
            serverCreatedAt = document.getTimestamp("createdAt")?.toDate()?.time,
        )
    }

    suspend fun writeMessage(conversationId: String, message: ChatMessage) {
        withTimeout(12_000) {
            messagesRef(conversationId).document(message.messageId)
                .set(
                    toCloudPayload(message) + mapOf(
                        "createdAt" to FieldValue.serverTimestamp(),
                    ),
                )
                .await()
        }
    }

    suspend fun writeReadState(
        conversationId: String,
        uid: String,
        lastReadMessageId: String,
    ) {
        db.collection("conversations").document(conversationId)
            .collection("readStates").document(uid)
            .set(
                mapOf(
                    "lastReadMessageId" to lastReadMessageId,
                    "lastReadAt" to FieldValue.serverTimestamp(),
                ),
                com.google.firebase.firestore.SetOptions.merge(),
            )
            .await()
    }

    fun subscribePeerReadState(
        conversationId: String,
        peerUid: String,
        onChange: (String?) -> Unit,
        onError: (Exception) -> Unit,
    ): ListenerRegistration =
        db.collection("conversations").document(conversationId)
            .collection("readStates").document(peerUid)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    onError(error)
                    return@addSnapshotListener
                }
                onChange(snapshot?.getString("lastReadMessageId"))
            }

    suspend fun sendSignal(
        conversationId: String,
        from: String,
        to: String,
        fromDeviceId: String,
        kind: String,
        sdp: String,
    ) {
        signalsRef(conversationId).document().set(
            mapOf(
                "from" to from,
                "to" to to,
                "fromDeviceId" to fromDeviceId,
                "kind" to kind,
                "sdp" to sdp,
                "createdAt" to FieldValue.serverTimestamp(),
                "expiresAt" to (System.currentTimeMillis() + 60_000),
            ),
        ).await()
    }

    fun subscribeSignals(
        conversationId: String,
        uid: String,
        onSignal: (IncomingSignal) -> Unit,
        onError: (Exception) -> Unit,
    ): ListenerRegistration =
        signalsRef(conversationId)
            .whereEqualTo("to", uid)
            .limit(20)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    onError(error)
                    return@addSnapshotListener
                }
                val now = System.currentTimeMillis()
                for (document in snapshot?.documents ?: emptyList()) {
                    val data = document.data ?: continue
                    val from = data["from"] as? String ?: continue
                    val fromDeviceId = data["fromDeviceId"] as? String ?: continue
                    val kind = data["kind"] as? String ?: continue
                    if (kind != "offer" && kind != "answer") continue
                    val sdp = data["sdp"] as? String ?: continue
                    val expiresAt = (data["expiresAt"] as? Number)?.toLong() ?: 0L
                    if (expiresAt > 0 && expiresAt < now) {
                        document.reference.delete()
                        continue
                    }
                    onSignal(
                        IncomingSignal(
                            id = document.id,
                            from = from,
                            fromDeviceId = fromDeviceId,
                            kind = kind,
                            sdp = sdp,
                            expiresAt = expiresAt,
                        ),
                    )
                }
            }

    suspend fun deleteSignals(conversationId: String, ids: List<String>) {
        if (ids.isEmpty()) return
        val batch = db.batch()
        for (id in ids) batch.delete(signalsRef(conversationId).document(id))
        batch.commit().await()
    }
}
