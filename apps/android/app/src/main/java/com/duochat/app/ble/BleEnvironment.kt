package com.duochat.app.ble

import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import com.duochat.app.security.PublicJwk

/** Why Bluetooth can or cannot be used right now. */
enum class BleAvailability { UNSUPPORTED, NEEDS_PERMISSION, ADAPTER_OFF, READY }

/** What the engine needs from the platform for Bluetooth; faked in unit tests, [AndroidBleEnvironment] on a phone. */
interface BleEnvironment {
    fun availability(): BleAvailability

    fun createLink(
        secret: ByteArray,
        initiateAsCentral: Boolean,
        ownUid: String,
        peerUid: String,
        sign: (ByteArray) -> String,
        peerSign: PublicJwk,
        handlers: BleTransport.Handlers,
    ): SecureBleLink
}

class AndroidBleEnvironment(private val context: Context) : BleEnvironment {
    override fun availability(): BleAvailability = try {
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        when {
            adapter == null || !context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) ->
                BleAvailability.UNSUPPORTED
            !BlePermissions.granted(context) -> BleAvailability.NEEDS_PERMISSION
            !adapter.isEnabled -> BleAvailability.ADAPTER_OFF
            else -> BleAvailability.READY
        }
    } catch (_: SecurityException) {
        BleAvailability.NEEDS_PERMISSION
    }

    override fun createLink(
        secret: ByteArray,
        initiateAsCentral: Boolean,
        ownUid: String,
        peerUid: String,
        sign: (ByteArray) -> String,
        peerSign: PublicJwk,
        handlers: BleTransport.Handlers,
    ) = SecureBleLink(context, secret, initiateAsCentral, ownUid, peerUid, sign, peerSign, handlers)
}
