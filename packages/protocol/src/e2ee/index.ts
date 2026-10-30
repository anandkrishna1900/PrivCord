/**
 * DuoChat E2EE core (Phase 2 of the decentralization redesign).
 * See docs/E2EE_PROTOCOL.md for the specification, the rationale for the
 * NIST P-256 / WebCrypto choice, and the honest deviations from Curve25519
 * Signal deployments.
 */
export * from './primitives';
export * from './x3dh';
export * from './ratchet';
export * from './envelope';
