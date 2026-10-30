//! Bluetooth LE *central* role for the desktop app (docs/BLE_TRANSPORT.md).
//!
//! UNTESTED on hardware. btleplug cannot act as a GATT peripheral on Windows, so the
//! desktop only scans for a paired phone's rotating tag, connects, subscribes to the TX
//! characteristic and writes to the RX characteristic. Chunking/reassembly lives in the
//! webview (src/lib/bleFraming.ts); this module only moves raw bytes.

use btleplug::api::{
    Central, CentralEvent, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Manager, Peripheral};
use futures::StreamExt;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

pub const SERVICE_UUID: Uuid = Uuid::from_u128(0xfee43cae_8420_4563_8172_f73479794ee7);
/// Central writes (without response) here.
pub const RX_UUID: Uuid = Uuid::from_u128(0xfee43cae_8420_4563_8172_f73479794ee8);
/// Peripheral notifies here.
pub const TX_UUID: Uuid = Uuid::from_u128(0xfee43cae_8420_4563_8172_f73479794ee9);
/// Bluetooth SIG company id reserved for testing; the 8-byte rotating tag follows in the manufacturer data.
pub const COMPANY_ID: u16 = 0xFFFF;
pub const TAG_BYTES: usize = 8;
/// ATT header overhead subtracted from the negotiated MTU.
const ATT_OVERHEAD: usize = 3;
/// Used when the OS does not report an MTU: the BLE default of 23 minus ATT overhead.
const DEFAULT_PAYLOAD: usize = 20;

#[derive(Debug, Clone)]
pub enum BleEvent {
    Open { max_chunk: usize },
    Chunk(Vec<u8>),
    Close,
    Error(String),
}

pub type Sink = Arc<dyn Fn(BleEvent) + Send + Sync>;

pub struct BleLink {
    peripheral: Peripheral,
    rx: Characteristic,
    max_chunk: usize,
}

impl BleLink {
    pub fn max_chunk(&self) -> usize {
        self.max_chunk
    }

    /// Write one already-framed chunk. Callers must keep it within `max_chunk`.
    pub async fn write(&self, chunk: &[u8]) -> Result<(), String> {
        if chunk.len() > self.max_chunk {
            return Err(format!("chunk of {} bytes exceeds {}", chunk.len(), self.max_chunk));
        }
        self.peripheral
            .write(&self.rx, chunk, WriteType::WithoutResponse)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn disconnect(&self) {
        let _ = self.peripheral.disconnect().await;
    }
}

fn payload_size(mtu: u16) -> usize {
    if mtu as usize > ATT_OVERHEAD + 3 {
        mtu as usize - ATT_OVERHEAD
    } else {
        DEFAULT_PAYLOAD
    }
}

/// Scan until a device advertises one of `accept` (8-byte tags), then connect and wire up notifications.
pub async fn scan_and_connect(
    accept: Vec<Vec<u8>>,
    timeout: Duration,
    sink: Sink,
) -> Result<BleLink, String> {
    if accept.is_empty() || accept.iter().any(|t| t.len() != TAG_BYTES) {
        return Err("accept list must contain 8-byte tags".into());
    }
    let manager = Manager::new().await.map_err(|e| e.to_string())?;
    let adapter = manager
        .adapters()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or("no Bluetooth adapter found")?;
    let mut events = adapter.events().await.map_err(|e| e.to_string())?;
    // No service filter: the tag, not the service UUID, identifies our contact (the service is not advertised).
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| e.to_string())?;

    let found = tokio::time::timeout(timeout, async {
        while let Some(event) = events.next().await {
            if let CentralEvent::ManufacturerDataAdvertisement { id, manufacturer_data } = event {
                if let Some(data) = manufacturer_data.get(&COMPANY_ID) {
                    if accept.iter().any(|tag| tag.as_slice() == data.as_slice()) {
                        return Some(id);
                    }
                }
            }
        }
        None
    })
    .await;
    let _ = adapter.stop_scan().await;
    let id = found
        .map_err(|_| "scan timed out: contact not nearby".to_string())?
        .ok_or("Bluetooth event stream ended")?;

    let peripheral = adapter.peripheral(&id).await.map_err(|e| e.to_string())?;
    peripheral.connect().await.map_err(|e| e.to_string())?;
    peripheral.discover_services().await.map_err(|e| e.to_string())?;
    let chars = peripheral.characteristics();
    let find = |uuid: Uuid| {
        chars
            .iter()
            .find(|c| c.uuid == uuid && c.service_uuid == SERVICE_UUID)
            .cloned()
            .ok_or_else(|| format!("characteristic {uuid} missing"))
    };
    let (rx, tx) = (find(RX_UUID)?, find(TX_UUID)?);
    let mut notifications = peripheral.notifications().await.map_err(|e| e.to_string())?;
    peripheral.subscribe(&tx).await.map_err(|e| e.to_string())?;

    let max_chunk = payload_size(peripheral.mtu());
    let reader = sink.clone();
    let watched = peripheral.clone();
    tokio::spawn(async move {
        while let Some(n) = notifications.next().await {
            if n.uuid == TX_UUID {
                reader(BleEvent::Chunk(n.value));
            }
        }
        // Stream ended: link dropped.
        let _ = watched.disconnect().await;
        reader(BleEvent::Close);
    });
    sink(BleEvent::Open { max_chunk });
    Ok(BleLink { peripheral, rx, max_chunk })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_size_follows_mtu_with_safe_default() {
        assert_eq!(payload_size(0), 20);
        assert_eq!(payload_size(23), 20);
        assert_eq!(payload_size(185), 182);
        assert_eq!(payload_size(517), 514);
    }

    #[test]
    fn uuids_are_distinct_and_share_the_service_prefix() {
        assert_ne!(RX_UUID, TX_UUID);
        assert_eq!(SERVICE_UUID.to_string(), "fee43cae-8420-4563-8172-f73479794ee7");
        assert_eq!(RX_UUID.to_string(), "fee43cae-8420-4563-8172-f73479794ee8");
        assert_eq!(TX_UUID.to_string(), "fee43cae-8420-4563-8172-f73479794ee9");
    }
}
