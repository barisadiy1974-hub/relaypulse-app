// Offline license key verification (Ed25519). No network call, no server.
//
// Key format: RP1-<serial>-<signature>
//   serial    = 8 hex chars
//   signature = Ed25519 signature over the serial, base64url (86 chars)
//
// Only the PUBLIC key lives here, so this file is safe to publish. Keys can be
// verified with it but not created — creating one needs the private key, which
// never leaves the developer's machine (see tools/generate-license.js).
const crypto = require('crypto');

const PUBLIC_KEY_B64 = '/xXI756LTRLUTK5d98c7s9UPeZD9yjUflw9u2cMUkOw=';

// Wrap the raw 32-byte key in the SPKI header Node needs to import it.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const publicKey = crypto.createPublicKey({
  key: Buffer.concat([SPKI_PREFIX, Buffer.from(PUBLIC_KEY_B64, 'base64')]),
  format: 'der',
  type: 'spki'
});

function verifyLicenseKey(key) {
  const cleaned = String(key || '').trim().replace(/\s+/g, '');
  const parts = cleaned.split('-');
  if (parts.length !== 3) return false;
  const [prefix, serial, signature] = parts;
  if (prefix.toUpperCase() !== 'RP1') return false;
  if (!/^[0-9a-fA-F]{8}$/.test(serial)) return false;
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(serial.toLowerCase()),
      publicKey,
      Buffer.from(signature, 'base64url')
    );
  } catch {
    return false;
  }
}

module.exports = { verifyLicenseKey };
