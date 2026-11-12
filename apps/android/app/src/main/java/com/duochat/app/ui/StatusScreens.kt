package com.duochat.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.animation.core.animateFloat
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.runtime.getValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape

/**
 * Opening the app: the logo takes over from the system's launch icon and grows into place and breathes gently while the encrypted data
 * opens. The spinner and the words only appear if that takes a moment, so a quick start shows no flash of them.
 */
@Composable
fun LoadingScreen(message: String) {
    val logo = androidx.compose.runtime.remember { androidx.compose.animation.core.Animatable(0f) }
    val details = androidx.compose.runtime.remember { androidx.compose.animation.core.Animatable(0f) }
    androidx.compose.runtime.LaunchedEffect(Unit) { logo.animateTo(1f, Motion.pop()) }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        kotlinx.coroutines.delay(700)
        details.animateTo(1f, androidx.compose.animation.core.tween(Motion.SMALL_IN, easing = Motion.Decelerate))
    }
    val breathe by androidx.compose.animation.core.rememberInfiniteTransition(label = "breathe").animateFloat(
        initialValue = 1f, targetValue = 1.045f, label = "breathe",
        animationSpec = androidx.compose.animation.core.infiniteRepeatable(
            androidx.compose.animation.core.tween(1300, easing = Motion.Standard),
            androidx.compose.animation.core.RepeatMode.Reverse,
        ),
    )
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier.graphicsLayer {
                    // Visible from the first frame (no blank flash after the system's launch icon); it only grows.
                    val p = logo.value
                    val s = (0.8f + 0.2f * p) * breathe
                    scaleX = s
                    scaleY = s
                },
            ) { BrandMark(96) }
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.graphicsLayer {
                    alpha = details.value
                    translationY = (1f - details.value) * 8.dp.toPx()
                },
            ) {
                Spacer(Modifier.height(28.dp))
                CircularProgressIndicator(strokeWidth = 3.dp, modifier = Modifier.size(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(16.dp))
                Text(
                    message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
fun FatalScreen(message: String, onRetry: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                Icons.Filled.Lock,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(36.dp),
            )
            Spacer(Modifier.height(12.dp))
            Text("DuoCord could not start", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(8.dp))
            Text(
                message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(18.dp))
            androidx.compose.material3.Button(onClick = onRetry, modifier = Modifier.heightIn(min = 52.dp)) {
                Text("Try again")
            }
        }
    }
}
