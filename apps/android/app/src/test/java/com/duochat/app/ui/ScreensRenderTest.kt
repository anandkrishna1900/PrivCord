package com.duochat.app.ui

import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.duochat.app.data.AppSettings
import com.duochat.app.data.ChatMessage
import com.duochat.app.data.ChatState
import com.duochat.app.data.ChatSummary
import com.duochat.app.data.ContactTrust
import com.duochat.app.data.ContactView
import com.duochat.app.data.DeliveryState
import com.duochat.app.data.EnginePhase
import com.duochat.app.data.LinkStatus
import com.duochat.app.data.ReplyRef
import org.junit.Rule
import org.junit.Test

/**
 * Renders the main screens (home, a chat in both themes, a group chat, an empty chat, Add friend) on the JVM with Paparazzi, so
 * a screen that crashes while drawing fails the build. To look at them: `./gradlew :app:recordPaparazziClassicDebug`, then
 * open `app/src/test/snapshots/images` (not committed: the images change with every intended UI change).
 */
class ScreensRenderTest {
    @get:Rule
    val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, maxPercentDifference = 100.0)

    private val me = "me-uid"
    private val ann = "ann-uid"
    private val now = System.currentTimeMillis()

    private fun msg(id: String, from: String, text: String, minsAgo: Int, state: DeliveryState = DeliveryState.READ, reply: ReplyRef? = null, reactions: Map<String, String> = emptyMap()) =
        ChatMessage(
            messageId = id, clientMessageId = id, senderId = from, text = text,
            clientCreatedAt = now - minsAgo * 60_000L, deliveryState = state, conversationId = ann,
            replyTo = reply, reactions = reactions,
        )

    private val state = ChatState(
        phase = EnginePhase.READY,
        uid = me,
        contacts = listOf(
            ContactView(ann, "Ann Lee", ContactTrust.VERIFIED, null, true, LinkStatus.CONNECTED, null, "1"),
        ),
        chats = listOf(
            ChatSummary(ann, false, "Ann Lee", "See you at 7 then 👋", now - 2 * 60_000L, 3, LinkStatus.CONNECTED, "Connected"),
            ChatSummary("g1", true, "Weekend trip", "Sam: I booked the cabin", now - 26 * 3_600_000L, 0, LinkStatus.CONNECTED, "4 members"),
            ChatSummary("b", false, "Ben Carter", "Thanks!", now - 4 * 86_400_000L, 0, LinkStatus.OFFLINE, "Waiting"),
            ChatSummary("c", false, "Cat with a really quite long name that should be cut", null, 0, 0, LinkStatus.CONNECTING, "Connecting…"),
        ),
        messages = mapOf(
            ann to listOf(
                msg("1", ann, "Hey! Are we still on for dinner tonight?", 130),
                msg("2", ann, "I can book the place by the river", 129),
                msg("3", me, "Yes! The river place sounds great", 120),
                msg("4", me, "7 o'clock?", 119, reactions = mapOf(ann to "👍")),
                msg("5", ann, "Perfect, booking now. It is usually busy on Fridays so this might take a minute, but I will let you know as soon as it's confirmed.", 20),
                msg("6", me, "Great, see you there", 3, DeliveryState.DELIVERED, reply = ReplyRef("5", ann, "Perfect, booking now")),
                msg("7", ann, "See you at 7 then 👋", 2),
                msg("8", me, "On my way", 1, DeliveryState.FAILED),
            ),
        ),
    )

    private val group = com.duochat.app.data.GroupView(
        groupId = "g1", name = "Weekend trip",
        members = listOf(
            com.duochat.app.data.MemberView(me, "You", true, true, null, null, null),
            com.duochat.app.data.MemberView(ann, "Ann Lee", false, false, null, ContactTrust.VERIFIED, LinkStatus.CONNECTED, true),
            com.duochat.app.data.MemberView("sam", "Sam Ortiz", false, false, "Ann Lee", ContactTrust.INTRODUCED, LinkStatus.CONNECTED),
        ),
        iAmMember = true, iAmAdmin = true, exitNote = null, connectedCount = 2,
    )

    private val groupState = state.copy(
        groups = listOf(group),
        messages = mapOf(
            "g1" to listOf(
                msg("g1", ann, "Who is driving on Saturday?", 60).copy(conversationId = "g1"),
                msg("g2", "sam", "I can take four people", 58).copy(conversationId = "g1"),
                msg("g3", "sam", "Leaving at 9 sharp", 57).copy(conversationId = "g1"),
                msg("g4", me, "Count me in 🙌", 50).copy(conversationId = "g1"),
                msg("g5", ann, "Same here", 49).copy(conversationId = "g1"),
            ),
        ),
    )

    @Test
    fun groupChat() = paparazzi.snapshot {
        androidx.compose.runtime.CompositionLocalProvider(
            androidx.activity.compose.LocalActivityResultRegistryOwner provides registryOwner,
        ) {
            DuoChatTheme(AppSettings(theme = "dark")) {
                ChatScreen(
                    state = groupState, conversationId = "g1", muted = false, onBack = {},
                    onSend = { _, _, _ -> }, onSendFile = { _, _, _, _, _ -> }, loadFile = { null },
                    onRetry = ::noop1, onClearNotice = {}, onOpenDetails = {}, onVerify = {}, onToggleMute = {},
                    onClearChat = {}, onConnectBluetooth = {}, onLeaveChannel = {}, onMuteSender = ::noop1,
                )
            }
        }
    }

    @Test
    fun addFriend() = paparazzi.snapshot {
        androidx.compose.runtime.CompositionLocalProvider(
            androidx.activity.compose.LocalActivityResultRegistryOwner provides registryOwner,
        ) {
            DuoChatTheme(AppSettings(theme = "dark")) {
                AddFriendScreen(
                    state = state.copy(invite = com.duochat.app.data.ActiveInvite("water because surface fat worth sudden", now + 900_000)),
                    ownCard = { "DUOID1:eyJ2IjoxfQ" }, onAdd = { _, _ -> }, onCreateInvite = {}, onRetryAnswer = {},
                    onClearAnswer = {}, onChecked = {}, onBack = {}, onOpenChat = {},
                )
            }
        }
    }

    @Test
    fun emptyChat() = paparazzi.snapshot {
        androidx.compose.runtime.CompositionLocalProvider(
            androidx.activity.compose.LocalActivityResultRegistryOwner provides registryOwner,
        ) {
            DuoChatTheme(AppSettings(theme = "dark")) {
                ChatScreen(
                    state = state.copy(messages = emptyMap()), conversationId = ann, muted = false, onBack = {},
                    onSend = { _, _, _ -> }, onSendFile = { _, _, _, _, _ -> }, loadFile = { null },
                    onRetry = ::noop1, onClearNotice = {}, onOpenDetails = {}, onVerify = {}, onToggleMute = {},
                    onClearChat = {}, onConnectBluetooth = {}, onLeaveChannel = {}, onMuteSender = ::noop1,
                )
            }
        }
    }

    private fun noop1(@Suppress("UNUSED_PARAMETER") a: String) = Unit

    @Test
    fun home() = paparazzi.snapshot {
        DuoChatTheme(AppSettings(theme = "dark")) {
            HomeScreen(state = state, onOpenChat = {}, onAddFriend = {}, onNewGroup = {}, onChannels = {}, onOpenSettings = {}, onClearNotice = {})
        }
    }

    @Test
    fun chatDark() = paparazzi.snapshot { chat(AppSettings(theme = "dark")) }

    @Test
    fun chatLight() = paparazzi.snapshot { chat(AppSettings(theme = "light")) }

    /** Larger system font (Settings > Display > Font size): nothing may be cut off or overlap. */
    @Test
    fun chatLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(fontScale = 1.3f))
        paparazzi.snapshot { chat(AppSettings(theme = "dark")) }
    }

    @Test
    fun homeLargeText() {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_5.copy(fontScale = 1.3f))
        paparazzi.snapshot {
            DuoChatTheme(AppSettings(theme = "dark")) {
                HomeScreen(state = state, onOpenChat = {}, onAddFriend = {}, onNewGroup = {}, onChannels = {}, onOpenSettings = {}, onClearNotice = {})
            }
        }
    }

    private val registryOwner = object : androidx.activity.result.ActivityResultRegistryOwner {
        override val activityResultRegistry = object : androidx.activity.result.ActivityResultRegistry() {
            override fun <I, O> onLaunch(
                requestCode: Int,
                contract: androidx.activity.result.contract.ActivityResultContract<I, O>,
                input: I,
                options: androidx.core.app.ActivityOptionsCompat?,
            ) = Unit
        }
    }

    @androidx.compose.runtime.Composable
    private fun chat(settings: AppSettings) {
        androidx.compose.runtime.CompositionLocalProvider(
            androidx.activity.compose.LocalActivityResultRegistryOwner provides registryOwner,
        ) { chatInner(settings) }
    }

    @androidx.compose.runtime.Composable
    private fun chatInner(settings: AppSettings) {
        DuoChatTheme(settings) {
            ChatScreen(
                state = state, conversationId = ann, muted = false, onBack = {},
                onSend = { _, _, _ -> }, onSendFile = { _, _, _, _, _ -> }, loadFile = { null },
                onRetry = ::noop1, onClearNotice = {}, onOpenDetails = {}, onVerify = {}, onToggleMute = {},
                onClearChat = {}, onConnectBluetooth = {}, onLeaveChannel = {}, onMuteSender = ::noop1,
            )
        }
    }
}
