// Starts the real self-hosted relay (relay/server.js) on a free port and prints the port, then runs until killed.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRelay } from '../../../../relay/server.js';

const relay = await startRelay({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'privcord-relay-')), allowStoreForward: true });
console.log(`PORT ${relay.port}`);
setInterval(() => {}, 1 << 30);
