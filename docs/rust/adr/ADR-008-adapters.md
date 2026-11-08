# ADR-008: WebRTC and Bluetooth stay platform adapters
**Decision.** Keep each platform's WebRTC and BLE stacks behind the `Transport` port, as the PRD recommends. The engine owns authentication, retry and fallback policy; adapters own radios and data channels.
**Revisit if** a shared Rust WebRTC implementation proves reliable on all targets.
