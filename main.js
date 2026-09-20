// Electron main process — tray icon + popover window + IPC bridge.
const { app, BrowserWindow, Tray, nativeImage, ipcMain, Menu, shell, clipboard, Notification, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const pkg = require('./package.json');
const demoFleet = require('./src/demo-fleet');
const networkMap = require('./network-map/window');
// Test derlemesi işareti: paket içine bir SANDBOX dosyası konursa, imzasız
// yerel test build'i de yeni ssh2 (sandbox) yolunu kullanır. Normal
// derlemelerde bu dosya yoktur, davranış değişmez. Monitor da RP_SANDBOX'a
// baktığı için env'i require'dan ÖNCE kuruyoruz.
try {
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'SANDBOX'))) {
    process.env.RP_SANDBOX = '1';
    // Test derlemesi kendi izole userData'sini kullanir; kurulu app'in
    // "relaypulse" config'ine ASLA dokunmaz.
    try { app.setPath('userData', path.join(app.getPath('appData'), 'RelayPulse2')); } catch {}
  }
} catch {}
const SANDBOX = process.mas === true || process.env.RP_SANDBOX === '1';
const sandboxTransport = SANDBOX ? require('./src/ssh2-transport') : null;
// IAP only exists in a real Mac App Store build. RP_SANDBOX test builds keep
// the sandbox transport but must NOT take the StoreKit path — they have no
// App Store receipt, so every call would fail.
const MAS = process.mas === true;
const iap = MAS ? require('./src/iap') : null;

// Mac App Store free tier: monitor up to this many relays until the lifetime
// unlock is bought. Nothing is deleted and no feature is crippled — the saved
// server list stays intact, only the monitored slice is capped. Every other
// build (Linux, Windows, direct-sale mac) is unlimited and keeps its own
// trial + license key.
const FREE_RELAY_LIMIT = 3;
function isEntitled() {
  return !MAS || iap.isPurchased();
}
function entitledServers(list) {
  const servers = Array.isArray(list) ? list : [];
  return isEntitled() ? servers : servers.slice(0, FREE_RELAY_LIMIT);
}

// A development profile pins the Macs it may run on and so carries
// ProvisionedDevices; an App Store profile runs anywhere and never lists them.
// The profile is a signed CMS blob but the plist inside it is plain text, so a
// substring test is enough. Any failure reads as "not development", which keeps
// the receipt check in force.
function isDevelopmentSigned() {
  try {
    const profile = path.join(process.resourcesPath, '..', 'embedded.provisionprofile');
    return fs.readFileSync(profile, 'latin1').includes('ProvisionedDevices');
  } catch {
    return false;
  }
}

// App Store requirement: a MAS build launched without a receipt must exit with
// code 173, which makes macOS fetch a receipt (asking for an Apple ID) and
// relaunch. Without this, IAP cannot work at all.
// A development-signed (mas-dev) build never has a receipt — it is the only way
// to exercise StoreKit's sandbox locally, so exiting would make that build
// impossible to run. Skipping the check there cannot weaken a shipped build:
// the entitlement itself still comes only from a StoreKit transaction.
if (MAS) {
  const receipt = path.join(process.resourcesPath, '..', '_MASReceipt', 'receipt');
  if (!fs.existsSync(receipt) && !isDevelopmentSigned()) process.exit(173);
}

// --- PATH fix for macOS GUI launch -----------------------------------------
// When Electron launches from Finder / dock, PATH is the barebones
// `/usr/bin:/bin:/usr/sbin:/sbin` — no Homebrew. That breaks `sshpass`
// resolution for password-auth servers. Prepend the common brew + user bin
// dirs so execFile('sshpass') and execFile('ssh') resolve like in Terminal.
(function fixPath() {
  if (process.platform !== 'darwin') return;
  const extra = [
    '/opt/homebrew/bin',    // Apple Silicon brew
    '/opt/homebrew/sbin',
    '/usr/local/bin',       // Intel brew
    '/usr/local/sbin',
    path.join(process.env.HOME || '', '.local/bin'),
  ].filter(Boolean);
  const cur = (process.env.PATH || '').split(':').filter(Boolean);
  const merged = Array.from(new Set([...extra, ...cur]));
  process.env.PATH = merged.join(':');
})();
// ---------------------------------------------------------------------------

const Monitor = require('./src/monitor');
const Config = require('./src/config');
const certPin = require('./src/cert-pin');
const { verifyLicenseKey } = require('./src/license');
const AiFixer = require('./src/ai-fixer');

// Lisans durumu config'deki `licensed` BAYRAGINDAN DEGIL, saklanan anahtarin
// Ed25519 imzasindan turetilir. Bayrak duz JSON dosyasinda duruyor; ona guvenmek
// `"licensed": true` satirini elle yazmayi gecerli bir lisans haline getiriyordu.
// Anahtar imzasi ozel anahtar olmadan uretilemez (bkz. src/license.js).
function isLicensed(cfg) {
  return verifyLicenseKey(cfg && cfg.licenseKey);
}

if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
}

// ANYONE_HOST_FALLBACK: some networks receive a blanket 404 from api.ec.anyone.tech.
// The stage host serves the same data, so fall back to it automatically and remember
// which host answered. Read-only public endpoints either way.
const _ANYONE_PRIMARY = 'api.ec.anyone.tech';
const _ANYONE_FALLBACK = 'api-stage.ec.anyone.tech';
let _anyoneHost = null;   // null = not decided yet

async function _fetchJsonOnce(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  if (!res.ok) {
    const short = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`HTTP ${res.status} @ ${url}${short ? ` :: ${short}` : ''}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const short = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`Non-JSON response @ ${url}${contentType ? ` [${contentType}]` : ''}${short ? ` :: ${short}` : ''}`);
  }
}

async function fetchJson(url) {
  if (!url.includes(_ANYONE_PRIMARY) && !url.includes(_ANYONE_FALLBACK)) {
    return _fetchJsonOnce(url);
  }
  const order = _anyoneHost
    ? [_anyoneHost, _anyoneHost === _ANYONE_PRIMARY ? _ANYONE_FALLBACK : _ANYONE_PRIMARY]
    : [_ANYONE_PRIMARY, _ANYONE_FALLBACK];
  let lastErr;
  for (const host of order) {
    const target = url.replace(_ANYONE_PRIMARY, host).replace(_ANYONE_FALLBACK, host);
    try {
      const data = await _fetchJsonOnce(target);
      if (_anyoneHost !== host) {
        _anyoneHost = host;
        console.log('[anyone-api] using', host);
      }
      return data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function _fetchJsonLegacy(url) {
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  if (!res.ok) {
    const short = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`HTTP ${res.status} @ ${url}${short ? ` :: ${short}` : ''}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const short = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`Non-JSON response @ ${url}${contentType ? ` [${contentType}]` : ''}${short ? ` :: ${short}` : ''}`);
  }
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { 'accept': 'text/plain, text/html, application/xml, text/xml;q=0.9, */*;q=0.8', ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return await res.text();
}

const ALERT_SOUNDS = {
  Basso: '/System/Library/Sounds/Basso.aiff',
  Blow: '/System/Library/Sounds/Blow.aiff',
  Bell: 'bell-generated',
  Bird: 'bird-generated',
  Clean: 'clean-generated',
  Funk: '/System/Library/Sounds/Funk.aiff',
  Hero: '/System/Library/Sounds/Hero.aiff',
  Submarine: '/System/Library/Sounds/Submarine.aiff',
};

const LINUX_SOUND_MAP = {
  Basso: 'dialog-error',
  Blow: 'message',
  Bell: 'message',
  Bird: 'message',
  Clean: 'message',
  Funk: 'bell',
  Hero: 'complete',
  Submarine: 'message',
};

const generatedAlarmPaths = new Map();
function getGeneratedAlarmPath(kind = 'Clean') {
  if (generatedAlarmPaths.has(kind) && fs.existsSync(generatedAlarmPaths.get(kind))) return generatedAlarmPaths.get(kind);
  const sampleRate = 22050;
  const durationSec = kind === 'Bird' ? 0.55 : 0.42;
  const totalSamples = Math.floor(sampleRate * durationSec);
  const pcm = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / sampleRate;
    let freq = 700;
    let envScale = 0.28;
    if (kind === 'Bell') {
      freq = t < 0.08 ? 1320 : (t < 0.2 ? 990 : 880);
      envScale = 0.24;
    } else if (kind === 'Bird') {
      freq = 1300 + (Math.sin(t * 32) * 180) + (t < 0.18 ? 420 : 0);
      envScale = 0.22;
    } else {
      freq = t < 0.16 ? 880 : 660;
      envScale = 0.28;
    }
    const fadeIn = Math.min(1, t / 0.012);
    const fadeOut = Math.min(1, Math.max(0, (durationSec - t) / 0.09));
    const env = Math.min(fadeIn, fadeOut) * envScale;
    const sample = Math.round(Math.sin(2 * Math.PI * freq * t) * 32767 * env);
    pcm.writeInt16LE(sample, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  const file = path.join(app.getPath('temp'), `anyone-monitor-${String(kind || 'clean').toLowerCase()}-alert.wav`);
  try { fs.writeFileSync(file, Buffer.concat([header, pcm])); } catch {}
  generatedAlarmPaths.set(kind, file);
  return file;
}

function playAlertSoundLinux(soundName) {
  if (soundName === 'Clean' || soundName === 'Bell' || soundName === 'Bird') {
    const wav = getGeneratedAlarmPath(soundName);
    if (fs.existsSync('/usr/bin/paplay')) { execFile('/usr/bin/paplay', [wav], () => {}); return; }
    if (fs.existsSync('/usr/bin/aplay')) { execFile('/usr/bin/aplay', [wav], () => {}); return; }
  }
  const theme = LINUX_SOUND_MAP[soundName] || 'complete';
  const dirs = [
    '/usr/share/sounds/freedesktop/stereo',
    '/usr/share/sounds/ubuntu/stereo',
    '/usr/share/sounds/gnome/default/alerts',
  ];
  const players = [
    ['/usr/bin/canberra-gtk-play', ['-i', theme]],
    ['/usr/bin/paplay', null],
    ['/usr/bin/aplay', null],
  ];
  for (const dir of dirs) {
    for (const ext of ['oga', 'ogg', 'wav']) {
      const f = path.join(dir, theme + '.' + ext);
      try {
        if (fs.existsSync(f)) {
          for (const [player, args] of players) {
            if (!fs.existsSync(player)) continue;
            execFile(player, args || [f], () => {});
            return;
          }
          return;
        }
      } catch {}
    }
  }
  try { execFile('bash', ['-c', 'echo -e "\\a"'], () => {}); } catch {}
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function stripHtml(text) {
  return decodeEntities(String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function getAlarmSettings() {
  const cfg = config.load();
  return {
    alarmEnabled: cfg.alarmEnabled !== false,
    alarmSound: ALERT_SOUNDS[cfg.alarmSound] ? cfg.alarmSound : 'Blow',
    alarmRepeatMinutes: Math.max(1, Math.min(60, Number(cfg.alarmRepeatMinutes) || 5)),
  };
}

function isAutoFixEnabled() {
  const cfg = config.load();
  return !!cfg.autoFixEnabled;
}

function playAlertSound(soundName) {
  if (SANDBOX) {
    if (win && !win.isDestroyed()) win.webContents.send('alarm:play', { soundName });
    return;
  }
  if (process.platform === 'darwin') {
    const generated = soundName === 'Clean' || soundName === 'Bell' || soundName === 'Bird';
    const file = generated ? getGeneratedAlarmPath(soundName) : (ALERT_SOUNDS[soundName] || ALERT_SOUNDS.Blow);
    execFile('afplay', [file], () => {});
  } else if (process.platform === 'linux') {
    playAlertSoundLinux(soundName);
  }
}

function showDesktopNotification(title, body, relayName) {
  try {
    if (Notification && Notification.isSupported && Notification.isSupported()) {
      const n = new Notification({
        title: String(title || 'RelayPulse'),
        body: String(body || ''),
        silent: true,
      });
      if (relayName) {
        n.on('click', () => {
          if (win) {
            win.show();
            win.focus();
            win.webContents.send('focus-relay', relayName);
          }
        });
      }
      n.show();
      return;
    }
  } catch {}
}

function notifyRelayAlarm(kind, snap, opts = {}) {
  if (!snap || !snap.name) return;
  const alarm = getAlarmSettings();
  if (!alarm.alarmEnabled) return;
  const source = opts.source === 'anon' ? 'anon service' : 'ssh';
  const autoFixActive = !!opts.autoFixActive;
  const issueLabel = snap.issueKind ? ` [${snap.issueKind}]` : '';
  const title = kind === 'offline'
    ? `Relay Offline${issueLabel}: ${snap.name}`
    : kind === 'lowram'
    ? `Low RAM: ${snap.name}`
    : `Relay Back Online${issueLabel}: ${snap.name}`;
  const body = kind === 'offline'
    ? `${String(snap.error || 'Relay entered offline state.').slice(0, 180)}${issueLabel}${autoFixActive ? '\nAI auto-fix started.' : ''}`
    : kind === 'lowram'
    ? `Critical memory: ${snap.mem ? snap.mem.pct : '?'}% used, available RAM is low. Freeze/OOM risk — check it.`
    : `Relay appears to be back online. Source: ${source}`;
  playAlertSound(alarm.alarmSound);
  showDesktopNotification(title, body, snap.name);
}

function normalizeRelayFingerprint(value) {
  const cleaned = String(value || '').trim().replace(/^\$/, '');
  const match = cleaned.match(/^[A-Fa-f0-9]{40}$/) || cleaned.match(/\$?([A-Fa-f0-9]{40})/);
  return match ? String(match[1] || match[0]).replace(/^\$/, '').toUpperCase() : '';
}

function formatMyFamilyLine(fingerprints) {
  const clean = Array.from(new Set((fingerprints || []).map(normalizeRelayFingerprint).filter(Boolean)));
  return clean.length ? `MyFamily ${clean.map((fp) => `$${fp}`).join(',')}` : '';
}

function parseMyFamilyFingerprints(lines) {
  return Array.from(new Set((lines || [])
    .flatMap((line) => String(line || '').replace(/^MyFamily\s+/i, '').split(/[,\s]+/))
    .map(normalizeRelayFingerprint)
    .filter(Boolean)));
}

function rememberFallbackFingerprint(map, label, fingerprint) {
  const key = String(label || '').trim();
  const fp = normalizeRelayFingerprint(fingerprint);
  if (!key || !fp) return;
  map.set(key, fp);
  map.set(key.toLowerCase(), fp);
}

function rememberFallbackFingerprintLine(map, line) {
  const text = String(line || '').trim();
  const match = text.match(/\$?[A-Fa-f0-9]{40}/);
  if (!match) return;
  const fingerprint = normalizeRelayFingerprint(match[0]);
  const before = text.slice(0, match.index).replace(/[:\s$]+$/g, '').trim();
  const label = before.includes(':') ? before.split(':')[0].trim() : before.split(/\s+/)[0];
  rememberFallbackFingerprint(map, label, fingerprint);
}

function lookupFallbackFingerprint(map, server) {
  for (const key of [server.name, server.sshAlias, server.host]) {
    const label = String(key || '').trim();
    if (!label) continue;
    const fp = map.get(label) || map.get(label.toLowerCase());
    if (fp) return fp;
  }
  return '';
}

async function fetchAllRelayFingerprints() {
  const cfg = config.load();
  const servers = cfg.servers || [];
  const fallbackFingerprints = new Map();
  const fallbackPaths = [
    path.join(app.getPath('userData'), 'ALL_FINGERPRINTS.txt'),
    path.join(app.getPath('home'), 'anon-backup', 'ALL_FINGERPRINTS.txt'),
    path.join(app.getPath('desktop'), 'ALL_FINGERPRINTS.txt'),
  ];
  for (const fallbackPath of fallbackPaths) {
    try {
      const text = fs.readFileSync(fallbackPath, 'utf8');
      for (const line of text.split('\n')) {
        rememberFallbackFingerprintLine(fallbackFingerprints, line);
      }
    } catch {}
  }
  const auditTimeoutMs = 22000;
  const auditOne = async (s) => {
    try {
      const audit = await Promise.race([
        monitor.auditRelay(s),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `audit timeout (${Math.round(auditTimeoutMs / 1000)}s)` }), auditTimeoutMs)),
      ]);
      const parsed = audit.parsed || {};
      const fallbackFingerprint = lookupFallbackFingerprint(fallbackFingerprints, s);
      const sshFingerprint = normalizeRelayFingerprint(parsed.FINGERPRINT);
      const fingerprint = sshFingerprint || fallbackFingerprint;
      return {
        name: s.name,
        ok: !!fingerprint,
        auditOk: !!audit.ok,
        fingerprintSource: sshFingerprint ? 'ssh' : (fallbackFingerprint ? 'fallback' : ''),
        fingerprint,
        nickname: parsed.nickname || '',
        contact: parsed.contact || '',
        myFamily: parsed.myFamily || '',
        myFamilyLines: Array.isArray(parsed.myFamilyLines) ? parsed.myFamilyLines : (parsed.myFamily ? [parsed.myFamily] : []),
        error: audit.ok ? '' : (audit.error || 'audit fail'),
      };
    } catch (e) {
      const fallbackFingerprint = lookupFallbackFingerprint(fallbackFingerprints, s);
      return {
        name: s.name,
        ok: !!fallbackFingerprint,
        auditOk: false,
        fingerprintSource: fallbackFingerprint ? 'fallback' : '',
        fingerprint: fallbackFingerprint,
        nickname: '',
        contact: '',
        myFamily: '',
        myFamilyLines: [],
        error: fallbackFingerprint ? '' : e.message,
      };
    }
  };
  const rows = [];
  const concurrency = 6;
  for (let i = 0; i < servers.length; i += concurrency) {
    const batch = servers.slice(i, i + concurrency);
    const batchRows = await Promise.all(batch.map(auditOne));
    rows.push(...batchRows);
  }
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    rows,
    copyText: rows.map((r) => `${r.name}\t${r.fingerprint || '-'}`).join('\n'),
  };
}

