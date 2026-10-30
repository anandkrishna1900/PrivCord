import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  canonicalJson,
  createEcdhKeypair,
  ecdhAgree,
  ecdsaSign,
  ecdsaVerify,
  fromB64Url,
  hkdf,
  randomBytes,
  toB64Url,
  validatePublicJwk,
  type EcdhKeypair,
  type PrivateJwk,
  type PublicJwk,
} from '../e2ee';

/**
 * Authenticated, encrypted frames for links that are not encrypted by themselves
 * (Bluetooth LE). Ephemeral ECDH gives forward secrecy; each side signs its ephemeral key
 * with its pinned identity key, so only the paired contact can complete the handshake.
 */
export interface ScHello {
  v: 1;
  kind: 'sc_hello';
  epk: PublicJwk;
  nonce: string;
  sig: string;
}

export interface ScData {
  v: 1;
  kind: 'sc_data';
  n: number;
  ct: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_COUNTER = 2 ** 48;

function helloPayload(ownUid: string, peerUid: string, epk: PublicJwk, nonce: string): Uint8Array {
  return enc.encode(`duochat-sc-v1|${ownUid}|${peerUid}|${canonicalJson({ crv: epk.crv, kty: epk.kty, x: epk.x, y: epk.y })}|${nonce}`);
}

function iv(counter: number): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, BigInt(counter));
  return out;
}

export function isScHello(value: unknown): value is ScHello {
  const h = value as ScHello | null;
  return (
    typeof h === 'object' && h !== null && h.v === 1 && h.kind === 'sc_hello' &&
    validatePublicJwk(h.epk) && typeof h.nonce === 'string' && h.nonce.length >= 16 && typeof h.sig === 'string'
  );
}

export function isScData(value: unknown): value is ScData {
  const d = value as ScData | null;
  return (
    typeof d === 'object' && d !== null && d.v === 1 && d.kind === 'sc_data' &&
    Number.isSafeInteger(d.n) && d.n >= 0 && typeof d.ct === 'string'
  );
}

export class SecureChannel {
  private sendKey: Uint8Array | null = null;
  private recvKey: Uint8Array | null = null;
  private sendCounter = 0;
  private recvCounter = -1;

  private constructor(
    private readonly ownUid: string,
    private readonly peerUid: string,
    private readonly signPriv: PrivateJwk,
    private readonly peerSign: PublicJwk,
    private readonly eph: EcdhKeypair,
    private readonly nonce: string,
  ) {}

  static async create(input: {
    ownUid: string;
    peerUid: string;
    signPriv: PrivateJwk;
    /** The pinned contact's ECDSA identity key. */
    peerSign: PublicJwk;
  }): Promise<SecureChannel> {
    const eph = await createEcdhKeypair();
    const nonce = toB64Url(randomBytes(16));
    return new SecureChannel(input.ownUid, input.peerUid, input.signPriv, input.peerSign, eph, nonce);
  }

  get ready(): boolean {
    return this.sendKey !== null && this.recvKey !== null;
  }

  async hello(): Promise<ScHello> {
    const epk: PublicJwk = { kty: this.eph.pubJwk.kty, crv: this.eph.pubJwk.crv, x: this.eph.pubJwk.x, y: this.eph.pubJwk.y };
    const sig = toB64Url(await ecdsaSign(this.signPriv, helloPayload(this.ownUid, this.peerUid, epk, this.nonce)));
    return { v: 1, kind: 'sc_hello', epk, nonce: this.nonce, sig };
  }

  /** Verify the peer's signed ephemeral key and derive both directions' keys. Throws if it is not the pinned contact. */
  async accept(hello: ScHello): Promise<void> {
    if (this.ready) throw new Error('Secure channel already established.');
    const ok = await ecdsaVerify(
      this.peerSign,
      fromB64Url(hello.sig),
      // The peer signed (its uid | our uid), so swap the order when verifying.
      helloPayload(this.peerUid, this.ownUid, hello.epk, hello.nonce),
    );
    if (!ok) throw new Error('Secure channel handshake was not signed by the paired contact.');
    const shared = await ecdhAgree(this.eph.privJwk, hello.epk);
    const lowIsMe = this.ownUid < this.peerUid;
    const [nLow, nHigh] = lowIsMe ? [this.nonce, hello.nonce] : [hello.nonce, this.nonce];
    const salt = enc.encode(`${nLow}|${nHigh}`);
    const low = await hkdf(shared, salt, enc.encode('duochat-sc-v1|low->high'), 32);
    const high = await hkdf(shared, salt, enc.encode('duochat-sc-v1|high->low'), 32);
    this.sendKey = lowIsMe ? low : high;
    this.recvKey = lowIsMe ? high : low;
  }

  async encrypt(value: unknown): Promise<ScData> {
    if (!this.sendKey) throw new Error('Secure channel is not established.');
    if (this.sendCounter >= MAX_COUNTER) throw new Error('Secure channel exhausted; reconnect.');
    const n = this.sendCounter++;
    const ct = await aesGcmEncrypt(this.sendKey, iv(n), enc.encode(JSON.stringify(value)), enc.encode(`sc|${n}`));
    return { v: 1, kind: 'sc_data', n, ct: toB64Url(ct) };
  }

  /** Rejects tampering, wrong keys, and any replayed or reordered counter. */
  async decrypt(frame: ScData): Promise<unknown> {
    if (!this.recvKey) throw new Error('Secure channel is not established.');
    if (frame.n <= this.recvCounter) throw new Error('Replayed or out-of-order frame.');
    const plain = await aesGcmDecrypt(this.recvKey, iv(frame.n), fromB64Url(frame.ct), enc.encode(`sc|${frame.n}`));
    this.recvCounter = frame.n;
    return JSON.parse(dec.decode(plain)) as unknown;
  }
}
