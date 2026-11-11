/**
 * Whether the page runs on the Rust engine hosted in the Tauri shell. The packaged app always does. The browser build (development
 * and the end-to-end suite) has no shell to host the engine, so it runs the TypeScript one.
 */
import { isTauri } from '../../config';

export function hostedEngineAvailable(): boolean {
  return isTauri();
}

export function hostedEngineEnabled(): boolean {
  return hostedEngineAvailable();
}