function normalizeObservedBandwidthMiB(data) {
  const raw = data && (
    data.observed_bandwidth ??
    data.observedBandwidth ??
    data.observed_bw ??
    data.observedBw ??
    data.bandwidth_observed ??
    data.bandwidthObserved ??
    null
  );
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1024 ? (value / (1024 * 1024)) : value;
}

function normalizeConsensusWeight(data) {
  const raw = data && (data.consensus_weight ?? data.consensusWeight ?? data.cw ?? null);
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeRunningState(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.running != null) return !!data.running;
  if (data.isRunning != null) return !!data.isRunning;
  if (Array.isArray(data.flags) && data.flags.length > 0) {
    const flags = data.flags.map((flag) => String(flag || '').toLowerCase());
    return flags.includes('running');
  }
  return null;
}

let dashboardTrackerFingerprintCache = {
  updatedAt: '',
  rows: [],
};

async function getDashboardTrackerFingerprints(forceRefresh = false) {
  if (!forceRefresh && Array.isArray(dashboardTrackerFingerprintCache.rows) && dashboardTrackerFingerprintCache.rows.length) {
    return { ok: true, ...dashboardTrackerFingerprintCache, cached: true };
  }
  const result = await fetchAllRelayFingerprints();
  if (result.ok) {
    dashboardTrackerFingerprintCache = {
      updatedAt: result.updatedAt,
      rows: result.rows || [],
    };
  }
  return { ok: !!result.ok, updatedAt: result.updatedAt, rows: result.rows || [], cached: false, error: result.error || '' };
}

function shortenSshError(error) {
  const text = String(error || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/Permission denied|Kimlik dogrulama|Parola HATALI|password auth/i.test(text)) {
    return 'SSH credentials rejected; check the username, password, or key.';
  }
  if (/Connection refused|SSH reddedildi/i.test(text)) {
    return 'SSH port refused; check ssh/sshd or the firewall on the server.';
  }
  if (/timed out|timeout|zaman asimi/i.test(text)) {
    return 'SSH timed out; the server or network is responding slowly.';
  }
  if (/Could not resolve hostname|resolve hostname/i.test(text)) {
    return 'Host name could not be resolved; check the relay host entry.';
  }
  return text.slice(0, 220);
}

async function fetchDashboardTrackerSnapshot(forceRefreshFingerprints = false) {
  const fpsResult = await getDashboardTrackerFingerprints(forceRefreshFingerprints);
  if (!fpsResult.ok) return { ok: false, error: fpsResult.error || 'Could not fetch fingerprints' };
  const rows = await Promise.all((fpsResult.rows || []).map(async (row) => {
    const base = {
      name: row.name,
      nickname: row.nickname || '',
      fingerprint: row.fingerprint || '',
      auditOk: row.auditOk !== false,
      running: null,
      observedMiB: null,
      consensusWeight: null,
      apiOk: false,
      apiError: '',
      updatedAt: '',
    };
    if (!row.ok || !row.fingerprint) {
      return {
        ...base,
        apiError: row.error || 'fingerprint yok',
      };
    }
    try {
      const data = await fetchJson(`https://api.ec.anyone.tech/relays/${row.fingerprint}`);
      return {
        ...base,
        apiOk: true,
        running: normalizeRunningState(data),
        observedMiB: normalizeObservedBandwidthMiB(data),
        consensusWeight: normalizeConsensusWeight(data),
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      return {
        ...base,
        apiError: e.message,
      };
    }
  }));
  const totals = rows.reduce((acc, row) => {
    acc.tracked += 1;
    if (row.running === false) acc.red += 1;
    if (row.observedMiB != null && row.observedMiB < 12) acc.low += 1;
    return acc;
  }, { tracked: 0, red: 0, low: 0 });
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    fingerprintsUpdatedAt: fpsResult.updatedAt,
    usedCachedFingerprints: !!fpsResult.cached,
    totals,
    rows,
  };
}

function buildMyFamilyBody(content, familyLine) {
  const line = String(familyLine || '').trim();
  let body = String(content || '');
  body = body.split('\n').filter((row) => !/^\s*MyFamily(?:\s|$)/i.test(row)).join('\n');
  body = body.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
  if (line) body += `${body ? '\n' : ''}${line}\n`;
  else if (body) body += '\n';
  return body;
}

async function buildRelayFamilyPlan() {
  const fpsResult = await fetchAllRelayFingerprints();
  const goodRows = (fpsResult.rows || []).filter((row) => row.ok && row.fingerprint);
  const allFingerprints = Array.from(new Set(goodRows.map((row) => normalizeRelayFingerprint(row.fingerprint)).filter(Boolean)));
  const rows = (fpsResult.rows || []).map((row) => {
    const selfFingerprint = normalizeRelayFingerprint(row.fingerprint);
    if (!row.ok || !selfFingerprint) {
      return {
        name: row.name,
        ok: false,
        fingerprint: row.fingerprint || '',
        familyFingerprints: [],
        familyLine: '',
        error: row.error || 'fingerprint yok',
      };
    }
    const familyFingerprints = allFingerprints.filter((fp) => fp !== selfFingerprint);
    const currentFamilyLines = Array.isArray(row.myFamilyLines) ? row.myFamilyLines.filter((line) => String(line || '').trim()) : (row.myFamily ? [row.myFamily] : []);
    const currentFamilyFingerprints = parseMyFamilyFingerprints(currentFamilyLines);
    const expectedSet = familyFingerprints.slice().sort().join(',');
    const currentSet = currentFamilyFingerprints.slice().sort().join(',');
    const familyLine = formatMyFamilyLine(familyFingerprints);
    const cleanLineCount = familyLine ? 1 : 0;
    const expectedDisplayLine = familyLine.replace(/^MyFamily\s+/i, '');
    const currentLineClean = currentFamilyLines.map((line) => parseMyFamilyFingerprints([line]).map((fp) => `$${fp}`).join(','));
    const familySyntaxUpToDate = currentFamilyLines.length === cleanLineCount && (!familyLine || currentLineClean[0] === expectedDisplayLine);
    return {
      name: row.name,
      ok: true,
      auditOk: row.auditOk !== false,
      fingerprintSource: row.fingerprintSource || 'ssh',
      fingerprint: selfFingerprint,
      familyFingerprints,
      currentFamilyFingerprints,
      currentFamilyLines,
      currentFamilyLine: currentFamilyLines.map((line) => `MyFamily ${line}`).join(' | '),
      familyLine,
      familyCount: familyFingerprints.length,
      familyUpToDate: expectedSet === currentSet && familySyntaxUpToDate,
    };
  });
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    rows,
  };
}

async function applyRelayFamilyPlan() {
  const cfg = config.load();
  const servers = cfg.servers || [];
  const plan = await buildRelayFamilyPlan();
  const preflight = [];
  const blocked = [];
  for (const row of plan.rows || []) {
    const server = servers.find((s) => s.name === row.name);
    if (!server) {
      blocked.push({ name: row.name, ok: false, error: 'Server not found' });
      continue;
    }
    if (!row.ok || !row.fingerprint) {
      blocked.push({ name: row.name, ok: false, error: row.error || 'fingerprint yok' });
      continue;
    }
    try {
      const read = await monitor.readAnonrc(server);
      if (!read.ok) {
        blocked.push({
          name: row.name,
          ok: false,
          fingerprint: row.fingerprint,
          familyLine: row.familyLine,
          error: 'precheck: ' + shortenSshError(read.error),
        });
        continue;
      }
      preflight.push({ row, server, content: read.content });
    } catch (e) {
      blocked.push({ name: row.name, ok: false, error: 'precheck: ' + shortenSshError(e.message), familyLine: row.familyLine });
    }
  }
  if (blocked.length) {
    const results = [
      ...blocked,
      ...preflight.map(({ row }) => ({
        name: row.name,
        ok: false,
        skipped: true,
        fingerprint: row.fingerprint,
        familyCount: row.familyCount,
        error: 'Not written: fix the SSH/config errors above first.',
      })),
    ];
    return {
      ok: false,
      updatedAt: new Date().toISOString(),
      count: plan.rows.length,
      okCount: 0,
      blockedCount: blocked.length,
      dryRunStopped: true,
      error: `${blocked.length} relay(s) failed the SSH/config precheck. No relays were changed.`,
      results,
    };
  }
  const results = [];
  for (const item of preflight) {
    const { row, server, content } = item;
    try {
      const nextBody = buildMyFamilyBody(content, row.familyLine);
      const write = await monitor.writeAnonrc(server, nextBody, { verify: true, restart: true });
      results.push({
        name: row.name,
        ok: !!write.ok,
        fingerprint: row.fingerprint,
        familyCount: row.familyCount,
        familyLine: row.familyLine,
        verify: write.verify,
        restarted: write.restarted,
        active: write.active,
        error: write.ok ? '' : (write.error || 'write fail'),
      });
    } catch (e) {
      results.push({ name: row.name, ok: false, error: e.message, familyLine: row.familyLine });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: okCount === results.length,
    updatedAt: new Date().toISOString(),
    count: results.length,
    okCount,
    results,
  };
}

async function fetchAllRelayFlagsData() {
  const fpsResult = await fetchAllRelayFingerprints();
  const flagsMap = {};
  await Promise.all(
    (fpsResult.rows || []).filter(r => r.ok && r.fingerprint).map(async (r) => {
      try {
        const d = await fetchJson(`https://api.ec.anyone.tech/relays/${r.fingerprint}`);
        const hasFlagData = !!(
          Array.isArray(d.flags) ||
          d.guard != null ||
          d.exit != null ||
          d.fast != null ||
          d.stable != null ||
          d.running != null ||
          d.isRunning != null ||
          d.consensus_weight != null ||
          d.consensusWeight != null
        );
        if (!hasFlagData) {
          flagsMap[r.name] = {
            ok: false,
            error: 'The Relay API has not returned flag data for this fingerprint yet',
          };
          return;
        }
        const flagArr = Array.isArray(d.flags) ? d.flags.map(f => String(f).toLowerCase()) : [];
        flagsMap[r.name] = {
          ok: true,
          fingerprint: r.fingerprint,
          guard: !!(d.guard || flagArr.includes('guard')),
          exit: !!(d.exit || flagArr.includes('exit')),
          fast: !!(d.fast || flagArr.includes('fast')),
          stable: !!(d.stable || flagArr.includes('stable')),
          running: d.running != null ? !!d.running : (d.isRunning != null ? !!d.isRunning : null),
          consensusWeight: d.consensus_weight ?? d.consensusWeight ?? null,
        };
      } catch (e) {
        flagsMap[r.name] = { ok: false, error: e.message };
      }
    })
  );
  return { ok: true, updatedAt: new Date().toISOString(), flags: flagsMap };
}

let _networkStatsCache = { ts: 0, data: null };
function coerceNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).trim().replace(/,/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function pickMetricValue(data) {
  if (data == null) return null;
  if (typeof data !== 'object') return coerceNumber(data);
  return coerceNumber(
    data.online ??
    data.all ??
    data.total ??
    data.value ??
    data.sum ??
    data.latest
  );
}

async function fetchNetworkStatsData() {
  const now = Date.now();
  if (_networkStatsCache.data && (now - _networkStatsCache.ts) < 60 * 1000) return _networkStatsCache.data;
  try {
    const [relaysLatest, bandwidthLatest] = await Promise.all([
      fetchJson('https://api.ec.anyone.tech/total-relays-latest').catch(() => null),
      fetchJson('https://api.ec.anyone.tech/total-observed-bandwidth-latest').catch(() => null),
    ]);
    const result = { ok: true, updatedAt: new Date(now).toISOString(), source: 'anyone-api' };

    const latestRelayCount = pickMetricValue(relaysLatest);
    const latestBandwidthBps = pickMetricValue(bandwidthLatest);

    if (latestRelayCount != null) result.totalRelays = latestRelayCount;
    if (latestBandwidthBps != null) result.totalBwGbps = latestBandwidthBps / 1e9;

    result.totalRelays = result.totalRelays != null ? Math.round(result.totalRelays) : null;
    if (result.totalRelays == null && result.totalBwGbps == null) {
      result.ok = false;
      result.error = 'Network stats endpoint veri donmedi.';
    }
    _networkStatsCache = { ts: now, data: result };
    return result;
  } catch (e) {
    return { ok: false, error: e.message, updatedAt: new Date(now).toISOString() };
  }
}

let _relayNetCache = { ts: 0, data: null, key: '' };

// Ag tarafi relay verisi: consensus weight / observed bandwidth / running.
// SSH gerektirmez — Anyone API fingerprint listesiyle sorgulanir.
// URL uzunlugu icin 50'lik gruplara bolunur.
async function fetchRelayNetworkStats(fingerprints) {
  const fps = (fingerprints || []).map(f => String(f || '').trim().toUpperCase()).filter(Boolean);
  if (!fps.length) return { ok: true, relays: {} };

  const key = fps.join(',');
  const now = Date.now();
  if (_relayNetCache.data && _relayNetCache.key === key && (now - _relayNetCache.ts) < 60 * 1000) {
    return _relayNetCache.data;
  }

  try {
    const chunks = [];
    for (let i = 0; i < fps.length; i += 50) chunks.push(fps.slice(i, i + 50));

    const results = await Promise.all(chunks.map(c =>
      fetchJson(`https://api.ec.anyone.tech/relays?fingerprints=${c.join(',')}`).catch(() => null)
    ));

    const relays = {};
    for (const list of results) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        const fp = String(r.fingerprint || '').toUpperCase();
        if (!fp) continue;
        relays[fp] = {
          nickname: r.nickname || '',
          running: !!r.running,
          consensusWeight: Number(r.consensus_weight) || 0,
          observedBandwidth: Number(r.observed_bandwidth) || 0,
          measured: !!r.measured,
        };
      }
    }

    const data = { ok: true, relays, updatedAt: new Date(now).toISOString() };
    _relayNetCache = { ts: now, data, key };
    return data;
  } catch (e) {
    return { ok: false, error: e.message, relays: {} };
  }
}

