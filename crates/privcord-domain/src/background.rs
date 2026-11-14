//! What the engine may do in the background, decided once for every platform (docs/design/syncengine.md §10).
//!
//! Each platform reports what it knows about the device (battery, charging, network, power saver, whether the app is
//! on screen); this decides what may run. Platforms carry the decision out (how they scan Bluetooth, when they move
//! bulk data) but never make it themselves, so a phone and a laptop behave the same in the same situation.

/// The kind of network the device is on right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkKind {
    None,
    /// Wi-Fi or Ethernet that is not metered.
    Unmetered,
    /// Mobile data, a hotspot, or any network the system reports as metered.
    Metered,
}

/// How hard to look for Bluetooth neighbours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BleScan {
    Off,
    /// Short, rare scan windows: neighbours are still found, slowly.
    LowPower,
    /// The app is on screen: find neighbours quickly.
    Balanced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceState {
    /// Battery level 0–100, or `None` for a device with no battery (a desktop on mains power).
    pub battery_percent: Option<u8>,
    pub charging: bool,
    pub network: NetworkKind,
    /// The system's data saver is on (Android Data Saver, Windows metered-connection settings).
    pub data_saver: bool,
    /// The system's battery saver is on.
    pub power_saver: bool,
    /// The app is on screen.
    pub foreground: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// Keep the relay connections and sync small entries over the internet.
    pub internet_sync: bool,
    /// Move bulk data (media, history backfill). Live messages are never held back by this.
    pub bulk: bool,
    pub ble_scan: BleScan,
}

/// Battery at or below this, and not charging, counts as low.
pub const LOW_BATTERY: u8 = 15;
/// Battery at or below this, and not charging, stops everything that is not live chat.
pub const CRITICAL_BATTERY: u8 = 5;
/// Bulk transfer on battery needs at least this much charge.
pub const BULK_MIN_BATTERY: u8 = 30;

pub fn plan(s: DeviceState) -> Plan {
    let on_power = s.charging || s.battery_percent.is_none();
    let level = s.battery_percent.unwrap_or(100);
    let low = !on_power && level <= LOW_BATTERY;
    let critical = !on_power && level <= CRITICAL_BATTERY;
    let online = s.network != NetworkKind::None;

    let internet_sync = online && !critical;
    let bulk = online
        && s.network == NetworkKind::Unmetered
        && !s.data_saver
        && !s.power_saver
        && !low
        && (on_power || level >= BULK_MIN_BATTERY);
    let ble_scan = if critical || (low && !s.foreground) || (s.power_saver && !s.foreground) {
        BleScan::Off
    } else if s.foreground {
        BleScan::Balanced
    } else {
        BleScan::LowPower
    };
    Plan {
        internet_sync,
        bulk,
        ble_scan,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device() -> DeviceState {
        DeviceState {
            battery_percent: Some(80),
            charging: false,
            network: NetworkKind::Unmetered,
            data_saver: false,
            power_saver: false,
            foreground: false,
        }
    }

    #[test]
    fn a_healthy_phone_in_the_background_syncs_and_scans_gently() {
        let p = plan(device());
        assert!(p.internet_sync && p.bulk);
        assert_eq!(p.ble_scan, BleScan::LowPower);
        assert_eq!(
            plan(DeviceState {
                foreground: true,
                ..device()
            })
            .ble_scan,
            BleScan::Balanced
        );
    }

    #[test]
    fn bulk_waits_for_unmetered_networks_and_respects_data_saver() {
        assert!(
            !plan(DeviceState {
                network: NetworkKind::Metered,
                ..device()
            })
            .bulk
        );
        assert!(
            plan(DeviceState {
                network: NetworkKind::Metered,
                ..device()
            })
            .internet_sync
        );
        assert!(
            !plan(DeviceState {
                data_saver: true,
                ..device()
            })
            .bulk
        );
    }

    #[test]
    fn low_battery_stops_bulk_and_background_scanning_but_not_chat() {
        let low = DeviceState {
            battery_percent: Some(LOW_BATTERY),
            ..device()
        };
        let p = plan(low);
        assert!(!p.bulk && p.internet_sync);
        assert_eq!(p.ble_scan, BleScan::Off);
        // On screen, the person may be using Bluetooth right now.
        assert_eq!(
            plan(DeviceState {
                foreground: true,
                ..low
            })
            .ble_scan,
            BleScan::Balanced
        );
        // Between low and the bulk minimum: sync yes, bulk no.
        assert!(
            !plan(DeviceState {
                battery_percent: Some(BULK_MIN_BATTERY - 1),
                ..device()
            })
            .bulk
        );
    }

    #[test]
    fn critical_battery_keeps_only_live_chat() {
        let p = plan(DeviceState {
            battery_percent: Some(CRITICAL_BATTERY),
            foreground: true,
            ..device()
        });
        assert!(!p.internet_sync && !p.bulk);
        assert_eq!(p.ble_scan, BleScan::Off);
    }

    #[test]
    fn charging_or_no_battery_lifts_the_battery_limits() {
        let charging = DeviceState {
            battery_percent: Some(3),
            charging: true,
            ..device()
        };
        assert_eq!(
            plan(charging),
            plan(DeviceState {
                battery_percent: None,
                ..device()
            })
        );
        assert!(plan(charging).bulk);
    }

    #[test]
    fn power_saver_stops_bulk_and_background_scanning() {
        let p = plan(DeviceState {
            power_saver: true,
            ..device()
        });
        assert!(!p.bulk && p.internet_sync);
        assert_eq!(p.ble_scan, BleScan::Off);
    }

    #[test]
    fn offline_means_no_internet_work_but_bluetooth_still_scans() {
        let p = plan(DeviceState {
            network: NetworkKind::None,
            ..device()
        });
        assert!(!p.internet_sync && !p.bulk);
        assert_eq!(p.ble_scan, BleScan::LowPower);
    }
}
