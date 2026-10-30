package com.duochat.app.ble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import java.util.UUID

/**
 * Bluetooth LE transport (docs/BLE_TRANSPORT.md). UNTESTED ON HARDWARE: this file has only been
 * reviewed against the Android API, never compiled or run on a device.
 *
 * Carries the same JSON frames as WebRtcTransport and mirrors its surface (isOpen, sendJson,
 * onOpen/onClose/onFrame/onError, close). Both GATT roles are implemented:
 *  - peripheral: always advertises the rotating tag and hosts the GATT service;
 *  - central: scans for the contact's tag and connects, only if [initiateAsCentral] is true
 *    (callers pass `ownUid < peerUid` so two phones never connect to each other twice).
 * The first link that finishes setup wins; any second link is dropped.
 */
object BleConstants {
    val SERVICE_UUID: UUID = UUID.fromString("fee43cae-8420-4563-8172-f73479794ee7")
    /** Central writes (without response) here. */
    val RX_UUID: UUID = UUID.fromString("fee43cae-8420-4563-8172-f73479794ee8")
    /** Peripheral notifies here. */
    val TX_UUID: UUID = UUID.fromString("fee43cae-8420-4563-8172-f73479794ee9")
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    /** Bluetooth SIG company id reserved for testing; the 8-byte tag is the manufacturer data. */
    const val COMPANY_ID = 0xFFFF
    const val REQUESTED_MTU = 517
    /** ATT header overhead subtracted from the MTU to get the usable write/notify size. */
    const val ATT_OVERHEAD = 3
    const val DEFAULT_MTU = 23
}

