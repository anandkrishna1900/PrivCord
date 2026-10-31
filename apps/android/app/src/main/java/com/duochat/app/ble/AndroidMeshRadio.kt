package com.duochat.app.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import java.security.SecureRandom
import java.util.UUID

/**
 * Bluetooth LE mesh radio. UNTESTED ON HARDWARE: compiled against the Android API and exercised only through
 * the [MeshRadio] fake in unit tests. Treat it as a first draft until it has run between real phones.
 *
 * Every phone does both GATT jobs at once. It advertises the mesh service (so others can find it) and hosts the
 * service (others write packets to RX and receive them as TX notifications); it also scans and connects out to
 * other phones. To avoid two phones connecting to each other twice, each advertises a random 4-byte node id and
 * only the phone with the smaller id connects out. At most [MAX_LINKS] links are kept.
 *
 * Unlike the contact-to-contact link (BleTransport), this one is open to strangers and not encrypted at the link
 * layer: the mesh only carries messages that are already end-to-end encrypted or signed (see MeshNode.kt).
 */
@SuppressLint("MissingPermission")
class AndroidMeshRadio(private val context: Context) : MeshRadio {
    private companion object {
        val SERVICE: UUID = UUID.fromString("fee43cae-8420-4563-8172-f73479794ef0")
        val RX: UUID = UUID.fromString("fee43cae-8420-4563-8172-f73479794ef1")
        val TX: UUID = UUID.fromString("fee43cae-8420-4563-8172-f73479794ef2")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        const val COMPANY_ID = 0xFFFF
        const val MAX_LINKS = 5
        const val REQUESTED_MTU = 247
        const val PACE_TIMEOUT_MS = 600L
    }

    private class Link(val id: String, val device: BluetoothDevice, val viaServer: Boolean) {
        var gatt: BluetoothGatt? = null
        var rx: BluetoothGattCharacteristic? = null
        var mtu = BleConstants.DEFAULT_MTU
        var ready = false
        val reassembler = BleReassembler()
        val outbound = ArrayDeque<ByteArray>()
        var busy = false
    }

    private val handler = Handler(Looper.getMainLooper())
    private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val nodeId = ByteArray(4).also { SecureRandom().nextBytes(it) }
    private val links = HashMap<String, Link>()
    private val connecting = HashSet<String>()
    private var listener: MeshRadio.Listener? = null
    private var server: BluetoothGattServer? = null
    private var txChar: BluetoothGattCharacteristic? = null
    private var advertiseCallback: AdvertiseCallback? = null
    private var scanCallback: ScanCallback? = null
    private var started = false

    override val linkCount: Int get() = links.values.count { it.ready }

    override fun start(listener: MeshRadio.Listener) {
        handler.post {
            if (started) return@post
            val adapter = manager?.adapter ?: return@post
            if (!adapter.isEnabled || !BlePermissions.granted(context)) return@post
            this.listener = listener
            started = true
            startServer()
            startAdvertising()
            startScan()
        }
    }

    override fun stop() {
        handler.post {
            started = false
            runCatching { manager?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) }
            runCatching { manager?.adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
            for (l in links.values.toList()) drop(l)
            runCatching { server?.close() }
            server = null
            links.clear()
            connecting.clear()
        }
    }

    override fun send(link: String, json: String): Boolean {
        val l = links[link]
        if (l == null || !l.ready) return false
        val chunks = try {
            BleFraming.chunkJson(json, (l.mtu - BleConstants.ATT_OVERHEAD).coerceAtLeast(BleFraming.MIN_CHUNK_BYTES))
        } catch (_: BleFramingException) {
            return false
        }
        handler.post {
            l.outbound.addAll(chunks)
            pump(l)
        }
        return true
    }

    /* ---------------- hosting ---------------- */

    private fun startServer() {
        val srv = manager?.openGattServer(context, serverCallback) ?: return
        val service = BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(
            BluetoothGattCharacteristic(RX, BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE),
        )
        val tx = BluetoothGattCharacteristic(TX, BluetoothGattCharacteristic.PROPERTY_NOTIFY, BluetoothGattCharacteristic.PERMISSION_READ)
        tx.addDescriptor(BluetoothGattDescriptor(CCCD, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
        service.addCharacteristic(tx)
        txChar = tx
        srv.addService(service)
        server = srv
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            handler.post {
                if (newState == android.bluetooth.BluetoothProfile.STATE_DISCONNECTED) links["s:${device.address}"]?.let { drop(it) }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            handler.post { links["s:${device.address}"]?.mtu = mtu }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice, requestId: Int, descriptor: BluetoothGattDescriptor, preparedWrite: Boolean,
            responseNeeded: Boolean, offset: Int, value: ByteArray,
        ) {
            if (responseNeeded) server?.sendResponse(device, requestId, android.bluetooth.BluetoothGatt.GATT_SUCCESS, 0, null)
            if (descriptor.uuid != CCCD) return
            handler.post {
                val id = "s:${device.address}"
                if (links.size >= MAX_LINKS && !links.containsKey(id)) {
                    runCatching { server?.cancelConnection(device) }
                    return@post
                }
                val l = links.getOrPut(id) { Link(id, device, viaServer = true) }
                if (!l.ready) {
                    l.ready = true
                    listener?.onLinkUp(id)
                }
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic, preparedWrite: Boolean,
            responseNeeded: Boolean, offset: Int, value: ByteArray,
        ) {
            if (responseNeeded) server?.sendResponse(device, requestId, android.bluetooth.BluetoothGatt.GATT_SUCCESS, 0, null)
            val copy = value.copyOf()
            handler.post { links["s:${device.address}"]?.let { received(it, copy) } }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            handler.post { links["s:${device.address}"]?.let { it.busy = false; pump(it) } }
        }
    }

    private fun startAdvertising() {
        val advertiser = manager?.adapter?.bluetoothLeAdvertiser ?: return
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        val data = AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(SERVICE)).build()
        val scanResponse = AdvertiseData.Builder().setIncludeDeviceName(false).addManufacturerData(COMPANY_ID, nodeId).build()
        val callback = object : AdvertiseCallback() {}
        advertiseCallback = callback
        advertiser.startAdvertising(settings, data, scanResponse, callback)
    }

    /* ---------------- reaching out ---------------- */

    private fun startScan() {
        val scanner = manager?.adapter?.bluetoothLeScanner ?: return
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val theirId = result.scanRecord?.getManufacturerSpecificData(COMPANY_ID) ?: return
                // Only the phone with the smaller node id connects out, so a pair never links twice.
                if (compare(nodeId, theirId) >= 0) return
                handler.post { connectTo(result.device) }
            }
        }
        scanCallback = callback
        scanner.startScan(listOf(filter), settings, callback)
    }