function classifyRelayIssue(snap) {
  const msg = String((snap && snap.error) || '').toLowerCase();
  const state = String((snap && snap.state) || '').toLowerCase();
  const anonActive = String(snap && snap.anon && snap.anon.active || '').toLowerCase();
  const flags = snap && snap.flags ? snap.flags : null;
  if (flags && flags.running === false) return 'dashboard';
  if (flags && flags.ok === false) return 'dashboard';
  if (anonActive && !anonActive.includes('active')) return 'anon';
  if (/anon servisi inactive|relay offline for 3 polls|failed to bind/i.test(msg)) return 'anon';
  if (/dashboard_running=false|running=false|relay api bu fingerprint/i.test(msg)) return 'dashboard';
  if (/connection closed by|broken pipe|timed out|timeout|ssh master|mux_client_request_session|ssh cevap vermiyor|ssh baglantisi|connection refused|host key|permission denied/i.test(msg)) return 'ssh';
  if (state === 'stale') return 'stale';
  if (state === 'offline') return 'offline';
  return 'ok';
}

async function ipcAuditByName(name) {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };
  return await monitor.auditRelay(s);
}

// Shell-quote for POSIX sh (single-quoted, escape existing quotes).
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
// Escape a JS string for inclusion in AppleScript "..." literal.
// AppleScript string literals cannot contain literal newlines, so multi-line
// strings are expressed as ("line1" & linefeed & "line2" & ...).
function asq(s) {
  const parts = String(s).split('\n');
  const escaped = parts.map(p => '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
  if (escaped.length === 1) return escaped[0];
  return '(' + escaped.join(' & linefeed & ') + ')';
}

let tray = null;
let win = null;
let monitor = null;
let isQuitting = false;
const relayAlertStates = new Map(); // server -> online|stale|offline
const relayFingerprintCache = new Map(); // server name -> fingerprint (populated from monitoring snapshots)
const anonServiceStates = new Map(); // server -> active|inactive
const anonInactiveCounts = new Map(); // server -> consecutive inactive snapshots
const dashboardRedCounts = new Map(); // server -> consecutive dashboard running=false snapshots
const ramWarnCounts = new Map(); // server -> consecutive low-available-RAM snapshots
let ramWarnPct = 90; // dusuk RAM uyari esigi (kullanim %); ayarlardan guncellenir
try { ramWarnPct = Math.max(70, Math.min(99, Number(config.load().ramWarnPct) || 90)); } catch {}
const sshOfflineCounts = new Map(); // server -> consecutive offline snapshots (for periodic retry)
const relayReminderTimers = new Map(); // server -> interval id
const dashboardFlagsCache = new Map(); // server name -> { ok, running, fingerprint } — arka plan dashboard polling
const lastSnapshots = new Map(); // server name -> son snapshot payload (renderer reload'da replay için)

// Dashboard running durumunu arka planda 5 dk'da bir güncelle.
// ÖNEMLI: SSH audit YOK — relayFingerprintCache'i kullanır (normal SSH poll'lardan dolar).
// Startup'ta çağrılmaz; SSH poll'ları fingerprint'leri doldurunca çalışır.
async function refreshDashboardFlagsCache() {
  if (relayFingerprintCache.size === 0) return; // henüz hiç SSH poll dönmedi, bekle
  try {
    const entries = Array.from(relayFingerprintCache.entries());
    // Her fingerprint için sadece dashboard API'sini sorgula (SSH açmadan)
    const CONCURRENCY = 8;
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      await Promise.all(entries.slice(i, i + CONCURRENCY).map(async ([name, fingerprint]) => {
        try {
          const d = await fetchJson(`https://api.ec.anyone.tech/relays/${fingerprint}`);
          const hasFlagData = !!(d.running != null || d.isRunning != null || Array.isArray(d.flags) || d.consensus_weight != null);
          if (!hasFlagData) { dashboardFlagsCache.set(name, { ok: false, error: 'No flag data' }); return; }
          dashboardFlagsCache.set(name, {
            ok: true,
            fingerprint,
            running: normalizeRunningState(d),
            guard: !!(d.guard || (Array.isArray(d.flags) && d.flags.map(f => String(f).toLowerCase()).includes('guard'))),
            exit: !!(d.exit || (Array.isArray(d.flags) && d.flags.map(f => String(f).toLowerCase()).includes('exit'))),
          });
        } catch (e) {
          dashboardFlagsCache.set(name, { ok: false, error: e.message });
        }
      }));
    }
  } catch (e) {
    // sessizce geç
  }
}
const config = new Config(app.getPath('userData'));
function configureSandboxTransport(cfg = config.load()) {
  if (!SANDBOX) return;
  sandboxTransport.configure({
    privateKey: cfg.sshPrivateKey || '',
    hostKeys: cfg.sshHostKeys || {},
    persistHostKey: (serverKey, fingerprint) => config.setSshHostKey(serverKey, fingerprint),
  });
}
const autoFixInProgress = new Set();
const uptimeStatsPath = path.join(app.getPath('userData'), 'uptime-stats.json');
const uptimeStats = new Map();

function loadUptimeStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(uptimeStatsPath, 'utf8'));
    for (const [name, row] of Object.entries(raw || {})) {
      uptimeStats.set(name, {
        observedSince: Number(row.observedSince) || Date.now(),
        offlineCount: Number(row.offlineCount) || 0,
        restartCount: Number(row.restartCount) || 0,
        totalOfflineMs: Number(row.totalOfflineMs) || 0,
        lastRestartAt: Number(row.lastRestartAt) || 0,
        lastOfflineAt: Number(row.lastOfflineAt) || 0,
        lastOnlineAt: Number(row.lastOnlineAt) || 0,
        currentOfflineStartedAt: Number(row.currentOfflineStartedAt) || 0,
        lastObservedUptimeMs: Number(row.lastObservedUptimeMs) || 0,
        incidents: Array.isArray(row.incidents) ? row.incidents.slice(-100).map((x) => ({
          startAt: Number(x.startAt) || 0,
          endAt: Number(x.endAt) || 0,
          durationMs: Number(x.durationMs) || 0,
        })).filter((x) => x.startAt > 0) : [],
      });
    }
  } catch {}
}

function saveUptimeStats() {
  try {
    const out = {};
    for (const [name, row] of uptimeStats.entries()) {
      out[name] = row;
    }
    fs.writeFileSync(uptimeStatsPath, JSON.stringify(out, null, 2), 'utf8');
  } catch {}
}

function ensureUptimeStat(name) {
  let row = uptimeStats.get(name);
  if (!row) {
    row = {
      observedSince: Date.now(),
      offlineCount: 0,
      restartCount: 0,
      totalOfflineMs: 0,
      lastRestartAt: 0,
      lastOfflineAt: 0,
      lastOnlineAt: 0,
      currentOfflineStartedAt: 0,
      lastObservedUptimeMs: 0,
      incidents: [],
    };
    uptimeStats.set(name, row);
  }
  return row;
}

function parseUptimeMs(text) {
  const src = String(text || '').toLowerCase().replace(/^up\s+/, '').trim();
  if (!src) return 0;
  let total = 0;
  const units = [
    [/(\d+)\s+year/, 365 * 24 * 60 * 60 * 1000],
    [/(\d+)\s+month/, 30 * 24 * 60 * 60 * 1000],
    [/(\d+)\s+week/, 7 * 24 * 60 * 60 * 1000],
    [/(\d+)\s+day/, 24 * 60 * 60 * 1000],
    [/(\d+)\s+hour/, 60 * 60 * 1000],
    [/(\d+)\s+minute/, 60 * 1000],
  ];
  for (const [re, mult] of units) {
    const m = src.match(re);
    if (m) total += Number(m[1] || 0) * mult;
  }
  return total;
}

function updateUptimeFromSnapshot(data) {
  if (!data || !data.name) return;
  const row = ensureUptimeStat(data.name);
  const ts = Number(data.ts) || Date.now();
  row.lastOnlineAt = ts;
  const uptimeMs = parseUptimeMs(data.uptime);
  if (uptimeMs > 0) {
    const toleranceMs = Math.max(90 * 1000, (Number((config.load() || {}).pollMs) || 10000) * 2);
    if (row.lastObservedUptimeMs > 0 && uptimeMs + toleranceMs < row.lastObservedUptimeMs) {
      row.restartCount += 1;
      row.lastRestartAt = ts;
    } else if (!row.lastRestartAt) {
      row.lastRestartAt = Math.max(0, ts - uptimeMs);
    }
    row.lastObservedUptimeMs = uptimeMs;
  }
}

function buildRecentWindow(row, nowTs, windowMs = 7 * 24 * 60 * 60 * 1000) {
  const windowStart = nowTs - windowMs;
  let downtimeMs = 0;
  let incidents = 0;
  for (const item of row.incidents || []) {
    const start = Number(item.startAt) || 0;
    const end = Number(item.endAt) || nowTs;
    if (!start || end <= windowStart) continue;
    const clippedStart = Math.max(start, windowStart);
    const clippedEnd = Math.min(end, nowTs);
    if (clippedEnd <= clippedStart) continue;
    downtimeMs += clippedEnd - clippedStart;
    incidents += 1;
  }
  if (row.currentOfflineStartedAt) {
    const clippedStart = Math.max(row.currentOfflineStartedAt, windowStart);
    if (nowTs > clippedStart) downtimeMs += nowTs - clippedStart;
  }
  const effectiveObservedMs = Math.max(1, Math.min(windowMs, Math.max(0, nowTs - (row.observedSince || nowTs))));
  const uptimePct = Math.max(0, Math.min(100, ((effectiveObservedMs - Math.min(downtimeMs, effectiveObservedMs)) / effectiveObservedMs) * 100));
  return {
    windowMs,
    downtimeMs,
    incidents,
    uptimePct,
  };
}

function buildUptimeStatsPayload(name, state, ts = Date.now()) {
  const row = ensureUptimeStat(name);
  const currentOfflineMs = row.currentOfflineStartedAt ? Math.max(0, ts - row.currentOfflineStartedAt) : 0;
  const recent7d = buildRecentWindow(row, ts);
  // Streak: en son kesinti bittiğinden (ya da ilk gözlemden) beri kesintisiz online süre.
  // Anyone ödül tier'ları gün streak'iyle yükselir; bir kesinti streak'i sıfırlar.
  let streakStartAt = row.observedSince || ts;
  for (const item of row.incidents || []) {
    const end = Number(item.endAt) || 0;
    if (end && end > streakStartAt) streakStartAt = end;
  }
  if (row.currentOfflineStartedAt) streakStartAt = ts; // şu an offline → streak 0
  const streakMs = Math.max(0, ts - streakStartAt);
  return {
    streakStartAt,
    streakMs,
    observedSince: row.observedSince,
    offlineCount: row.offlineCount,
    restartCount: row.restartCount,
    totalOfflineMs: row.totalOfflineMs,
    lastRestartAt: row.lastRestartAt || 0,
    lastOfflineAt: row.lastOfflineAt || 0,
    lastOnlineAt: row.lastOnlineAt || 0,
    currentOfflineMs,
    state,
    recent7d,
  };
}

let debugLogPath = null;
function autoFixLog(line) {
  const ts = new Date().toISOString();
  const full = `[AUTOFIX ${ts}] ${line}`;
  console.log(full);
  if (debugLogPath) {
    try { require('fs').appendFileSync(debugLogPath, full + '\n'); } catch {}
  }
  try {
    if (win && !win.isDestroyed()) win.webContents.send('autofix-log', { line: full });
  } catch {}
}

const pendingAutoFixResults = [];

function classifyAutoFixability(errorMsg) {
  const msg = String(errorMsg || '');
  if (!msg) return { autoFixable: true, reason: '' };
  if (/Kimlik dogrulama basarisiz|Permission denied|Host key uyusmazligi/i.test(msg)) {
    return { autoFixable: false, reason: 'SSH credentials or host key problem; remote commands cannot be run.' };
  }
  // Bağlantı kurulamadan kopan durumlar da auto-fix'e KAPALI olmalı: komut
  // çalıştırılacak bir oturum yok. Türkçe formatlanmış mesajlar da eşleşmeli —
  // classifyAutoFixability'ye monitor.js'in ürettiği metin geliyor, ham ssh çıktısı değil.
  // (2026-08-21: "Connection reset" kalıbı eksik olduğu için erişilemeyen 3 kutuya
  //  saatlerce OpenAI isteği atıldı ve ulaşılamayan makinede komut denendi.)
  if (/SSH reddedildi|Connection refused|No route to host|Network is unreachable|Operation timed out|timed out/i.test(msg)
      || /Connection reset|reset by peer|Connection closed by|Broken pipe|kex_exchange_identification|banner exchange/i.test(msg)
      || /oturumu uzak tarafca kapatildi|baglantisi koptu|Ag erisimi yok/i.test(msg)) {
    return { autoFixable: false, reason: 'SSH connection unavailable; Auto-Fix cannot run a command without reaching the server.' };
  }
  return { autoFixable: true, reason: '' };
}

