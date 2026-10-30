/**
 * Deterministic NIST P-256 public-key derivation from a private scalar.
 *
 * Purpose: a recovery phrase must restore the *same* EC keys on any platform.
 * WebCrypto can generate keys but cannot reconstruct a public point from a raw
 * scalar, so this module implements the textbook scalar multiplication over
 * P-256 (NIST SP 800-186 § G.1.2 constants) using BigInt Jacobian coordinates.
 *
 * This is NOT a new or custom algorithm: it is the standard elliptic-curve
 * operation (double-and-add on a short-Weierstrass prime curve), the same
 * operation WebCrypto itself performs internally. Correctness is cross-checked
 * against WebCrypto in the test suite (random WebCrypto keypairs must match
 * this implementation bit-for-bit), which also validates every constant.
 *
 * No secret material is cached or logged here.
 */

export class ScalarP256Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScalarP256Error';
  }
}

/* NIST SP 800-186 § G.1.2 curve P-256 (also FIPS 186-4 D.1.2.3). */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = P - 3n; // equation a = -3
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

export { N as P256_ORDER, P as P256_PRIME };

interface JacobianPoint {
  /** Jacobian coordinates; infinity is (0, 1, 0). */
  x: bigint;
  y: bigint;
  z: bigint;
}

const INFINITY: JacobianPoint = { x: 0n, y: 1n, z: 0n };

function isInfinity(p: JacobianPoint): boolean {
  return p.z === 0n;
}

function mod(value: bigint): bigint {
  const r = value % P;
  return r < 0n ? r + P : r;
}

function inverseModP(value: bigint): bigint {
  const v = mod(value);
  if (v === 0n) throw new ScalarP256Error('Cannot invert zero.');
  // Extended Euclidean algorithm over the prime field.
  let lm = v;
  let hm = P;
  let low = 1n;
  let high = 0n;
  while (lm > 1n) {
    const r = hm / lm;
    const [nlm, nhm] = [hm % lm, lm];
    hm = lm;
    lm = nlm;
    const [nlow, nhigh] = [high - r * low, low];
    high = nhigh;
    low = nlow;
  }
  return mod(low);
}

function jacobianDouble(p: JacobianPoint): JacobianPoint {
  if (isInfinity(p) || p.y === 0n) return INFINITY;
  // General Jacobian doubling: A = Y1², B = X1², S = 4X1A, M = 3X1² + aZ1⁴.
  const ySq = mod(p.y * p.y);
  const s = mod(4n * p.x * ySq);
  const m = mod(3n * p.x * p.x + A * p.z * p.z * p.z * p.z);
  const t = mod(m * m - 2n * s);
  const x = t;
  const y = mod(m * (s - t) - 8n * ySq * ySq);
  const z = mod(2n * p.y * p.z);
  return { x, y, z };
}

function jacobianAdd(p: JacobianPoint, q: JacobianPoint): JacobianPoint {
  if (isInfinity(p)) return q;
  if (isInfinity(q)) return p;
  const z1Sq = mod(p.z * p.z);
  const z2Sq = mod(q.z * q.z);
  const u1 = mod(p.x * z2Sq);
  const u2 = mod(q.x * z1Sq);
  const s1 = mod(p.y * z2Sq * q.z);
  const s2 = mod(q.y * z1Sq * p.z);
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  if (h === 0n) {
    if (r === 0n) return jacobianDouble(p);
    return INFINITY; // P = -Q
  }
  const hSq = mod(h * h);
  const hCube = mod(hSq * h);
  const u1hSq = mod(u1 * hSq);
  const x = mod(r * r - hCube - 2n * u1hSq);
  const y = mod(r * (u1hSq - x) - s1 * hCube);
  const z = mod(p.z * q.z * h);
  return { x, y, z };
}

function toAffine(p: JacobianPoint): { x: bigint; y: bigint } {
  if (isInfinity(p)) throw new ScalarP256Error('Point at infinity has no affine coordinates.');
  const zInv = inverseModP(p.z);
  const zInvSq = mod(zInv * zInv);
  return { x: mod(p.x * zInvSq), y: mod(p.y * zInvSq * zInv) };
}

function onCurve(point: { x: bigint; y: bigint }): boolean {
  // y² = x³ + ax + b (mod p)
  const lhs = mod(point.y * point.y);
  const rhs = mod(point.x * point.x * point.x + A * point.x + B);
  return lhs === rhs;
}

/**
 * Big-endian fixed 32-byte encoding of a field element.
 */
export function scalarToBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function bytesToScalar(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b & 0xff);
  return v;
}

/**
 * Compute the public point (x, y) for private scalar `d` on P-256.
 * `d` must be an integer with 1 ≤ d < n (epoch generation excluded).
 */
export function publicPointFromScalar(scalarBytes: Uint8Array): {
  x: Uint8Array;
  y: Uint8Array;
} {
  if (scalarBytes.length !== 32) {
    throw new ScalarP256Error('P-256 scalar must be exactly 32 bytes.');
  }
  const d = bytesToScalar(scalarBytes);
  if (d === 0n || d >= N) {
    throw new ScalarP256Error('P-256 scalar out of range.');
  }
  let result = INFINITY;
  let addend: JacobianPoint = { x: GX, y: GY, z: 1n };
  for (let i = 0n; i < 256n; i += 1n) {
    const bit = (d >> i) & 1n;
    if (bit === 1n) {
      result = jacobianAdd(result, addend);
    }
    addend = jacobianDouble(addend);
  }
  const affine = toAffine(result);
  if (!onCurve(affine)) {
    throw new ScalarP256Error('Derived point is off the curve.');
  }
  return {
    x: scalarToBytes(affine.x),
    y: scalarToBytes(affine.y),
  };
}