    private fun compare(a: ByteArray, b: ByteArray): Int {
        for (i in 0 until minOf(a.size, b.size)) {
            val d = (a[i].toInt() and 0xff) - (b[i].toInt() and 0xff)
            if (d != 0) return d
        }
        return a.size - b.size
    }

    private fun connectTo(device: BluetoothDevice) {
        val id = "c:${device.address}"
        if (!started || links.containsKey(id) || !connecting.add(id) || links.size + connecting.size > MAX_LINKS) {
            connecting.remove(id)
            return
        }
        val l = Link(id, device, viaServer = false)
        l.gatt = device.connectGatt(context, false, clientCallback(l), BluetoothDevice.TRANSPORT_LE)
    }

    private fun clientCallback(l: Link) = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED) {
                    if (!gatt.requestMtu(REQUESTED_MTU)) gatt.discoverServices()
                } else {
                    connecting.remove(l.id)
                    drop(l)
                }
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            handler.post {
                l.mtu = mtu
                gatt.discoverServices()
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            handler.post {
                val service = gatt.getService(SERVICE)
                val tx = service?.getCharacteristic(TX)
                l.rx = service?.getCharacteristic(RX)
                val cccd = tx?.getDescriptor(CCCD)
                if (tx == null || l.rx == null || cccd == null) {
                    connecting.remove(l.id)
                    drop(l)
                    return@post
                }
                gatt.setCharacteristicNotification(tx, true)
                if (Build.VERSION.SDK_INT >= 33) gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                else {
                    @Suppress("DEPRECATION")
                    cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    gatt.writeDescriptor(cccd)
                }
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            handler.post {
                connecting.remove(l.id)
                if (status == BluetoothGatt.GATT_SUCCESS && !l.ready) {
                    links[l.id] = l
                    l.ready = true
                    listener?.onLinkUp(l.id)
                } else if (status != BluetoothGatt.GATT_SUCCESS) {
                    drop(l)
                }
            }
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            val copy = value.copyOf()
            handler.post { received(l, copy) }
        }

        @Deprecated("Kept for API 31 and older")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            val copy = characteristic.value?.copyOf() ?: return
            handler.post { received(l, copy) }
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            handler.post { l.busy = false; pump(l) }
        }
    }

    /* ---------------- shared ---------------- */

    private fun received(l: Link, chunk: ByteArray) {
        val bytes = try {
            l.reassembler.push(chunk)
        } catch (_: BleFramingException) {
            l.reassembler.reset()
            null
        } ?: return
        listener?.onPacket(l.id, String(bytes, Charsets.UTF_8))
    }

    /** One chunk at a time; the next goes out when the radio says the last one is done (or after a short wait). */
    private fun pump(l: Link) {
        if (l.busy || !l.ready) return
        val chunk = l.outbound.removeFirstOrNull() ?: return
        l.busy = true
        val ok = if (l.viaServer) notify(l, chunk) else write(l, chunk)
        if (!ok) l.busy = false
        handler.postDelayed({ if (l.busy) { l.busy = false; pump(l) } }, PACE_TIMEOUT_MS)
    }

    private fun notify(l: Link, chunk: ByteArray): Boolean {
        val tx = txChar ?: return false
        val srv = server ?: return false
        return if (Build.VERSION.SDK_INT >= 33) {
            srv.notifyCharacteristicChanged(l.device, tx, false, chunk) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            tx.value = chunk
            @Suppress("DEPRECATION")
            srv.notifyCharacteristicChanged(l.device, tx, false)
        }
    }

    private fun write(l: Link, chunk: ByteArray): Boolean {
        val gatt = l.gatt ?: return false
        val rx = l.rx ?: return false
        return if (Build.VERSION.SDK_INT >= 33) {
            gatt.writeCharacteristic(rx, chunk, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            @Suppress("DEPRECATION")
            rx.value = chunk
            @Suppress("DEPRECATION")
            gatt.writeCharacteristic(rx)
        }
    }

    private fun drop(l: Link) {
        val wasReady = l.ready
        l.ready = false
        links.remove(l.id)
        connecting.remove(l.id)
        runCatching { l.gatt?.close() }
        if (l.viaServer) runCatching { server?.cancelConnection(l.device) }
        if (wasReady) listener?.onLinkDown(l.id)
    }
}