async function triggerAutoFix(snap) {
  if (autoFixInProgress.has(snap.name)) return;
  autoFixInProgress.add(snap.name);
  autoFixLog(`${snap.name} triggered — error: ${(snap.error || 'offline').slice(0, 120)}`);
  try {
    const cfg = config.load();
    if (!cfg.autoFixEnabled) { autoFixLog(`${snap.name} skipped — Auto-Fix is disabled`); return; }
    const verdict = classifyAutoFixability(snap.error);
    if (!verdict.autoFixable) {
      autoFixLog(`${snap.name} skipped — Auto-Fix unavailable: ${verdict.reason}`);
      showDesktopNotification(`Auto-Fix Skipped: ${snap.name}`, verdict.reason);
      const result = { ok: false, action: 'none', reason: verdict.reason, error: snap.error || '' };
      const payload = { name: snap.name, result };
      if (win && !win.isDestroyed()) win.webContents.send('autofix-result', payload);
      else pendingAutoFixResults.push(payload);
      return;
    }
    showDesktopNotification(`Auto-Fix: ${snap.name}`, 'AI is analyzing...');
    const dryRun = !!cfg.autoFixDryRun;
    let recentLogs = [];
    let logSource = 'live';
    try {
      const logsResult = await monitor.fetchLogs(snap.name, 100);
      if (logsResult.ok) recentLogs = logsResult.lines;
    } catch {}
    // If live log fetch failed (SSH down), fall back to cached logs from the last
    // successful poll or the eager stale-state fetch. Include age note for the AI.
    if (!recentLogs.length) {
      const cached = monitor.getLogCache(snap.name);
      if (cached && cached.lines && cached.lines.length) {
        const ageSec = Math.round((Date.now() - cached.ts) / 1000);
        const ageLabel = ageSec < 120 ? `${ageSec} seconds ago` : `${Math.round(ageSec / 60)} minutes ago`;
        recentLogs = [`(SSH unavailable — these logs were cached ${ageLabel}; source: ${cached.source})`, ...cached.lines];
        logSource = `cached(${ageLabel})`;
        autoFixLog(`${snap.name} live logs unavailable; using cache (${ageLabel}, ${cached.lines.length} lines)`);
      }
    }
    const server = (cfg.servers || []).find(s => s.name === snap.name);
    if (!server) { autoFixLog(`${snap.name} skipped — server not found in config`); return; }
    let dashboardFlags = null;
    try {
      const flagsResult = await fetchAllRelayFlagsData();
      dashboardFlags = flagsResult.ok ? (flagsResult.flags || {})[snap.name] || null : null;
    } catch {}
    const dashboardHint = dashboardFlags && dashboardFlags.ok
      ? (dashboardFlags.running === false ? 'dashboard running=false' : '')
      : (dashboardFlags && dashboardFlags.error ? `dashboard ${dashboardFlags.error}` : '');
    // Add timing context: how long offline, last known anon state, log source.
    const offlineSince = snap.ts ? Math.round((Date.now() - snap.ts) / 1000) : 0;
    const cached = monitor.getLogCache(snap.name);
    const lastKnownAnon = cached && cached.anonState ? `Last known anon state: ${cached.anonState.active || 'unknown'}` : '';
    const offlineCtx = offlineSince > 5 ? `Offline duration: ~${offlineSince < 120 ? offlineSince + 's' : Math.round(offlineSince / 60) + ' minutes'}` : '';
    const logCtx = logSource !== 'live' ? `Log source: ${logSource}` : '';
    const errorMsg = [snap.error || 'Server offline', dashboardHint, lastKnownAnon, offlineCtx, logCtx].filter(Boolean).join(' | ');
    const result = await AiFixer.analyzeAndFix({
      server,
      errorMsg,
      recentLogs,
      cfg,
      runCommandFn: dryRun
        ? async (_name, cmd) => ({ ok: true, output: `[dry-run] ${cmd}` })
        : (name, cmd) => monitor.runCommand(name, cmd),
    });
    autoFixLog(`${snap.name} result: action=${result.action || 'error'} ok=${result.ok} dryRun=${dryRun ? 'yes' : 'no'} reason=${result.reason || ''} error=${result.error || ''}`);
    if (result.action === 'none') {
      showDesktopNotification(`Auto-Fix: ${snap.name}`, `AI: ${result.reason}`);
    } else if (dryRun) {
      showDesktopNotification(`Auto-Fix DRY-RUN: ${snap.name}`, `${result.commandName || 'command'} was not run\n${result.reason || ''}`.trim());
    } else if (result.ok) {
      showDesktopNotification(`Auto-Fix OK: ${snap.name}`, `${result.commandName} was run\n${result.reason}`);
    } else {
      showDesktopNotification(`Auto-Fix Error: ${snap.name}`, result.error || 'Unknown error');
    }
    const payload = { name: snap.name, result };
    if (win && !win.isDestroyed()) {
      win.webContents.send('autofix-result', payload);
    } else {
      pendingAutoFixResults.push(payload);
    }
  } catch (e) {
    autoFixLog(`${snap.name} exception: ${e.message}`);
    showDesktopNotification(`Auto-Fix Error: ${snap.name}`, e.message);
  } finally {
    autoFixInProgress.delete(snap.name);
  }
}

function handleOfflineIncident(snap, opts = {}) {
  if (!snap || !snap.name) return;
  const autoFixActive = isAutoFixEnabled();
  notifyRelayAlarm('offline', snap, { ...opts, autoFixActive });
  armRelayReminder(snap);
  if (autoFixActive) triggerAutoFix(snap).catch(() => {});
}

// Hide from dock — this is a menu bar app.
// (Temporarily keeping dock visible + window shown while we verify tray works.)
// if (process.platform === 'darwin' && app.dock) app.dock.hide();

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', err && err.stack || err);
});

// Yakalanmayan promise reddi — eskiden sessizce kayboluyordu, artık loglanıyor.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED_REJECTION:', reason && reason.stack || reason);
});

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const workArea = primary && primary.workArea ? primary.workArea : { width: 1280, height: 860 };
  const width = Math.max(880, Math.min(1440, Math.floor(workArea.width * 0.92)));
  const height = Math.max(640, Math.min(980, Math.floor(workArea.height * 0.9)));
  const minWidth = Math.max(720, Math.min(980, Math.floor(workArea.width * 0.72)));
  const minHeight = Math.max(560, Math.min(720, Math.floor(workArea.height * 0.68)));

  win = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    show: true,              // <-- show on launch so user sees the dashboard immediately
    frame: true,             // <-- keep title bar so it's movable / closable normally
    resizable: true,
    transparent: false,
    backgroundColor: '#0b0d10',
    title: 'RelayPulse',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Two separate models. MAS: the app always opens — unpaid users get the
  // free tier (FREE_RELAY_LIMIT relays), and the App Store purchase lifts the
  // cap. No trial clock, no license key, no external buy link (guideline 3.1.1);
  // purchase.html is reached from the tray menu.
  // Everywhere else: the existing 14-day trial + Ed25519 license key.
  let gateFile = 'index.html';
  if (!MAS) {
    const trialCfg = config.load();
    const TRIAL_DAYS = 14;
    const trialExpired = !isLicensed(trialCfg) && trialCfg.firstLaunchAt && (Date.now() - trialCfg.firstLaunchAt) > TRIAL_DAYS * 24 * 60 * 60 * 1000;
    if (trialExpired) gateFile = 'trial-expired.html';
  }
  win.loadFile(path.join(__dirname, 'renderer', gateFile));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('window-visibility', { visible: win.isVisible() });
    // Renderer yeniden yüklendiğinde mevcut snapshot'ları hemen gönder.
    // Böylece kartlar "Bekleniyor" kalmaz — sonraki poll döngüsünü beklemez.
    for (const snap of lastSnapshots.values()) {
      win.webContents.send('snapshot', snap);
    }
    for (const payload of pendingAutoFixResults.splice(0)) {
      win.webContents.send('autofix-result', payload);
    }
  });
  const updateWindowForDisplay = () => {
    if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const area = display && display.workArea ? display.workArea : workArea;
    const nextMinWidth = Math.max(720, Math.min(980, Math.floor(area.width * 0.72)));
    const nextMinHeight = Math.max(560, Math.min(720, Math.floor(area.height * 0.68)));
    const nextWidth = Math.max(nextMinWidth, Math.min(1440, Math.floor(area.width * 0.92)));
    const nextHeight = Math.max(nextMinHeight, Math.min(980, Math.floor(area.height * 0.9)));
    win.setMinimumSize(nextMinWidth, nextMinHeight);
    if (bounds.width > area.width || bounds.height > area.height) {
      win.setBounds({
        x: area.x + Math.max(0, Math.floor((area.width - nextWidth) / 2)),
        y: area.y + Math.max(0, Math.floor((area.height - nextHeight) / 2)),
        width: Math.min(nextWidth, area.width),
        height: Math.min(nextHeight, area.height),
      });
    }
  };
  win.on('show', updateWindowForDisplay);
  win.on('show', () => {
    if (win && !win.isDestroyed()) win.webContents.send('window-visibility', { visible: true });
  });
  win.on('hide', () => {
    if (win && !win.isDestroyed()) win.webContents.send('window-visibility', { visible: false });
  });
  // Intercept native close → hide instead of destroy (menu-bar app pattern).
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
}

function requestAppQuit() {
  isQuitting = true;
  for (const t of relayReminderTimers.values()) clearInterval(t);
  relayReminderTimers.clear();
  clearDashboardKeepAliveTimer();
  try { monitor && monitor.stop(); } catch {}
  if (tray) {
    try { tray.destroy(); } catch {}
    tray = null;
  }
  if (win && !win.isDestroyed()) {
    try { win.removeAllListeners('close'); } catch {}
    try { win.close(); } catch {}
  }
  // Fallback: if Electron's graceful quit gets stuck on open handles,
  // force the process down shortly after.
  setTimeout(() => {
    try { app.exit(0); } catch {}
  }, 1200);
  app.quit();
}

function clearRelayReminder(name) {
  const timer = relayReminderTimers.get(name);
  if (timer) clearInterval(timer);
  relayReminderTimers.delete(name);
}

function armRelayReminder(snap) {
  if (!snap || !snap.name) return;
  clearRelayReminder(snap.name);
  const alarm = getAlarmSettings();
  if (!alarm.alarmEnabled) return;
  const ms = alarm.alarmRepeatMinutes * 60 * 1000;
  const timer = setInterval(() => {
    notifyRelayAlarm('offline', snap);
  }, ms);
  relayReminderTimers.set(snap.name, timer);
}

function toggleWindow() {
  if (!win) createWindow();
  if (win.isVisible()) {
    win.hide();
  } else {
    positionWindow();
    win.show();
    win.focus();
  }
}

function positionWindow() {
  if (!tray || !win) return;
  const trayBounds = tray.getBounds();
  const winBounds = win.getBounds();
  const display = screen.getDisplayMatching(trayBounds);
  // Position under the tray icon, clamped to screen.
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  let y = Math.round(trayBounds.y + trayBounds.height + 4);
  x = Math.max(display.workArea.x + 8,
      Math.min(x, display.workArea.x + display.workArea.width - winBounds.width - 8));
  y = Math.max(display.workArea.y + 8,
      Math.min(y, display.workArea.y + display.workArea.height - winBounds.height - 8));
  win.setPosition(x, y, false);
}

function setTrayTitle(text) {
  if (!tray) return;
  tray.setTitle(text);
}

function createTray() {
  // Use a real template PNG — macOS requires a non-empty image for Tray.
  // The `Template` suffix makes Electron auto-set isMacTemplateImage = true.
  const iconPath = path.join(__dirname, 'assets', 'trayTemplate.png');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) {
    // Fallback: tiny 1-pixel template so Tray still constructs.
    img = nativeImage.createFromBuffer(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=',
      'base64'
    ));
    img.isMacTemplateImage = true;
  }
  tray = new Tray(img);
  tray.setTitle(' ◉ …');
  tray.setToolTip('RelayPulse');

  tray.on('click', (e, bounds) => {
    toggleWindow();
  });
  tray.on('right-click', () => {
    const debugLogPath = path.join(app.getPath('userData'), 'debug.log');
    const cfg = config.load();
    const fixEnabled = !!cfg.autoFixEnabled;
    const aiLabel = 'ChatGPT';
    const showUnlock = MAS && !iap.isPurchased();
    const menu = Menu.buildFromTemplate([
      { label: 'Open Dashboard', click: () => toggleWindow() },
      { label: 'Reload', click: () => win && win.reload() },
      ...(showUnlock ? [
        { type: 'separator' },
        {
          label: `Unlock RelayPulse (${FREE_RELAY_LIMIT}-relay free tier)…`,
          click: () => {
            if (!win || win.isDestroyed()) return;
            win.loadFile(path.join(__dirname, 'renderer', 'purchase.html'));
            if (!win.isVisible()) toggleWindow();
          },
        },
      ] : []),
      { type: 'separator' },
      {
        label: `Auto-Fix: ${fixEnabled ? 'On ✓' : 'Off'}`,
        click: () => {
          const c = config.load();
          c.autoFixEnabled = !c.autoFixEnabled;
          config.save(c);
          if (win && !win.isDestroyed()) win.webContents.send('autofix-toggle', { autoFixEnabled: c.autoFixEnabled });
        },
      },
      {
        label: `Dry-run: ${cfg.autoFixDryRun ? 'On ✓' : 'Off'}`,
        click: () => {
          const c = config.load();
          c.autoFixDryRun = !c.autoFixDryRun;
          config.save(c);
          if (win && !win.isDestroyed()) win.webContents.send('autofix-toggle', { autoFixDryRun: c.autoFixDryRun });
        },
      },
      { type: 'separator' },
      { label: 'Open Config File', click: () => shell.showItemInFolder(config.path) },
      { label: 'Quit', click: () => requestAppQuit() },
    ]);
    tray.popUpContextMenu(menu);
  });
}

