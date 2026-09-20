// Trust-on-first-use pinning for the relay agents' self-signed certificates.
//
// Before this, every agent request set `rejectUnauthorized = false`, so the
// X-Agent-Token went to whoever answered on the agent port. Anyone able to sit
// between this Mac and the relay (hotel wifi, a hostile upstream) could collect
// the token of every relay in the fleet by presenting their own certificate.
//
// The certificate is remembered the first time a relay answers and pinned as
// the only accepted CA afterwards, so a mismatch is refused during the TLS
// handshake — before the token is written to the socket. Matches the iOS app.
//
// ponytail: TOFU, so a first connection made through an attacker pins the
// attacker. Closing that needs the agent installer to carry the cert back.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'agent-cert-pins.json');
}

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch { cache = {}; }
  return cache;
}

function save() {
  try { fs.writeFileSync(file(), JSON.stringify(cache, null, 2)); } catch {}
}

function toPem(der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/// Pinned host: that certificate is the only CA, and the hostname check is
/// skipped because a self-signed agent cert has no matching CN — the pin is
/// what proves identity. Unpinned host: accept anything, then learn it.
function apply(opts, host) {
  const pem = load()[host];
  if (pem) {
    opts.ca = [pem];
    opts.rejectUnauthorized = true;
    opts.checkServerIdentity = () => undefined;
  } else {
    opts.rejectUnauthorized = false;
  }
}

function learn(host, res) {
  if (load()[host]) return;
  const sock = res && res.socket;
  const cert = sock && sock.getPeerCertificate && sock.getPeerCertificate();
  if (!cert || !cert.raw) return;
  cache[host] = toPem(cert.raw);
  save();
}

/// Turns node's TLS error codes into the one sentence that explains what to do.
const PIN_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function describe(err) {
  if (err && PIN_CODES.has(err.code)) {
    return 'Agent certificate changed — if you reinstalled the agent, use Settings > "Reset pinned certificates"';
  }
  return null;
}

function reset() {
  cache = {};
  save();
  return true;
}

function count() {
  return Object.keys(load()).length;
}

module.exports = { apply, learn, describe, reset, count };
