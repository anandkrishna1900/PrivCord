import { startRelay } from './server.js';

const relay = await startRelay({
  port: Number(process.env.PORT ?? 8787),
  dataDir: process.env.DATA_DIR ?? './data',
  allowStoreForward: process.env.ALLOW_STORE_FORWARD === 'true',
  rateLimit: Number(process.env.RATE_LIMIT ?? 120),
});
console.log(`duochat-relay listening on :${relay.port} (store-and-forward ${process.env.ALLOW_STORE_FORWARD === 'true' ? 'on' : 'off'})`);

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    await relay.close();
    process.exit(0);
  });
}