function buildAppMenu() {
  // Standard application menu: gives Cmd+C / Cmd+V / Cmd+X / Cmd+A in inputs.
  const template = [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try { networkMap.register(); } catch (e) { console.error('[network-map] register failed:', e && e.message); }
  loadUptimeStats();


  try { createTray(); console.log('[ok] tray created'); }
  catch (e) { console.error('[err] tray failed:', e && e.stack || e); }
  buildAppMenu();
  createWindow();
  console.log('[ok] window created');

  // Debug log: <userData>/debug.log
  debugLogPath = path.join(app.getPath('userData'), 'debug.log');
  // Log dosyasını başlangıçta 2MB ile sınırla — sınırsız büyümeyi önle
  try {
    const MAX_DEBUG_LOG_BYTES = 2 * 1024 * 1024; // 2MB
    if (fs.existsSync(debugLogPath) && fs.statSync(debugLogPath).size > MAX_DEBUG_LOG_BYTES) {
      const content = fs.readFileSync(debugLogPath, 'utf8');
      const half = content.slice(-Math.floor(MAX_DEBUG_LOG_BYTES / 2)); // Son 1MB kalsın
      fs.writeFileSync(debugLogPath, half, 'utf8');
    }
  } catch {}
  const initialConfig = config.load();
  configureSandboxTransport(initialConfig);
  // StoreKit can replay a transaction that completed while the app was closed,
  // so the observer has to be attached before the window is usable.
  if (MAS) {
    iap.start({
      config,
      log: (line) => {
        const full = `[IAP ${new Date().toISOString()}] ${line}`;
        console.log(full);
        try { fs.appendFileSync(debugLogPath, full + '\n'); } catch {}
      },
      onChange: (purchased) => {
        if (!purchased) return;
        // Cap lifted: hand the monitor the full server list. The tray menu is
        // rebuilt on every right-click, so it picks the change up on its own.
        try { monitor && monitor.updateServers(entitledServers(config.load().servers)); } catch {}
        if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
      },
    });
  }

  monitor = new Monitor({ ...initialConfig, servers: entitledServers(initialConfig.servers) }, { debugLogPath });
  console.log('[ok] debug log:', debugLogPath);

  // Push aggregate updates to the tray title every few seconds.
  monitor.on('aggregate', (agg) => {
    // agg: { online, total, totalRxMbps, totalTxMbps }
    const rx = agg.totalRxMbps.toFixed(1);
    const tx = agg.totalTxMbps.toFixed(1);
    setTrayTitle(`◉ ${agg.online}/${agg.total}  ↓${rx} ↑${tx} Mb/s`);
  });

  // Forward per-server snapshots to the renderer.
  monitor.on('snapshot', (data) => {
    // Renderer'a gönderme MUTLAKA çalışmalı — işlem hatası snapshot'ı engellemez.
    try {
    data.issueKind = classifyRelayIssue(data);
    const prevState = relayAlertStates.get(data.name);
    const nextState = data.state || (data.ok ? 'online' : 'offline');
    let statsDirty = false;

    if (data.ok) {
      updateUptimeFromSnapshot(data);
      statsDirty = true;
      if (data.fingerprint) relayFingerprintCache.set(data.name, data.fingerprint);
      // Dashboard flags'ini snapshot'a enjekte et.
      // monitor.js sadece SSH verisini bilir; dashboard running durumu ayrı API'den gelir.
      // Cache boşsa (henüz ilk poll gelmedi) flags null kalır — yanlış alarm vermez.
      if (!data.flags && dashboardFlagsCache.has(data.name)) {
        data.flags = dashboardFlagsCache.get(data.name);
      }
    }

    // SSH offline transition — alarm + auto-fix
    if (nextState === 'offline') {
      const offlineCount = (sshOfflineCounts.get(data.name) || 0) + 1;
      sshOfflineCounts.set(data.name, offlineCount);
      if (prevState !== 'offline') {
        // İlk geçiş: uptime istatistikleri + alarm + auto-fix
        const row = ensureUptimeStat(data.name);
        row.offlineCount += 1;
        row.lastOfflineAt = Number(data.ts) || Date.now();
        row.currentOfflineStartedAt = row.lastOfflineAt;
        row.incidents = row.incidents || [];
        row.incidents.push({ startAt: row.lastOfflineAt, endAt: 0, durationMs: 0 });
        row.incidents = row.incidents.slice(-100);
        statsDirty = true;
        // Relay offline olunca dashboard flags'ini de hemen yenile (fingerprint varsa).
        if (relayFingerprintCache.has(data.name)) {
          refreshDashboardFlagsCache().catch(() => {});
        }
        handleOfflineIncident(data, { source: 'ssh' });
      } else if (offlineCount % 12 === 0) {
        // Relay hâlâ offline: her ~2 dakikada bir auto-fix'i tekrar dene.
        // Böylece ilk fix başarısız olsa bile otomatik retry yapılır.
        autoFixLog(`${data.name} is still offline (${offlineCount} consecutive snapshots) — Auto-Fix is being retriggered`);
        handleOfflineIncident(data, { source: 'ssh' });
      }
    } else if (nextState === 'online' && prevState === 'offline') {
      const row = ensureUptimeStat(data.name);
      const recoveredAt = Number(data.ts) || Date.now();
      if (row.currentOfflineStartedAt) {
        const durationMs = Math.max(0, recoveredAt - row.currentOfflineStartedAt);
        row.totalOfflineMs += durationMs;
        const lastIncident = Array.isArray(row.incidents) ? row.incidents[row.incidents.length - 1] : null;
        if (lastIncident && lastIncident.startAt === row.currentOfflineStartedAt && !lastIncident.endAt) {
          lastIncident.endAt = recoveredAt;
          lastIncident.durationMs = durationMs;
        }
        row.currentOfflineStartedAt = 0;
      }
      statsDirty = true;
      sshOfflineCounts.set(data.name, 0);
      clearRelayReminder(data.name);
      notifyRelayAlarm('online', data, { source: 'ssh' });
    } else if (nextState !== 'offline' && prevState === 'offline') {
      const row = ensureUptimeStat(data.name);
      const recoveredAt = Number(data.ts) || Date.now();
      if (row.currentOfflineStartedAt) {
        const durationMs = Math.max(0, recoveredAt - row.currentOfflineStartedAt);
        row.totalOfflineMs += durationMs;
        const lastIncident = Array.isArray(row.incidents) ? row.incidents[row.incidents.length - 1] : null;
        if (lastIncident && lastIncident.startAt === row.currentOfflineStartedAt && !lastIncident.endAt) {
          lastIncident.endAt = recoveredAt;
          lastIncident.durationMs = durationMs;
        }
        row.currentOfflineStartedAt = 0;
      }
      statsDirty = true;
      sshOfflineCounts.set(data.name, 0);
      clearRelayReminder(data.name);
    }
    relayAlertStates.set(data.name, nextState);

    // Anon service inactive transition — auto-fix (SSH alive but relay stopped)
    if (data.ok && data.anon) {
      const rawActive = data.anon.active;
      // 'unknown' = SSH/agent çıktısı eksik geldi, servis durumu OKUNAMADI.
      // Bu "servis kapalı" DEĞİLDİR — sadece bu poll'da veri alınamadı.
      // Hiçbir şey yapma: sayacı/durumu değiştirme, auto-fix tetikleme.
      // (Aksi halde sağlıklı relay'ler için sürekli yanlış alarm + gereksiz restart oluyordu.)
      if (rawActive !== 'unknown') {
        const prevAnon = anonServiceStates.get(data.name);
        const nextAnon = rawActive === 'active' ? 'active' : (rawActive === 'failed' ? 'failed' : 'inactive');
        const nextInactiveCount = nextAnon !== 'active' ? ((anonInactiveCounts.get(data.name) || 0) + 1) : 0;
        anonInactiveCounts.set(data.name, nextInactiveCount);
        // DAMPENING: Tek bir "inactive" okuması yetmez — geçici SSH/agent hıçkırıkları
        // false positive üretiyor. Gerçek bir kesinti birkaç poll boyunca sürer.
        // En az 2 ardışık inactive/failed görülünce auto-fix tetiklenir.
        const ANON_INACTIVE_AFTER = 2;
        // Sayaç eşiğe ULAŞTIĞI anda tetikle (transition mantığı zaten sayaçta:
        // anon active olunca sayaç 0'a sıfırlanır, 2 ardışık inactive = sağlıklıdan kopuş).
        // ÖNCEKİ BUG: ek olarak prevAnon'un active/undefined olması isteniyordu — ama 1. inactive
        // poll'dan sonra prevAnon zaten 'inactive' oluyordu, bu yüzden sayaç 2'ye ulaştığında koşul
        // hep false dönüyor ve anon-inactive auto-fix HİÇ tetiklenmiyordu. Dashboard yolundaki gibi
        // eşikte bir kez + relay hâlâ down ise her 12 poll'da bir tekrar tetikle.
        const anonJustBroke = nextAnon !== 'active'
          && (nextInactiveCount === ANON_INACTIVE_AFTER
              || (nextInactiveCount > ANON_INACTIVE_AFTER && nextInactiveCount % 12 === 0));
        if (anonJustBroke) {
          autoFixLog(`${data.name} anon service is ${nextAnon} (${nextInactiveCount} consecutive checks) — Auto-Fix is being triggered`);
          const syntheticSnap = { ...data, error: `anon service became ${nextAnon}` };
          handleOfflineIncident(syntheticSnap, { source: 'anon' });
        } else if (nextAnon === 'active' && prevAnon !== 'active' && prevAnon !== undefined && prevAnon !== 'unknown') {
          // İlk poll'da (prevAnon===undefined) "tekrar aktif" yazma — relay zaten sağlıklı.
          // Sadece gerçekten inactive/failed gözlemlenmiş bir relay toparlanınca logla.
          autoFixLog(`${data.name} anon service is active again`);
          clearRelayReminder(data.name);
          notifyRelayAlarm('online', data, { source: 'anon' });
        }
        anonServiceStates.set(data.name, nextAnon);
      }
    }

    // Dashboard running=false while SSH+anon are healthy — guard path or port issue.
    // İlk tespit anında auto-fix tetiklenir. Sonrasında relay hâlâ kırmızıysa
    // her 12. snapshot'ta bir (≈ 2 dk) tekrar kontrol eder ama auto-fix çok sık tetiklenmez.
    if (data.ok && data.flags && data.flags.running === false) {
      const prevRedCount = dashboardRedCounts.get(data.name) || 0;
      const nextRedCount = prevRedCount + 1;
      dashboardRedCounts.set(data.name, nextRedCount);
      // Yeni uyarı: sarı chip her zaman gösterilir (renderer data.flags ile halleder).
      // Auto-fix: ilk tespit + sonrası her 12. snapshot (yaklaşık 2 dk)
      if (nextRedCount === 1 || nextRedCount % 12 === 0) {
        autoFixLog(`${data.name} dashboard running=false (${nextRedCount}. tespit) — auto-fix tetikleniyor`);
        const syntheticSnap = { ...data, error: 'dashboard_running=false: relay is not visible on the network; check the port or guard' };
        handleOfflineIncident(syntheticSnap, { source: 'dashboard' });
      }
    } else if (data.flags && data.flags.running === true) {
      if ((dashboardRedCounts.get(data.name) || 0) > 0) {
        autoFixLog(`${data.name} dashboard running=true — recovered; counter reset`);
        notifyRelayAlarm('online', data, { source: 'dashboard' });
      }
      dashboardRedCounts.set(data.name, 0);
    }

    // Dusuk available RAM erken uyarisi — kutu donmadan/OOM olmadan haber ver.
    // (2026-07 SSH flood olayinda relay'ler RAM dolup dondu, ancak tamamen offline
    //  olunca fark edildi.) Auto-fix YOK: bellek guvenle otomatik duzeltilemez;
    //  sadece kartta chip + sesli bildirim. data.ramLow renderer chip'i icin.
    if (data.ok && data.mem && Number.isFinite(data.mem.pct)) {
      const isLowRam = data.mem.pct >= ramWarnPct;
      data.ramLow = isLowRam;
      const prevLowCount = ramWarnCounts.get(data.name) || 0;
      const nextLowCount = isLowRam ? prevLowCount + 1 : 0;
      ramWarnCounts.set(data.name, nextLowCount);
      // DAMPENING: 2 ardisik poll = gecici spike degil, gercek bellek baskisi.
      if (nextLowCount === 2) {
        autoFixLog(`${data.name} DUSUK RAM — %${data.mem.pct} kullanimda (available dusuk), donma/OOM riski`);
        notifyRelayAlarm('lowram', data);
      }
    }

    data.uptimeStats = buildUptimeStatsPayload(data.name, nextState, Number(data.ts) || Date.now());
    if (!data.issueKind || data.issueKind === 'ok') {
      data.issueKind = classifyRelayIssue(data);
    }
    if (statsDirty) saveUptimeStats();
    } catch (handlerErr) {
      console.error('[snapshot handler error]', data && data.name, handlerErr && handlerErr.message);
    }
    // try/catch dışında — her durumda renderer'a gönder.
    // ÖNEMLİ: data, structured-clone ile gönderilir. İçinde clone edilemeyen
    // bir değer (fonksiyon vb.) varsa win.webContents.send exception fırlatır
    // ve kart hiç güncellenmez. JSON round-trip ile garantili düz obje üret.
    let safeData;
    try {
      safeData = JSON.parse(JSON.stringify(data));
    } catch (cloneErr) {
      safeData = { name: data && data.name, ok: !!(data && data.ok), state: (data && data.state) || 'offline', ts: Date.now() };
      try { require('fs').appendFileSync(debugLogPath, `[SNAPSHOT-SANITIZE-ERR ${new Date().toISOString()}] ${data && data.name}: ${cloneErr && cloneErr.message}\n`); } catch {}
    }
    lastSnapshots.set(safeData.name, safeData);
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('snapshot', safeData);
      } catch (sendErr) {
        try { require('fs').appendFileSync(debugLogPath, `[SNAPSHOT-SEND-ERR ${new Date().toISOString()}] ${safeData.name}: ${sendErr && sendErr.message}\n`); } catch {}
      }
    }
  });
  monitor.on('log', (data) => {
    if (win && !win.isDestroyed()) win.webContents.send('log', data);
  });

  // Serialize concurrent agentTokenFixed saves to prevent race condition:
  // when N servers all get 403 simultaneously, each handler used to load config
  // independently, modify its own entry, then save — each overwriting the others.
  let _tokenSaveQueue = Promise.resolve();
  monitor.on('agentTokenFixed', ({ name, token }) => {
    _tokenSaveQueue = _tokenSaveQueue.then(() => {
      try {
        const cfg = config.load();
        const idx = (cfg.servers || []).findIndex(s => s.name === name);
        if (idx >= 0) {
          cfg.servers[idx].agentToken = token;
          config.save(cfg);
        }
      } catch {}
    });
  });

  // monitor.start() is normally triggered by the renderer after the user picks
  // a connection mode in the startup dialog.
  //
  // HEADLESS FALLBACK: Renderer'daki dialog kaldırıldığında ya da renderer init'inde
  // bir hata startMonitor'a ulaşmayı engellediğinde monitoring HİÇ başlamayabilir.
  // Ana süreçte kısa bir gecikmeyle, henüz başlamadıysa kayıtlı connectionMode ile
  // otomatik başlat — böylece izleme her zaman çalışır (tarayıcı/dialog gerekmez).
  setTimeout(() => {
    if (config.load().demoMode) { startDemoFleet(); return; }
    if (monitor && !monitor._started) {
      const cfg = config.load();
      const connectionMode = cfg.connectionMode === 'ssh' ? 'ssh' : 'https';
      monitor.connectionMode = connectionMode;
      monitor._started = true;
      monitor.start();
      try { fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] monitoring ANA SUREC tarafindan otomatik baslatildi (mode=${connectionMode})\n`); } catch {}
      setTimeout(() => {
        refreshDashboardFlagsCache();
        setInterval(refreshDashboardFlagsCache, 2 * 60 * 1000);
      }, 60 * 1000);
    }
  }, 8000);
});

// --- Demo fleet ---
// Deliberately bypasses the monitor's snapshot handler and talks to the window
// directly: that handler raises alarms, drives AI auto-fix and writes uptime
// history, none of which should fire for invented relays. Nothing here opens a
// connection, so demo mode is also the safe way to look around offline.
let demoTimer = null;

function isDemoMode() {
  try { return !!config.load().demoMode; } catch { return false; }
}

function pushDemoFrame() {
  const snaps = demoFleet.snapshots();
  for (const snap of snaps) lastSnapshots.set(snap.name, snap);
  if (!win || win.isDestroyed()) return;
  try {
    for (const snap of snaps) win.webContents.send('snapshot', snap);
    win.webContents.send('aggregate', demoFleet.aggregate(snaps));
  } catch {}
}

function startDemoFleet() {
  if (demoTimer) return;
  try { monitor && monitor.stop && monitor.stop(); } catch {}
  pushDemoFrame();
  demoTimer = setInterval(pushDemoFrame, 3000);
}

function stopDemoFleet() {
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  lastSnapshots.clear();
}

// --- IPC handlers ---
ipcMain.handle('demo:get', () => ({ enabled: isDemoMode(), banner: demoFleet.BANNER }));
// Switching either way restarts the app: the monitor, the tray and every card
// are built from the server list at startup, and rebuilding all of that live
// would be far more code than the feature is worth.
ipcMain.handle('demo:set', (_e, enabled) => {
  const cfg = config.load();
  cfg.demoMode = !!enabled;
  config.save(cfg);
  if (!enabled) stopDemoFleet();
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

ipcMain.handle('servers:get', () => (isDemoMode() ? demoFleet.servers() : config.load().servers));
ipcMain.handle('servers:save', (_e, servers) => {
  // Demo modunda `servers:get` renderer'a uydurma filoyu veriyor, yani Relay
  // Connections panelindeki "Save Connections" o on ornek relay'i operatorun
  // gercek yapilandirmasinin uzerine yazar — sessizce ve kalici olarak. Demo
  // anahtari ayni Settings penceresinde bir pane otede, yani bu tek tikla
  // ulasilir. Demo bir gosterim, yapilandirma degil: yazmayi reddet.
  if (isDemoMode()) return false;
  const cfg = config.load();
  cfg.servers = servers;
  config.save(cfg);
  dashboardTrackerFingerprintCache = { updatedAt: '', rows: [] };
  monitor.updateServers(entitledServers(servers));
  return true;
});
// RelayPulse iPhone uygulamasi icin filo tanimini disari aktar. safeStorage ile
// sifreli agentToken'lar main process'te cozulur; ciktida duz metin token'lar var,
// bu yuzden dosyayi 0600 yaz ve kullaniciya AirDrop ile telefona atmasini soyle.
ipcMain.handle('fleet:exportForPhone', async () => {
  const { dialog } = require('electron');
  const cfg = config.load();
  const servers = (cfg.servers || [])
    .filter((s) => s && s.name && (s.host || s.sshAlias))
    .map((s) => ({
      name: s.name,
      host: s.host || s.sshAlias || s.name,
      agentPort: Number(s.agentPort) || 19191,
      agentScheme: String(s.agentScheme || 'https').toLowerCase(),
      agentToken: s.agentToken || '',
    }));
  const payload = {
    exportedAt: Date.now(),
    pollSec: Math.max(30, Math.round((Number(cfg.pollMs) || 120000) / 1000)),
    offlineAfter: Math.max(1, Math.min(5, Number(cfg.offlineAfter) || 2)),
    servers,
  };
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'iPhone icin filo tanimini disari aktar',
    defaultPath: `relaypulse-fleet-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
  return { ok: true, filePath, count: servers.length, withToken: servers.filter((s) => s.agentToken).length };
});
ipcMain.handle('monitor:start', (_e, mode) => {
  const allowed = ['ssh', 'https'];
  const connectionMode = allowed.includes(mode) ? mode : 'https';
  const cfg = config.load();
  cfg.connectionMode = connectionMode;
  config.save(cfg);
  monitor.connectionMode = connectionMode;
  if (!monitor._started) {
    monitor._started = true;
    monitor.start();
    // Dashboard flags poller — SSH poll'ları fingerprint'leri doldurduktan sonra başlar.
    // İlk çekim 60s sonra, ardından her 2 dk'da bir — kırmızı relay'ler daha hızlı tespit edilir.
    setTimeout(() => {
      refreshDashboardFlagsCache();
      setInterval(refreshDashboardFlagsCache, 2 * 60 * 1000);
    }, 60 * 1000);
  } else {
    monitor.updateSettings({ connectionMode });
  }
  return { ok: true, connectionMode };
});

ipcMain.handle('settings:get', () => {
  const cfg = config.load();
  return {
    pollMs: cfg.pollMs,
    logLines: cfg.logLines,
    defaultNetworkMode: cfg.defaultNetworkMode || 'anyone',
    themeMode: cfg.themeMode || 'light',
    languageMode: 'en',
    alarmEnabled: cfg.alarmEnabled !== false,
    alarmSound: ALERT_SOUNDS[cfg.alarmSound] ? cfg.alarmSound : 'Blow',
    alarmRepeatMinutes: Math.max(1, Math.min(60, Number(cfg.alarmRepeatMinutes) || 5)),
    ramWarnPct: Math.max(70, Math.min(99, Number(cfg.ramWarnPct) || 90)),
    connectionMode: cfg.connectionMode || 'https',
    sshRetryCount: Math.max(1, Math.min(3, Number(cfg.sshRetryCount) || 2)),
    sshTimeoutMs: Math.max(0, Math.min(60000, Number(cfg.sshTimeoutMs) || 0)),
    offlineAfter: Math.max(1, Math.min(5, Number(cfg.offlineAfter) || 2)),
  };
});
ipcMain.handle('settings:save', (_e, s) => {
  const cfg = config.load();
  const next = { ...s };
  next.languageMode = 'en';
  if (next.sshRetryCount != null) next.sshRetryCount = Math.max(1, Math.min(3, Math.round(Number(next.sshRetryCount) || 2)));
  if (next.sshTimeoutMs != null) next.sshTimeoutMs = Math.max(0, Math.min(60000, Math.round(Number(next.sshTimeoutMs) || 0)));
  if (next.offlineAfter != null) next.offlineAfter = Math.max(1, Math.min(5, Math.round(Number(next.offlineAfter) || 2)));
  Object.assign(cfg, next);
  config.save(cfg);
  configureSandboxTransport(cfg);
  monitor.updateSettings(next);
  ramWarnPct = Math.max(70, Math.min(99, Number(cfg.ramWarnPct) || 90));
  return true;
});
ipcMain.handle('ssh:key:import', async () => {
  if (!SANDBOX) return { ok: false, error: 'SSH key import is only available in the sandbox build.' };
  const result = await require('electron').dialog.showOpenDialog(win, {
    title: 'Select an SSH private key',
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  try {
    const privateKey = fs.readFileSync(result.filePaths[0], 'utf8');
    if (!/-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/.test(privateKey)) {
      return { ok: false, error: 'Select a valid PEM or OpenSSH private key file.' };
    }
    const cfg = config.load();
    cfg.sshPrivateKey = privateKey;
    config.save(cfg);
    configureSandboxTransport(cfg);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Could not read key: ' + (err && err.message || err) };
  }
});
ipcMain.handle('alarm:test', async () => {
  const alarm = getAlarmSettings();
  if (!alarm.alarmEnabled) return { ok: false, error: 'Alarm is disabled. Enable it first.' };
  playAlertSound(alarm.alarmSound);
  showDesktopNotification('Anyone Monitor Test Alarm', `Sound: ${alarm.alarmSound} · Repeat: ${alarm.alarmRepeatMinutes}m`);
  return { ok: true };
});
ipcMain.handle('server:test', async (_e, server) => {
  return await monitor.testServer(server);
});
ipcMain.handle('relay:audit', async (_e, name) => {
  return await ipcAuditByName(name);
});
ipcMain.handle('relay:setupCheck', async (_e, name) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };
  return await monitor.setupHealthCheck(s);
});
ipcMain.handle('relay:fingerprints', async () => {
  return await fetchAllRelayFingerprints();
});
ipcMain.handle('relay:familyPlan', async () => {
  return await buildRelayFamilyPlan();
});
ipcMain.handle('relay:familyApplyAll', async () => {
  return await applyRelayFamilyPlan();
});

// --- Günlük ödül geçmişi (kalıcı) ---

// Returns AO reward data keyed by fingerprint so renderer can compute per-relay estimates



ipcMain.handle('dashboard:trackerFingerprints', async (_e, forceRefresh = false) => {
  return await getDashboardTrackerFingerprints(!!forceRefresh);
});
ipcMain.handle('dashboard:trackerSnapshot', async (_e, forceRefreshFingerprints = false) => {
  return await fetchDashboardTrackerSnapshot(!!forceRefreshFingerprints);
});
ipcMain.handle('app:info', async () => {
  return {
    version: pkg.version,
    name: pkg.build?.productName || pkg.name || 'RelayPulse',
    userDataPath: app.getPath('userData'),
    // Mac App Store builds must not show license-key entry or any external
    // purchase route (App Store guideline 3.1.1).
    mas: MAS,
    freeRelayLimit: FREE_RELAY_LIMIT,
  };
});
ipcMain.handle('license:activate', async (_e, key) => {
  if (!verifyLicenseKey(key)) return { ok: false, error: 'Invalid license key' };
  const cfg = config.load();
  cfg.licensed = true;
  cfg.licenseKey = String(key || '').trim();
  config.save(cfg);
  return { ok: true };
});
ipcMain.handle('license:status', async () => {
  const cfg = config.load();
  return { licensed: isLicensed(cfg), firstLaunchAt: cfg.firstLaunchAt || 0 };
});

// --- Mac App Store in-app purchase (MAS build only) ----------------------
ipcMain.handle('iap:status', async () => {
  if (!MAS) return { ok: false, error: 'In-app purchase is only available in the Mac App Store build.' };
  const product = await iap.getProduct();
  return { ok: true, purchased: iap.isPurchased(), product };
});
ipcMain.handle('iap:purchase', async () => {
  if (!MAS) return { ok: false, error: 'In-app purchase is only available in the Mac App Store build.' };
  return await iap.purchase();
});
ipcMain.handle('iap:restore', async () => {
  if (!MAS) return { ok: false, error: 'In-app purchase is only available in the Mac App Store build.' };
  return iap.restore();
});
// Only the user's own configured relay hosts: the single reason the app opens
// a browser is the relay's own web page. Everything else is blocked.
const EXTERNAL_OPEN_ALLOWED_HOSTS = new Set();
ipcMain.handle('external:open', async (_e, url) => {
  const safe = String(url || '').trim();
  if (!/^https?:\/\//i.test(safe)) return { ok: false, error: 'Invalid URL' };
  let host;
  try { host = new URL(safe).hostname.toLowerCase(); } catch { return { ok: false, error: 'Invalid URL' }; }
  const isKnownHost = EXTERNAL_OPEN_ALLOWED_HOSTS.has(host);
  const isOwnRelay = config.load().servers?.some((s) => s.host === host);
  if (!isKnownHost && !isOwnRelay) return { ok: false, error: 'Unknown address blocked: ' + host };
  await shell.openExternal(safe);
  return { ok: true };
});
ipcMain.handle('clipboard:readText', () => clipboard.readText());
ipcMain.handle('clipboard:writeText', (_e, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});
ipcMain.handle('edit:cut', (e) => { e.sender.cut(); return true; });
ipcMain.handle('edit:copy', (e) => { e.sender.copy(); return true; });
ipcMain.handle('edit:paste', (e) => { e.sender.paste(); return true; });
ipcMain.handle('edit:selectAll', (e) => { e.sender.selectAll(); return true; });
ipcMain.handle('edit:showContextMenu', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return false;
  const menu = Menu.buildFromTemplate([
    { role: 'cut', label: 'Cut' },
    { role: 'copy', label: 'Copy' },
    { role: 'paste', label: 'Paste' },
    { type: 'separator' },
    { role: 'selectAll', label: 'Select all' },
  ]);
  menu.popup({ window: win });
  return true;
});
// Read/write /etc/anon/anonrc on the given server. The renderer's Config tab
// uses these to show a text editor for the relay's config without needing a
// Terminal + nano round-trip. Writes also verify-config and restart by
// default; the renderer can pass restart:false to skip the service bounce.
ipcMain.handle('anonrc:read', async (_e, name) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };
  return await monitor.readAnonrc(s);
});
ipcMain.handle('anonrc:write', async (_e, name, content, opts) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };
  const safeServer = {
    name: s.name,
    sshAlias: s.sshAlias || '',
    host: s.host || '',
    port: s.port || 22,
    hasPassword: !!s.password,
    hasKey: !!s.key,
  };
  try {
    const res = await monitor.writeAnonrc(s, content, opts || {});
    try {
      monitor._logDebug(`anonrc:write ${name} ${JSON.stringify({ server: safeServer, ok: !!res.ok, verify: res.verify || '', restarted: res.restarted || '', active: res.active || '', error: String(res.error || '').slice(0, 240) })}`);
    } catch {}
    return res;
  } catch (e) {
    try {
      monitor._logDebug(`anonrc:write ${name} threw ${JSON.stringify({ server: safeServer, error: String(e && e.message || e).slice(0, 240) })}`);
    } catch {}
    return { ok: false, error: e.message || String(e) };
  }
});

