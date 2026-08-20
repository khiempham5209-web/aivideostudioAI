// Local login for the desktop app: a self-set password and/or a TOTP
// authenticator (RFC 6238, same algorithm Google Authenticator/Authy use)
// instead of real Google OAuth — this app never actually needs Google's
// identity, and typing a real Google password on every launch is slow.
// Neither mechanism talks to Google; "Google"-styled UI is cosmetic only.
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import QRCode from "qrcode";

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, salt, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hashHex) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hashHex, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 6238 TOTP: 30s step, 6 digits, SHA-1 (the universal default every
 *  authenticator app — Google Authenticator, Authy, 1Password — supports). */
function totpAt(secret: string, timeStepIndex: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStepIndex));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binCode % 1_000_000).padStart(6, "0");
}

/** Accepts the current 30s window plus one step of clock drift either way —
 *  phones and this machine's clock are rarely perfectly in sync. */
export function verifyTotpCode(secret: string, code: string): boolean {
  const clean = code.trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const drift of [0, -1, 1]) {
    if (totpAt(secret, step + drift) === clean) return true;
  }
  return false;
}

export async function buildTotpQrCode(secret: string, email: string): Promise<string> {
  const issuer = "AI Video Studio";
  const label = encodeURIComponent(`${issuer}:${email}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return QRCode.toDataURL(uri, { width: 240, margin: 1 });
}
