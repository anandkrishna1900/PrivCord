package com.duochat.app.ui

import com.journeyapps.barcodescanner.CaptureActivity

/**
 * The QR scanner screen. The library's own screen is declared landscape-only, which on a phone held upright shows a sideways,
 * empty viewfinder. This subclass is declared portrait in the manifest and is what [qrScanOptions] launches.
 */
class PortraitCaptureActivity : CaptureActivity()