// Apply the "bandwidth safe" preset to either one server or all servers.
// The preset:
//   - strips any existing BandwidthRate/Burst/AccountingMax/AccountingStart
//   - appends the managed block (10 MBytes / 15 MBytes / 4 TBytes / month 1)
//   - ensures Log notice file points at /var/log/anon/notices.log
// Then verify-config + restart each server. Returns per-server results.
function applyBandwidthPreset(content) {
  const managedBlock = [
    '',
    '# Bandwidth limits (managed by anyone-monitor)',
    'BandwidthRate 10 MBytes',
    'BandwidthBurst 15 MBytes',
    'AccountingMax 4 TBytes',
    'AccountingStart month 1 00:00',
  ].join('\n');
  let body = String(content || '');
  // drop existing managed lines so we don't stack duplicates
  body = body.split('\n').filter(line => {
    if (/^\s*BandwidthRate\s/i.test(line)) return false;
    if (/^\s*BandwidthBurst\s/i.test(line)) return false;
    if (/^\s*AccountingMax\s/i.test(line)) return false;
    if (/^\s*AccountingStart\s/i.test(line)) return false;
    if (/^# Bandwidth limits \(managed by anyone-monitor\)$/.test(line)) return false;
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
  body += managedBlock + '\n';
  if (!/^Log notice file /m.test(body)) {
    body += 'Log notice file /var/log/anon/notices.log\n';
  }
  return body;
}

ipcMain.handle('anonrc:applyPreset', async (_e, name) => {
  const cfg = config.load();
  const servers = (cfg.servers || []);
  const targets = name === '*ALL*' ? servers : servers.filter(x => x.name === name);
  if (!targets.length) return { ok: false, error: 'Server not found' };
  const results = [];
  for (const s of targets) {
    try {
      const read = await monitor.readAnonrc(s);
      if (!read.ok) { results.push({ name: s.name, ok: false, error: 'read: ' + read.error }); continue; }
      const newBody = applyBandwidthPreset(read.content);
      const write = await monitor.writeAnonrc(s, newBody, { verify: true, restart: true });
      results.push({ name: s.name, ok: !!write.ok, ...write });
    } catch (e) {
      results.push({ name: s.name, ok: false, error: e.message });
    }
  }
  const okCount = results.filter(r => r.ok).length;
  return { ok: okCount === results.length, count: results.length, okCount, results };
});

// Add extra exit policy ports to anonrc, inserting them before the final reject *:*
// Skips servers listed in the exclude array (configurable, empty by default).
function applyExitPolicyPorts(content) {
  const NEW_PORTS = [
    'ExitPolicy accept *:110',
    'ExitPolicy accept *:143',
    'ExitPolicy accept *:993',
    'ExitPolicy accept *:995',
    'ExitPolicy accept *:8080',
    'ExitPolicy accept *:8443',
    'ExitPolicy accept *:5222',
    'ExitPolicy accept *:9418',
    'ExitPolicy accept *:6697',
  ];
  let lines = String(content || '').split('\n');
  // Remove duplicates of lines we're about to add
  lines = lines.filter(l => !NEW_PORTS.includes(l.trim()));
  // Find the position of the first blanket reject to insert before it
  const rejectIdx = lines.findIndex(l => /^\s*ExitPolicy\s+reject\s+\*:\*/.test(l));
  if (rejectIdx >= 0) {
    lines.splice(rejectIdx, 0, ...NEW_PORTS);
  } else {
    lines.push(...NEW_PORTS);
  }
  return lines.join('\n');
}

ipcMain.handle('anonrc:applyExitPorts', async (_e, exclude) => {
  const cfg = config.load();
  const excludeList = Array.isArray(exclude) ? exclude.map(n => String(n).trim().toLowerCase()) : [];
  const servers = (cfg.servers || []).filter(s => !excludeList.includes(String(s.name || '').trim().toLowerCase()));
  if (!servers.length) return { ok: false, error: 'Target server not found' };
  const results = [];
  for (const s of servers) {
    try {
      const read = await monitor.readAnonrc(s);
      if (!read.ok) { results.push({ name: s.name, ok: false, error: 'read: ' + read.error }); continue; }
      const newBody = applyExitPolicyPorts(read.content);
      const write = await monitor.writeAnonrc(s, newBody, { verify: true, restart: true });
      results.push({ name: s.name, ok: !!write.ok, ...write });
    } catch (e) {
      results.push({ name: s.name, ok: false, error: e.message });
    }
  }
  const okCount = results.filter(r => r.ok).length;
  return { ok: okCount === results.length, count: results.length, okCount, results };
});

// Open outbound firewall ports for exit relay and test connectivity.
// Skips servers in the exclude array.
ipcMain.handle('firewall:applyExitPorts', async (_e, exclude) => {
  const PORTS = [110, 143, 993, 995, 8080, 8443, 5222, 9418, 6697];
  const TEST_HOSTS = {
    110: 'pop.gmail.com', 143: 'imap.gmail.com', 993: 'imap.gmail.com',
    995: 'pop.gmail.com', 8080: 'www.google.com', 8443: 'www.google.com',
    5222: 'xmpp.org', 9418: 'github.com', 6697: 'irc.libera.chat',
  };
  const SSH_CMD = `
set -e
PORTS="${PORTS.join(' ')}"
# Open outbound with UFW if active
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  for p in $PORTS; do ufw allow out $p/tcp comment 'anon-exit' 2>/dev/null || true; done
  echo "FW_METHOD:ufw"
elif command -v iptables >/dev/null 2>&1; then
  for p in $PORTS; do
    iptables -C OUTPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -A OUTPUT -p tcp --dport $p -j ACCEPT
  done
  echo "FW_METHOD:iptables"
else
  echo "FW_METHOD:none"
fi
# Test outbound connectivity on each port
${PORTS.map(p => `timeout 4 bash -c 'echo > /dev/tcp/${TEST_HOSTS[p]}/${p}' 2>/dev/null && echo "PORT_${p}:open" || echo "PORT_${p}:closed"`).join('\n')}
`.trim();

  const cfg = config.load();
  const excludeList = Array.isArray(exclude) ? exclude.map(n => String(n).trim().toLowerCase()) : [];
  const servers = (cfg.servers || []).filter(s => !excludeList.includes(String(s.name || '').trim().toLowerCase()));
  if (!servers.length) return { ok: false, error: 'Target server not found' };

  const results = [];
  for (const s of servers) {
    try {
      const { runSsh } = require('./src/monitor');
      const out = await runSsh(s, SSH_CMD, 60000);
      const lines = String(out || '').split('\n');
      const fwMethod = (lines.find(l => l.startsWith('FW_METHOD:')) || '').replace('FW_METHOD:', '');
      const portResults = {};
      for (const p of PORTS) {
        const line = lines.find(l => l.startsWith(`PORT_${p}:`));
        portResults[p] = line ? line.split(':')[1] : 'unknown';
      }
      const allOpen = Object.values(portResults).every(v => v === 'open');
      results.push({ name: s.name, ok: true, fwMethod, ports: portResults, allOpen });
    } catch (e) {
      results.push({ name: s.name, ok: false, error: e.message });
    }
  }
  const okCount = results.filter(r => r.ok).length;
  return { ok: okCount === results.length, count: results.length, okCount, results };
});

// Detect the local Mac's public IP once (cached for 10 min).
let _publicIpCache = { ip: '', ts: 0 };
async function getPublicIp() {
  const now = Date.now();
  if (_publicIpCache.ip && (now - _publicIpCache.ts) < 10 * 60 * 1000) return _publicIpCache.ip;
  const urls = ['https://ifconfig.me', 'https://api.ipify.org', 'https://icanhazip.com'];
  for (const u of urls) {
    try {
      const res = await fetch(u);
      if (!res.ok) continue;
      const txt = (await res.text()).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(txt)) {
        _publicIpCache = { ip: txt, ts: now };
        return txt;
      }
    } catch {}
  }
  return '';
}
ipcMain.handle('ip:public', async () => {
  return { ok: true, ip: await getPublicIp() };
});

// Whitelist my public IP on one server or all servers to prevent fail2ban bans.
ipcMain.handle('fail2ban:whitelistAll', async (_e, nameOrAll, ipOverride) => {
  const cfg = config.load();
  const servers = (cfg.servers || []);
  const targets = nameOrAll === '*ALL*' ? servers : servers.filter(x => x.name === nameOrAll);
  if (!targets.length) return { ok: false, error: 'Server not found' };
  let ip = String(ipOverride || '').trim();
  if (!ip) ip = await getPublicIp();
  if (!ip) return { ok: false, error: 'Public IP could not be detected. Check the internet connection.' };
  const results = [];
  for (const s of targets) {
    try {
      const r = await monitor.whitelistIp(s, ip);
      results.push({ name: s.name, ...r });
    } catch (e) {
      results.push({ name: s.name, ok: false, error: e.message });
    }
  }
  const okCount = results.filter(r => r.ok).length;
  return { ok: okCount === results.length, ip, count: results.length, okCount, results };
});

// ===== Güvenlik / Sertleştirme paneli =====
const SEC_PROBE = `
echo "F2B=$(systemctl is-active fail2ban 2>/dev/null)"
echo "BAN=$(fail2ban-client status sshd 2>/dev/null | awk '/Total banned/{print $NF}')"
echo "PW=$(sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')"
echo "MS=$(sshd -T 2>/dev/null | awk '/^maxstartups/{print $2}')"
echo "PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2}' | head -1)"
`;
function parseSecProbe(out) {
  const g = (k) => { const m = String(out || '').match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
  const f2b = g('F2B'), pw = g('PW'), ms = g('MS'), port = g('PORT'), ban = g('BAN');
  const risky = (f2b !== 'active') || (pw === 'yes'); // fail2ban yok VEYA sifre-auth acik = riskli
  return { f2b: f2b || '?', ban: ban || '0', pw: pw || '?', ms: ms || '?', port: port || '22', risky };
}
ipcMain.handle('security:scan', async (_e, nameOrAll) => {
  const cfg = config.load();
  const servers = cfg.servers || [];
  const targets = nameOrAll === '*ALL*' ? servers : servers.filter(x => x.name === nameOrAll);
  if (!targets.length) return { ok: false, error: 'Server not found' };
  const results = [];
  const CONC = 10;
  for (let i = 0; i < targets.length; i += CONC) {
    const batch = targets.slice(i, i + CONC);
    const rs = await Promise.all(batch.map(async (s) => {
      try {
        const r = await monitor.runCommand(s.name, SEC_PROBE, 20000);
        if (!r.ok) return { name: s.name, ok: false, error: r.error };
        return { name: s.name, ok: true, host: s.host, ...parseSecProbe(r.output) };
      } catch (e) { return { name: s.name, ok: false, error: e.message }; }
    }));
    results.push(...rs);
  }
  return {
    ok: true, count: results.length,
    risky: results.filter(r => r.ok && r.risky).length,
    unreachable: results.filter(r => !r.ok).length,
    results,
  };
});
const HARDEN_CMD_TEMPLATE = `set -e
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'CONF'
MaxStartups 10:30:60
LoginGraceTime 20
__PWLINE__
CONF
if grep -qiE '^[[:space:]]*PasswordAuthentication' /etc/ssh/sshd_config.d/50-cloud-init.conf 2>/dev/null; then sed -i 's/^[[:space:]]*PasswordAuthentication/#&/I' /etc/ssh/sshd_config.d/50-cloud-init.conf; fi
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 || true
apt-get install -y -qq fail2ban >/dev/null 2>&1 || true
cat > /etc/fail2ban/jail.local <<'JAIL'
[sshd]
enabled  = true
port     = ssh
backend  = systemd
maxretry = 4
findtime = 600
bantime  = 3600
ignoreip = 127.0.0.1/8 ::1
JAIL
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban || true
echo HARDEN_DONE`;
ipcMain.handle('security:harden', async (_e, name) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };
  // Kilitlenme korumasi: SADECE key ile baglanan (sifre-auth olmayan) relay'de PasswordAuthentication kapat.
  const useKey = !!(s.key && String(s.key).trim());
  const pwLine = (useKey && !s.password) ? 'PasswordAuthentication no' : '# PasswordAuthentication korundu (sifre-auth relay)';
  const cmd = HARDEN_CMD_TEMPLATE.replace('__PWLINE__', pwLine);
  try {
    const r = await monitor.runCommand(name, cmd, 120000);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: /HARDEN_DONE/.test(r.output), output: r.output };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('relay:flags', async () => fetchAllRelayFlagsData());
ipcMain.handle('network:stats', async () => fetchNetworkStatsData());

// Network geographic concentration map — opens in its own window from Settings > Servers.
ipcMain.handle('networkMap:open', async (_e, fleet) => {
  try {
    networkMap.open({ parent: win, fleet: Array.isArray(fleet) ? fleet : [] });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
});
ipcMain.on('window:hide', () => { if (win) win.hide(); });
ipcMain.on('window:quit', () => { requestAppQuit(); });

ipcMain.handle('autofix:getSettings', () => {
  const cfg = config.load();
  return {
    autoFixEnabled: !!cfg.autoFixEnabled,
    autoFixDryRun: !!cfg.autoFixDryRun,
    aiProvider: cfg.aiProvider || 'openai',
    openaiApiKey: cfg.openaiApiKey || cfg.aiApiKey || '',
    claudeApiKey: cfg.claudeApiKey || '',
    autoFixCommands: cfg.autoFixCommands || [],
  };
});
ipcMain.handle('autofix:saveSettings', (_e, s) => {
  const cfg = config.load();
  cfg.autoFixEnabled = !!s.autoFixEnabled;
  cfg.autoFixDryRun = !!s.autoFixDryRun;
  cfg.aiProvider = s.aiProvider || 'openai';
  // undefined = "bu alana dokunma" (kutu bos gorunuyordu, kullanici silmek istemedi)
  // ''        = "gercekten sil" (kullanici Clear'a basti)
  // Onceden ikisi de '' oluyordu ve config.save() bos degeri kasadan SILME emri
  // sayiyordu — bu yuzden API anahtari her Save'de kayboluyordu.
  if (s.openaiApiKey !== undefined) cfg.openaiApiKey = s.openaiApiKey;
  if (s.claudeApiKey !== undefined) cfg.claudeApiKey = s.claudeApiKey;
  cfg.autoFixCommands = Array.isArray(s.autoFixCommands) ? s.autoFixCommands : [];
  config.save(cfg);
  return true;
});
ipcMain.handle('autofix:test', async (_e, s) => {
  const base = config.load();
  // undefined alanlar spread ile base'deki gercek degeri EZERDI — ozellikle
  // kullanici anahtar kutusuna dokunmadiginda claudeApiKey/openaiApiKey undefined
  // gelir ve test "API key eksik" derdi. Tanimsizlari ayikla.
  const patch = Object.fromEntries(Object.entries(s || {}).filter(([, v]) => v !== undefined));
  const cfg = {
    ...base,
    ...patch,
    autoFixCommands: Array.isArray(patch.autoFixCommands) && patch.autoFixCommands.length
      ? patch.autoFixCommands
      : (base.autoFixCommands || []),
  };
  const server = (cfg.servers && cfg.servers[0]) || { name: 'test-relay' };
  const result = await AiFixer.analyzeAndFix({
    server,
    errorMsg: 'anon service inactive; relay offline for 3 polls',
    recentLogs: [
      'systemd[1]: anon.service: Failed with result exit-code.',
      'anon[1234]: Bootstrapped 0% (starting): Starting',
      'anon[1234]: Failed to bind one of the listener ports.',
    ],
    cfg,
    runCommandFn: async (_name, cmd) => ({ ok: true, output: `[dry-run] ${cmd}` }),
  });
  return {
    ok: !!result.ok,
    result,
    mode: 'dry-run',
  };
});

// Open a remote interactive TUI in a new Terminal window.
// macOS: osascript + Terminal.app
// Linux: gnome-terminal / x-terminal-emulator / xterm
function openRemoteTerminal(server, remoteCmd, tag) {
  const s = server;
  const port = s.port && s.port !== 22 ? `-p ${Number(s.port)} ` : '';
  let target;
  const sshOpts = '-tt -o ConnectTimeout=8 -o ServerAliveInterval=10 -o StrictHostKeyChecking=accept-new';

  let sh;
  let pwFile = '';
  // Key takes priority: if a key file is set, always use publickey auth.
  // Vault may contain stale passwords from an earlier password-auth setup, but
  // servers that now require publickey would reject sshpass attempts.
  if (s.password && !s.key) {
    const user = s.user || 'root';
    const host = s.host || s.sshAlias || s.name;
    target = `${user}@${host}`;
    // Parola script metnine GOMULMEZ. Gomulseydi macOS'ta /tmp'deki script
    // dosyasinda, Linux'ta ise `bash -c ...` argumaninda (yani `ps` ciktisinda,
    // makinedeki her kullaniciya acik) duz metin olarak gorunurdu.
    // Bunun yerine 0600 izinli ayri bir dosyaya yazilip `sshpass -f` ile okutulur;
    // dosya asagidaki EXIT trap'i ile silinir.
    pwFile = path.join(require('os').tmpdir(), `relay-pw-${require('crypto').randomBytes(9).toString('hex')}`);
    try {
      fs.writeFileSync(pwFile, String(s.password) + '\n', { mode: 0o600 });
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'Could not write password file: ' + e.message });
    }
    sh = `sshpass -f ${shq(pwFile)} ssh ${sshOpts} -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no ${port}${shq(target)} ${shq(remoteCmd)}`;
  } else {
    if (s.user && s.host) target = `${s.user}@${s.host}`;
    else if (s.host) target = s.host;
    else if (s.sshAlias) target = s.sshAlias;
    else target = s.name;
    // IdentitiesOnly=yes: specified key only, agent keys won't interfere.
    const key = s.key ? `-i ${shq(s.key)} -o IdentitiesOnly=yes ` : '';
    sh = `ssh ${sshOpts} ${key}${port}${shq(target)} ${shq(remoteCmd)}`;
  }

  // Write to a temp bash script so the multiline remoteCmd is never passed
  // through an interactive shell (which would misparse '\'' escapes in quote> mode).
  // The script self-deletes on exit. This also fixes 'read -n1 -s' on macOS zsh.
  const full = [
    '#!/bin/bash',
    // Parola dosyasi da temizlenir; kullanici pencereyi kapatsa bile calisir.
    // Yol degiskene alinir: shq() ciktisini trap'in tek tirnaklari icine gommek
    // tirnaklari ic ice sokar ve yolda bosluk varsa script bozulur.
    `PWF=${pwFile ? shq(pwFile) : "''"}`,
    `trap 'rm -f "$PWF" "$0"' EXIT`,
    // shq: relay adinda tek tirnak varsa script bozulmasin.
    `echo >&2 ${shq('>> ' + tag + ' baglaniyor: ' + s.name)}`,
    'echo',
    sh,
    'rc=$?',
    'echo',
    `echo ">> ${tag} cikti (rc=$rc)"`,
    `echo 'pencereyi kapatabilirsin'`,
    'read -n1 -s',
  ].join('\n');

  if (process.platform === 'darwin') {
    const os = require('os');
    const tmpFile = path.join(os.tmpdir(), `relay-term-${Date.now()}.sh`);
    try {
      fs.writeFileSync(tmpFile, full, { mode: 0o700 });
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'Could not write script file: ' + e.message });
    }
    const script = `tell application "Terminal"\n  activate\n  do script ${asq('bash ' + shq(tmpFile))}\nend tell`;
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], (err) => {
        if (!err) return resolve({ ok: true });
        // macOS Terminal'i AppleEvent ile acmak "Otomasyon" izni ister. Izin yoksa
        // (veya uygulama yeniden imzalandigi icin izin dustuyse) osascript -1743
        // dondurur. Ham kod kullaniciya hicbir sey anlatmiyordu.
        const msg = String(err.message || '');
        if (/-1743|not (?:been )?(?:allowed|authori[sz]ed)|Not authori[sz]ed to send Apple events/i.test(msg)) {
          return resolve({
            ok: false,
            error: 'macOS denied Terminal access. Open System Settings > Privacy & Security > Automation and enable Terminal under RelayPulse. (details: ' + msg.trim() + ')',
          });
        }
        resolve({ ok: false, error: msg });
      });
    });
  }

  // Linux: try terminal emulators in order
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const bashCmd = full + '; exec bash';
    const candidates = [
      ['gnome-terminal', ['--', 'bash', '-c', bashCmd]],
      ['x-terminal-emulator', ['-e', 'bash', '-c', bashCmd]],
      ['xterm', ['-hold', '-e', 'bash', '-c', full]],
      ['konsole', ['--noclose', '-e', 'bash', '-c', full]],
      ['xfce4-terminal', ['--hold', '-e', 'bash -c ' + shq(full)]],
    ];
    let done = false;
    function finish(r) { if (!done) { done = true; resolve(r); } }
    function tryNext(i) {
      if (i >= candidates.length) {
        return finish({ ok: false, error: 'Terminal not found. Install it with sudo apt-get install gnome-terminal' });
      }
      const [cmd, args] = candidates[i];
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => tryNext(i + 1));
      child.once('spawn', () => { child.unref(); finish({ ok: true }); });
      setTimeout(() => { try { child.unref(); } catch {} finish({ ok: true }); }, 500);
    }
    tryNext(0);
  });
}

