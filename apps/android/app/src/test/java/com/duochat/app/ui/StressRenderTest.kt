package com.duochat.app.ui

import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi

/**
 * Every screen of ScreensRenderTest again on a small phone (360 dp wide) with large text (1.6x), where clipped labels,
 * wrapping buttons and overlapping rows show up first.
 */
class StressRenderTest : ScreensRenderTest() {
    override val paparazzi = Paparazzi(
        deviceConfig = DeviceConfig.NEXUS_5.copy(fontScale = 1.6f),
        maxPercentDifference = 100.0,
    )
}
