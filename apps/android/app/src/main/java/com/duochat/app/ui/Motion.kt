package com.duochat.app.ui

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.ui.input.pointer.pointerInput
import kotlinx.coroutines.launch

/*
 * One motion vocabulary for the whole app, so everything moves with the same rhythm.
 *
 * * Things arrive decelerating and leave accelerating; leaving takes about two thirds of arriving.
 * * Small things (buttons, icons, a new message) use springs: they never feel late and can be interrupted midway.
 * * Going deeper (home -> chat -> group details) slides in from the end; going back slides out to the end.
 * * Nothing waits on an animation: every one of them can be interrupted by the next tap.
 *
 * "Remove animations" in the phone's accessibility settings is honoured for free: Compose scales every animation by
 * the system animator duration scale, so with it off all of these finish at once.
 */
object Motion {
    /** Material 3 "emphasized" curves. */
    val Decelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    val Accelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
    val Standard = CubicBezierEasing(0.2f, 0f, 0f, 1f)

    const val SCREEN_IN = 380
    const val SCREEN_OUT = 220
    const val SMALL_IN = 220
    const val SMALL_OUT = 140

    /** Small UI (icons swapping, chips, badges): quick and slightly lively. */
    fun <T> pop() = spring<T>(dampingRatio = 0.7f, stiffness = Spring.StiffnessMediumLow)

    /** Things settling into place (list rows moving, a message arriving): calm, no overshoot. */
    fun <T> settle() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow)

    /** Moving one level deeper ([forward]) or back up. The screen being revealed comes from a short distance. */
    fun slide(forward: Boolean): ContentTransform {
        val enter = slideInHorizontally(tween(SCREEN_IN, easing = Decelerate)) { w -> if (forward) w / 4 else -w / 10 } +
            fadeIn(tween(SCREEN_IN / 2, delayMillis = if (forward) 40 else 0, easing = Standard))
        val exit = slideOutHorizontally(tween(SCREEN_OUT, easing = Accelerate)) { w -> if (forward) -w / 10 else w / 4 } +
            fadeOut(tween(SCREEN_OUT, easing = Standard))
        return (enter togetherWith exit).apply { targetContentZIndex = if (forward) 1f else -1f }
    }

    /** Unrelated screens (lock, loading, setup, home): the old one fades out, the new one fades and grows in. */
    fun fadeThrough(): ContentTransform =
        (fadeIn(tween(SMALL_IN + 60, delayMillis = 60, easing = Decelerate)) + scaleIn(tween(SMALL_IN + 60, delayMillis = 60, easing = Decelerate), initialScale = 0.96f))
            .togetherWith(fadeOut(tween(SMALL_OUT, easing = Accelerate)))

    /** Swapping one small thing for another in the same spot (send/record, play/pause). */
    fun swap(): ContentTransform =
        (fadeIn(tween(SMALL_IN, easing = Decelerate)) + scaleIn(pop(), initialScale = 0.6f))
            .togetherWith(fadeOut(tween(SMALL_OUT)) + scaleOut(tween(SMALL_OUT, easing = Accelerate), targetScale = 0.6f))
}

/** How deep a top-level route is (home 0, a chat or form 1, group details 2); -1 for screens outside the chats. */
fun routeDepth(route: String): Int = when {
    route == "home" -> 0
    route.startsWith("group:") -> 2
    route == "add" || route == "newgroup" || route.startsWith("chat:") -> 1
    else -> -1
}

/** The transition between two top-level screens, chosen from where they sit. */
fun AnimatedContentTransitionScope<String>.screenTransition(): ContentTransform {
    val from = routeDepth(initialState)
    val to = routeDepth(targetState)
    if (from < 0 || to < 0) return Motion.fadeThrough().apply { targetContentZIndex = 1f }
    // Same depth (one chat to another from a notification) reads as going forward.
    return Motion.slide(forward = to >= from)
}

/**
 * A message (or any item) that arrives while you watch rises a little and grows from the side it belongs to.
 * Items already there when the screen opened ([play] false) are drawn as they are.
 */
fun Modifier.arrive(play: Boolean, fromStart: Boolean): Modifier = if (!play) this else composed {
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) { progress.animateTo(1f, Motion.settle()) }
    graphicsLayer {
        val p = progress.value
        alpha = p.coerceIn(0f, 1f)
        translationY = (1f - p) * 14.dp.toPx()
        val s = 0.9f + 0.1f * p
        scaleX = s
        scaleY = s
        transformOrigin = TransformOrigin(if (fromStart) 0f else 1f, 1f)
    }
}

/** A gentle press: the element sinks a little while the finger is on it and springs back on release. */
fun Modifier.pressScale(interaction: MutableInteractionSource, pressed: Float = 0.92f): Modifier = composed {
    val isPressed by interaction.collectIsPressedAsState()
    val scale by androidx.compose.animation.core.animateFloatAsState(if (isPressed) pressed else 1f, Motion.pop(), label = "press")
    graphicsLayer {
        scaleX = scale
        scaleY = scale
    }
}

/**
 * Drag a message to the right to reply to it. A reply arrow fades and grows in behind it; past the point where letting
 * go replies, there is a light tick and the message starts to resist. Letting go springs it back.
 */
@androidx.compose.runtime.Composable
fun SwipeToReply(enabled: Boolean, onReply: () -> Unit, content: @androidx.compose.runtime.Composable () -> Unit) {
    if (!enabled) {
        content()
        return
    }
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val reply by androidx.compose.runtime.rememberUpdatedState(onReply)
    val trigger = with(androidx.compose.ui.platform.LocalDensity.current) { 64.dp.toPx() }
    val shown = remember { Animatable(0f) }
    val tint = androidx.compose.material3.MaterialTheme.colorScheme.onSurfaceVariant
    androidx.compose.foundation.layout.Box(
        Modifier.fillMaxWidth().pointerInput(Unit) {
            var raw = 0f
            var armed = false
            fun release(fire: Boolean) {
                if (fire && armed) reply()
                raw = 0f
                armed = false
                scope.launch { shown.animateTo(0f, Motion.pop()) }
            }
            detectHorizontalDragGestures(
                onDragEnd = { release(true) },
                onDragCancel = { release(false) },
            ) { change, amount ->
                raw = (raw + amount).coerceAtLeast(0f)
                // Up to the trigger it follows the finger; beyond it, at a third of the speed.
                val visible = if (raw <= trigger) raw else trigger + (raw - trigger) / 3f
                scope.launch { shown.snapTo(visible.coerceAtMost(trigger * 1.5f)) }
                val nowArmed = raw >= trigger
                if (nowArmed && !armed) haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                armed = nowArmed
                change.consume()
            }
        },
    ) {
        androidx.compose.material3.Icon(
            androidx.compose.material.icons.Icons.AutoMirrored.Filled.Reply,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.align(androidx.compose.ui.Alignment.CenterStart).padding(start = 12.dp).size(22.dp).graphicsLayer {
                val p = (shown.value / trigger).coerceIn(0f, 1f)
                alpha = p
                scaleX = 0.5f + 0.5f * p
                scaleY = 0.5f + 0.5f * p
            },
        )
        androidx.compose.foundation.layout.Box(Modifier.graphicsLayer { translationX = shown.value }) { content() }
    }
}