const embeddedTerminalSessions = new Map();
function terminalRemoteCommand(kind) {
  if (kind === 'nyx') return 'export TERM=xterm-256color; nyx -s /run/anon/control || nyx -s /var/run/anon/control || nyx';
  if (kind === 'htop') return 'export TERM=xterm-256color; command -v htop >/dev/null 2>&1 && htop || top';
  return 'export TERM=xterm-256color; exec ${SHELL:-bash} -l';
}

ipcMain.handle('terminal:open', async (event, name, kind = 'shell') => {
  if (!SANDBOX) return { ok: false, error: 'Embedded terminal is only available in the sandbox build.' };
  const server = (config.load().servers || []).find((item) => item.name === name);
  if (!server) return { ok: false, error: 'Server not found: ' + name };
  const id = require('crypto').randomBytes(12).toString('hex');
  try {
    const shellSession = await sandboxTransport.openShell(server, { cols: 100, rows: 28 });
    embeddedTerminalSessions.set(id, { senderId: event.sender.id, shellSession });
    shellSession.onData((data) => {
      if (!event.sender.isDestroyed()) event.sender.send('terminal:data', { id, data });
    });
    shellSession.write(terminalRemoteCommand(kind) + '\n');
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err && err.message || String(err) };
  }
});
ipcMain.on('terminal:write', (event, id, data) => {
  const session = embeddedTerminalSessions.get(id);
  if (session && session.senderId === event.sender.id) session.shellSession.write(data);
});
ipcMain.on('terminal:resize', (event, id, cols, rows) => {
  const session = embeddedTerminalSessions.get(id);
  if (session && session.senderId === event.sender.id) session.shellSession.resize(cols, rows);
});
ipcMain.on('terminal:close', (event, id) => {
  const session = embeddedTerminalSessions.get(id);
  if (session && session.senderId === event.sender.id) {
    try { session.shellSession.close(); } catch {}
    embeddedTerminalSessions.delete(id);
  }
});