class BleTransport(
    private val context: Context,
    /** 32-byte ECDH secret shared with the pinned contact; used only to derive tags. */
    private val secretProvider: () -> ByteArray,
    private val initiateAsCentral: Boolean,
    private val handlers: Handlers,
) {
    interface Handlers {
        fun onOpen()
        fun onClose()
        fun onFrame(data: String)
        fun onError(message: String)
    }

    private val handler = Handler(Looper.getMainLooper())
    private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val adapter: BluetoothAdapter? get() = manager?.adapter

    private var started = false
    private var gattServer: BluetoothGattServer? = null
    private var txCharacteristic: BluetoothGattCharacteristic? = null
    private var serverDevice: BluetoothDevice? = null
    private var clientGatt: BluetoothGatt? = null
    private var clientRx: BluetoothGattCharacteristic? = null
    private var scanCallback: ScanCallback? = null
    private var advertiseCallback: AdvertiseCallback? = null

    private val reassembler = BleReassembler()
    private val outbound = ArrayDeque<ByteArray>()
    private var writeBusy = false
    private var mtu = BleConstants.DEFAULT_MTU
    private var role: Role? = null

    private enum class Role { PERIPHERAL, CENTRAL }

    @Volatile
    var isOpen: Boolean = false
        private set

    /** Max bytes per chunk (header included) for the active link. */
    private val maxChunk: Int get() = (mtu - BleConstants.ATT_OVERHEAD).coerceAtLeast(BleFraming.MIN_CHUNK_BYTES)

    fun hasPermissions(): Boolean {
        val needed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
            )
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        return needed.all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
    }

    /** Start advertising (and scanning if allowed). Safe to call once; call [close] to stop. */
    @SuppressLint("MissingPermission")
    fun start() {
        handler.post {
            if (started) return@post
            val bt = adapter
            if (bt == null || !bt.isEnabled) return@post fail("Bluetooth is off or unavailable.")
            if (!hasPermissions()) return@post fail("Bluetooth permission not granted.")
            started = true
            startGattServer()
            startAdvertising()
            if (initiateAsCentral) startScan()
        }
    }

    /** Queues the JSON frame as ordered chunks. Returns false if no link is open or the frame is invalid. */
    fun sendJson(value: String): Boolean {
        if (!isOpen) return false
        val chunks = try {
            BleFraming.chunkJson(value, maxChunk)
        } catch (_: BleFramingException) {
            return false
        }
        handler.post {
            outbound.addAll(chunks)
            pump()
        }
        return true
    }

    @SuppressLint("MissingPermission")
    fun close() {
        handler.post {
            val wasOpen = isOpen
            started = false
            stopScan()
            stopAdvertising()
            try { clientGatt?.disconnect(); clientGatt?.close() } catch (_: Exception) {}
            clientGatt = null
            clientRx = null
            try { serverDevice?.let { gattServer?.cancelConnection(it) } } catch (_: Exception) {}
            try { gattServer?.close() } catch (_: Exception) {}
            gattServer = null
            txCharacteristic = null
            serverDevice = null
            resetLink()
            if (wasOpen) handlers.onClose()
        }
    }

    // ---- shared link state -------------------------------------------------------------------

    private fun resetLink() {
        isOpen = false
        role = null
        mtu = BleConstants.DEFAULT_MTU
        outbound.clear()
        writeBusy = false
        reassembler.reset()
    }

    private fun linkOpened(newRole: Role) {
        if (isOpen) return
        role = newRole
        isOpen = true
        stopScan()
        handlers.onOpen()
    }

    private fun linkLost(lostRole: Role) {
        if (role != lostRole) return
        val wasOpen = isOpen
        resetLink()
        if (wasOpen) handlers.onClose()
        // Keep advertising/scanning so the contact can reconnect.
        if (started && initiateAsCentral) startScan()
    }

    private fun fail(message: String) = handlers.onError(message)

    private fun onChunk(bytes: ByteArray) {
        try {
            reassembler.push(bytes)?.let { handlers.onFrame(String(it, Charsets.UTF_8)) }
        } catch (e: BleFramingException) {
            fail("Bluetooth framing error: ${e.message}")
        }
    }

    /** Sends the next queued chunk; the next one waits for the platform's completion callback. */
    @SuppressLint("MissingPermission")
    private fun pump() {
        if (writeBusy || outbound.isEmpty() || !isOpen) return
        val chunk = outbound.first()
        val ok = when (role) {
            Role.CENTRAL -> writeCentral(chunk)
            Role.PERIPHERAL -> notifyPeripheral(chunk)
            null -> false
        }
        if (ok) {
            outbound.removeFirst()
            writeBusy = true
        } else {
            fail("Bluetooth write failed.")
            close()
        }
    }

    private fun writeDone() {
        writeBusy = false
        pump()
    }

    @SuppressLint("MissingPermission")
    private fun writeCentral(chunk: ByteArray): Boolean {
        val gatt = clientGatt ?: return false
        val rx = clientRx ?: return false
        return if (Build.VERSION.SDK_INT >= 33) {
            gatt.writeCharacteristic(rx, chunk, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) == 0 // BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            run {
                rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                rx.value = chunk
                gatt.writeCharacteristic(rx)
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun notifyPeripheral(chunk: ByteArray): Boolean {
        val server = gattServer ?: return false
        val tx = txCharacteristic ?: return false
        val device = serverDevice ?: return false
        return if (Build.VERSION.SDK_INT >= 33) {
            server.notifyCharacteristicChanged(device, tx, false, chunk) == 0 // BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            run {
                tx.value = chunk
                server.notifyCharacteristicChanged(device, tx, false)
            }
        }
    }

    // ---- tag advertising ---------------------------------------------------------------------

    private fun currentTag(): ByteArray = BleTag.tag(secretProvider(), BleTag.epoch(System.currentTimeMillis()))

    @SuppressLint("MissingPermission")
    private fun startAdvertising() {
        val advertiser = adapter?.bluetoothLeAdvertiser ?: return fail("This phone cannot advertise over Bluetooth LE.")
        stopAdvertising()
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .build()
        // Only the rotating tag: no device name and no service UUID, so strangers cannot recognize DuoChat.
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .addManufacturerData(BleConstants.COMPANY_ID, currentTag())
            .build()
        val callback = object : AdvertiseCallback() {
            override fun onStartFailure(errorCode: Int) {
                handler.post { fail("Bluetooth advertising failed (code $errorCode).") }
            }
        }
        advertiseCallback = callback
        advertiser.startAdvertising(settings, data, callback)
        // Re-advertise with the next tag when the epoch rolls over.
        val epochMs = BleTag.EPOCH_SECONDS * 1000
        val untilNext = epochMs - (System.currentTimeMillis() % epochMs) + 1000
        handler.postDelayed({ if (started) startAdvertising() }, untilNext)
    }

    @SuppressLint("MissingPermission")
    private fun stopAdvertising() {
        val callback = advertiseCallback ?: return
        try { adapter?.bluetoothLeAdvertiser?.stopAdvertising(callback) } catch (_: Exception) {}
        advertiseCallback = null
    }

    // ---- peripheral (GATT server) role -------------------------------------------------------

    @SuppressLint("MissingPermission")
    private fun startGattServer() {
        val server = manager?.openGattServer(context, serverCallback) ?: return fail("Could not open the Bluetooth GATT server.")
        gattServer = server
        val service = BluetoothGattService(BleConstants.SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val rx = BluetoothGattCharacteristic(
            BleConstants.RX_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        val tx = BluetoothGattCharacteristic(
            BleConstants.TX_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            0,
        )
        tx.addDescriptor(
            BluetoothGattDescriptor(
                BleConstants.CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            ),
        )
        service.addCharacteristic(rx)
        service.addCharacteristic(tx)
        txCharacteristic = tx
        server.addService(service)
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            handler.post {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    // One link at a time: refuse a second central while another link exists.
                    if (isOpen || serverDevice != null) {
                        try { gattServer?.cancelConnection(device) } catch (_: Exception) {}
                    } else {
                        serverDevice = device
                    }
                } else if (device.address == serverDevice?.address) {
                    serverDevice = null
                    linkLost(Role.PERIPHERAL)
                }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, newMtu: Int) {
            handler.post { if (device.address == serverDevice?.address) mtu = newMtu }
        }

        @SuppressLint("MissingPermission")
        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            val copy = value.copyOf()
            handler.post {
                if (device.address == serverDevice?.address && characteristic.uuid == BleConstants.RX_UUID && isOpen) {
                    onChunk(copy)
                }
            }
            if (responseNeeded) {
                try { gattServer?.sendResponse(device, requestId, 0, offset, value) } catch (_: Exception) {}
            }
        }

        @SuppressLint("MissingPermission")
        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            val enabled = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            handler.post {
                if (descriptor.uuid == BleConstants.CCCD_UUID && device.address == serverDevice?.address) {
                    if (enabled) linkOpened(Role.PERIPHERAL) else linkLost(Role.PERIPHERAL)
                }
            }
            if (responseNeeded) {
                try { gattServer?.sendResponse(device, requestId, 0, offset, value) } catch (_: Exception) {}
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            handler.post {
                if (status != 0) {
                    fail("Bluetooth notification failed (status $status).")
                    close()
                } else {
                    writeDone()
                }
            }
        }
    }

    // ---- central (GATT client) role ----------------------------------------------------------

    @SuppressLint("MissingPermission")
    private fun startScan() {
        val scanner = adapter?.bluetoothLeScanner ?: return fail("This phone cannot scan over Bluetooth LE.")
        stopScan()
        val tags = BleTag.acceptTags(secretProvider(), System.currentTimeMillis())
        val filters = tags.map { tag ->
            ScanFilter.Builder().setManufacturerData(BleConstants.COMPANY_ID, tag).build()
        }
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                handler.post {
                    if (!started || isOpen || clientGatt != null) return@post
                    val data = result.scanRecord?.getManufacturerSpecificData(BleConstants.COMPANY_ID) ?: return@post
                    if (tags.none { it.contentEquals(data) }) return@post
                    stopScan()
                    clientGatt = result.device.connectGatt(context, false, clientCallback, BluetoothDevice.TRANSPORT_LE)
                }
            }

            override fun onScanFailed(errorCode: Int) {
                handler.post { fail("Bluetooth scan failed (code $errorCode).") }
            }
        }
        scanCallback = callback
        scanner.startScan(filters, settings, callback)
        // Tags rotate: restart the scan with a fresh accept window every epoch while not connected.
        handler.postDelayed({ if (started && !isOpen && scanCallback === callback) startScan() }, BleTag.EPOCH_SECONDS * 1000)
    }

    @SuppressLint("MissingPermission")
    private fun stopScan() {
        val callback = scanCallback ?: return
        try { adapter?.bluetoothLeScanner?.stopScan(callback) } catch (_: Exception) {}
        scanCallback = null
    }

    private val clientCallback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    gatt.requestMtu(BleConstants.REQUESTED_MTU)
                } else {
                    try { gatt.close() } catch (_: Exception) {}
                    if (gatt === clientGatt) {
                        clientGatt = null
                        clientRx = null
                        linkLost(Role.CENTRAL)
                        if (started && initiateAsCentral && !isOpen) startScan()
                    }
                }
            }
        }

        @SuppressLint("MissingPermission")
        override fun onMtuChanged(gatt: BluetoothGatt, newMtu: Int, status: Int) {
            handler.post {
                if (status == BluetoothGatt.GATT_SUCCESS) mtu = newMtu
                gatt.discoverServices()
            }
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            handler.post {
                val service = gatt.getService(BleConstants.SERVICE_UUID)
                val rx = service?.getCharacteristic(BleConstants.RX_UUID)
                val tx = service?.getCharacteristic(BleConstants.TX_UUID)
                val cccd = tx?.getDescriptor(BleConstants.CCCD_UUID)
                if (status != BluetoothGatt.GATT_SUCCESS || rx == null || tx == null || cccd == null) {
                    fail("The nearby device is not a DuoChat Bluetooth peer.")
                    gatt.disconnect()
                    return@post
                }
                clientRx = rx
                gatt.setCharacteristicNotification(tx, true)
                if (Build.VERSION.SDK_INT >= 33) {
                    gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                } else {
                    @Suppress("DEPRECATION")
                    run {
                        cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        gatt.writeDescriptor(cccd)
                    }
                }
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            handler.post {
                if (status == BluetoothGatt.GATT_SUCCESS && descriptor.uuid == BleConstants.CCCD_UUID) {
                    linkOpened(Role.CENTRAL)
                } else {
                    fail("Could not subscribe to the Bluetooth peer (status $status).")
                    gatt.disconnect()
                }
            }
        }

        // API 33+
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            val copy = value.copyOf()
            handler.post { if (characteristic.uuid == BleConstants.TX_UUID) onChunk(copy) }
        }

        // API < 33
        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            val copy = characteristic.value?.copyOf() ?: return
            handler.post { if (characteristic.uuid == BleConstants.TX_UUID) onChunk(copy) }
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            handler.post {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    fail("Bluetooth write failed (status $status).")
                    close()
                } else {
                    writeDone()
                }
            }
        }
    }
}
