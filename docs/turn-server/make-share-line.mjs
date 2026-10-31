// Usage: node make-share-line.mjs <public-ip-or-host> <password>   (the password from turnserver.conf)
// Prints the single PRIVCORD-TURN1: line to paste into Settings > Connection. It contains the password: share it only
// with people you want to let use your relay.
const [host, password] = process.argv.slice(2);
if (!host || !password) { console.error('usage: node make-share-line.mjs <host> <password>'); process.exit(1); }
const json = JSON.stringify({ u: [`turn:${host}:3478`, `turn:${host}:3478?transport=tcp`], n: 'privcord', c: password });
console.log('PRIVCORD-TURN1:' + Buffer.from(json, 'utf8').toString('base64url'));