// Open `nyx -s /run/anon/control` on the given server in a new Terminal window.
// We use `osascript` so the user gets a real pty terminal (arrow keys, m/l/c pages all work).
ipcMain.handle('nyx:open', async (_e, name) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };
  if (SANDBOX) return { ok: true, embedded: true };
  // Force TERM explicitly — some remote sessions ship with TERM=unknown which
  // breaks every curses-based TUI including nyx.
  const remoteCmd = `export TERM=xterm-256color;
# Multi-instance: find anonrc matching SSH destination IP
LOCAL_IP=$(echo $SSH_CONNECTION | awk '{print $3}')
MATCHED_CTRL=""
if [ -n "$LOCAL_IP" ]; then
  for rc in /etc/anon/anonrc-* /etc/anon/instances/*/anonrc; do
    [ -f "$rc" ] || continue
    if grep -q "^Address $LOCAL_IP" "$rc" 2>/dev/null; then
      MATCHED_CTRL=$(grep '^ControlPort' "$rc" 2>/dev/null | awk '{print $2}' | head -1)
      break
    fi
  done
fi
if [ -n "$MATCHED_CTRL" ]; then
  nyx -i "$MATCHED_CTRL"
elif [ -S /run/anon/control ]; then
  nyx -s /run/anon/control
elif [ -S /var/run/anon/control ]; then
  nyx -s /var/run/anon/control
elif [ -S /run/tor/control ]; then
  nyx -s /run/tor/control
elif [ -S /var/run/tor/control ]; then
  nyx -s /var/run/tor/control
elif grep -Eq '^\\s*ControlPort\\s+9051\\b' /etc/anon/anonrc /usr/local/etc/anon/anonrc /etc/tor/torrc 2>/dev/null; then
  nyx -i 127.0.0.1:9051
else
  nyx
fi`;
  return openRemoteTerminal(s, remoteCmd, 'nyx');
});

ipcMain.handle('anonlog:open', async (_e, name) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };
  const remoteCmd = `journalctl -u anon@default -n 50 --no-pager 2>/dev/null || journalctl -u anon -n 50 --no-pager 2>/dev/null || tail -n 50 /var/log/anon/notices.log 2>/dev/null || echo '(log not found)'; echo; echo '---'; echo 'press any key to close'; read -n1 -s`;
  return openRemoteTerminal(s, remoteCmd, 'anon log');
});

// Ayarlar'daki "Sertifika pinlerini sifirla": agent yeniden kuruldugunda
// pin artik tutmaz ve her poll sertifika hatasi verir. Sifirlayinca bir
// sonraki poll gecerli sertifikayi yeniden ogrenir.
ipcMain.handle('certpin:count', async () => certPin.count());
ipcMain.handle('certpin:reset', async () => { certPin.reset(); return true; });

ipcMain.handle('agent:httpsTest', async (_e, name) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };
  const host = s.host || s.sshAlias || s.name;
  const port = s.agentPort || 19191;
  const token = s.agentToken || '';
  const scheme = String(s.agentScheme || 'https').toLowerCase() === 'http' ? 'http' : 'https';
  const mod = scheme === 'https' ? https : http;
  return await new Promise((resolve) => {
    const opts = {
      hostname: host,
      port,
      path: '/metrics',
      method: 'GET',
      timeout: 6000,
      headers: token ? { 'X-Agent-Token': token } : {},
    };
    if (scheme === 'https') certPin.apply(opts, host);
    const req = mod.request(opts, (res) => {
      if (scheme === 'https') certPin.learn(host, res);
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 200) return resolve({ ok: true, status: 200, text: 'HTTPS OK' });
        if (res.statusCode === 403) return resolve({ ok: false, status: 403, text: 'Token 403' });
        resolve({ ok: false, status: res.statusCode || 0, text: `${scheme.toUpperCase()} ${res.statusCode || 'ERR'}` });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, text: 'HTTPS timeout' });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0,
      text: certPin.describe(e) || `HTTPS err: ${e.message}` }));
    req.end();
  });
});

// Open `htop` (or fall back to `top` if htop isn't installed) on the given
// server in a new Terminal window. Useful for quick CPU/RAM/process views
// beyond the aggregate numbers shown on the dashboard card.
function buildAgentInstallCommand(token, port, scheme) {
  const agentSrc = fs.readFileSync(path.join(__dirname, 'agent', 'agent.py'), 'utf8');
  const b64 = Buffer.from(agentSrc).toString('base64');

  return [
    'set -e',
    'mkdir -p /opt/anyone-agent',
    `echo '${b64}' | base64 -d > /opt/anyone-agent/agent.py`,
    'chmod +x /opt/anyone-agent/agent.py',
    'if ! command -v openssl >/dev/null 2>&1; then echo "openssl yok"; exit 3; fi',
    'if [ ! -s /opt/anyone-agent/cert.pem ] || [ ! -s /opt/anyone-agent/key.pem ]; then',
    '  openssl req -x509 -newkey rsa:2048 -keyout /opt/anyone-agent/key.pem -out /opt/anyone-agent/cert.pem -sha256 -days 3650 -nodes -subj "/CN=anyone-agent" >/dev/null 2>&1',
    'fi',
    `cat > /etc/systemd/system/anyone-agent.service << 'SVCEOF'`,
    '[Unit]',
    'Description=RelayPulse Agent',
    'After=network.target',
    '[Service]',
    'Type=simple',
    'Restart=always',
    'RestartSec=5',
    `Environment=AGENT_TOKEN=${token}`,
    `Environment=AGENT_PORT=${port}`,
    `Environment=AGENT_SCHEME=${scheme}`,
    'Environment=AGENT_CERT=/opt/anyone-agent/cert.pem',
    'Environment=AGENT_KEY=/opt/anyone-agent/key.pem',
    'ExecStart=/usr/bin/python3 /opt/anyone-agent/agent.py',
    '[Install]',
    'WantedBy=multi-user.target',
    'SVCEOF',
    'systemctl daemon-reload',
    'systemctl enable anyone-agent',
    'systemctl restart anyone-agent',
    'sleep 2',
    'systemctl is-active anyone-agent',
  ].join('\n');
}

async function installAgentOnServer(server, { token, port, scheme }) {
  const { runSsh } = require('./src/monitor');
  await runSsh(server, buildAgentInstallCommand(token, port, scheme), 30000);
}

ipcMain.handle('agent:install', async (_e, name) => {
  const cfg = config.load();
  const servers = cfg.servers || [];
  const s = servers.find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };

  const token = require('crypto').randomBytes(20).toString('hex');
  const port = 19191;
  const scheme = 'https';

  try {
    await installAgentOnServer(s, { token, port, scheme });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const updated = servers.map(x => x.name === name ? { ...x, agentEnabled: true, agentPort: port, agentToken: token, agentScheme: scheme } : x);
  cfg.servers = updated;
  config.save(cfg);
  if (monitor) monitor.updateServers(entitledServers(updated));
  return { ok: true, token, port };
});

ipcMain.handle('agent:installAll', async () => {
  const cfg = config.load();
  const servers = cfg.servers || [];
  if (!servers.length) return { ok: false, error: 'No saved relays' };

  const port = 19191;
  const scheme = 'https';
  const nextServers = [...servers];
  const results = [];

  for (let i = 0; i < servers.length; i += 1) {
    const s = servers[i];
    const token = require('crypto').randomBytes(20).toString('hex');
    try {
      await installAgentOnServer(s, { token, port, scheme });
      nextServers[i] = { ...s, agentEnabled: true, agentPort: port, agentToken: token, agentScheme: scheme };
      results.push({ name: s.name, ok: true, port, scheme });
    } catch (e) {
      results.push({ name: s.name, ok: false, error: e.message });
    }
  }

  cfg.servers = nextServers;
  config.save(cfg);
  if (monitor) monitor.updateServers(entitledServers(nextServers));

  const okCount = results.filter(x => x.ok).length;
  return {
    ok: okCount > 0,
    partial: okCount > 0 && okCount < results.length,
    results,
    okCount,
    failCount: results.length - okCount,
  };
});

ipcMain.handle('agent:remove', async (_e, name) => {
  const cfg = config.load();
  const servers = cfg.servers || [];
  const s = servers.find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };

  const removeCmd = [
    'systemctl stop anyone-agent 2>/dev/null || true',
    'systemctl disable anyone-agent 2>/dev/null || true',
    'rm -f /etc/systemd/system/anyone-agent.service',
    'systemctl daemon-reload',
    'rm -rf /opt/anyone-agent',
  ].join('\n');

  try {
    const { runSsh } = require('./src/monitor');
    await runSsh(s, removeCmd, 15000);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const updated = servers.map(x => x.name === name ? { ...x, agentEnabled: false, agentPort: undefined, agentToken: undefined, agentScheme: undefined } : x);
  cfg.servers = updated;
  config.save(cfg);
  if (monitor) monitor.updateServers(entitledServers(updated));
  return { ok: true };
});

ipcMain.handle('htop:open', async (_e, name) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'Server not found: ' + name };
  if (SANDBOX) return { ok: true, embedded: true };
  // Force TERM to xterm-256color: some remote sessions inherit TERM=unknown
  // (e.g. when sshd's environment is stripped) which makes htop error out with
  // "Error opening terminal: unknown". We set it explicitly before running.
  // Try htop first; if it's missing fall back to `top` so the terminal isn't
  // empty. `command -v` avoids running htop if it resolves to nothing.
  const remoteCmd = 'export TERM=xterm-256color; command -v htop >/dev/null 2>&1 && htop || top';
  return openRemoteTerminal(s, remoteCmd, 'htop');
});

app.on('window-all-closed', (e) => {
  // Keep app alive in the menu bar.
  if (!isQuitting) e.preventDefault?.();
});

// macOS: clicking dock icon while window is hidden → show it.
app.on('activate', () => {
  if (win) { win.show(); win.focus(); }
  else createWindow();
});

// Close ControlMaster sockets + log streams on quit so we don't leave orphan
// ssh processes behind.
app.on('before-quit', () => {
  isQuitting = true;
  for (const t of relayReminderTimers.values()) clearInterval(t);
  relayReminderTimers.clear();
  clearDashboardKeepAliveTimer();
  try { monitor && monitor.stop(); } catch {}
  for (const session of embeddedTerminalSessions.values()) { try { session.shellSession.close(); } catch {} }
  embeddedTerminalSessions.clear();
});
