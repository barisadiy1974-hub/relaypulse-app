// Electron main process — tray icon + popover window + IPC bridge.
const { app, BrowserWindow, Tray, nativeImage, ipcMain, Menu, shell, clipboard, Notification, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const pkg = require('./package.json');

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

async function fetchJson(url) {
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

const ANYONE_TOKEN_CONTRACT = '0xFeAc2Eae96899709a43E252B6B92971D32F9C0F9';
const ANYONE_X_URL = 'https://x.com/AnyoneFDN';
const ANYONE_TELEGRAM_URL = 'https://t.me/anyoneprotocol';
const ANYONE_DASHBOARD_URL = 'https://dashboard.anyone.io';
const ANYONE_RELAYS_URL = `${ANYONE_DASHBOARD_URL}/#/relays`;
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
    ? `Dusuk RAM: ${snap.name}`
    : `Relay Back Online${issueLabel}: ${snap.name}`;
  const body = kind === 'offline'
    ? `${String(snap.error || 'Relay offline durumuna gecti.').slice(0, 180)}${issueLabel}${autoFixActive ? '\nAI auto-fix baslatildi.' : ''}`
    : kind === 'lowram'
    ? `Bellek kritik: %${snap.mem ? snap.mem.pct : '?'} kullanimda, available RAM dusuk. Donma/OOM riski — kontrol et.`
    : `Relay yeniden online gorunuyor. Source: ${source}`;
  playAlertSound(alarm.alarmSound);
  showDesktopNotification(title, body, snap.name);
}

function pickTag(xml, tag) {
  const m = String(xml || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return decodeEntities(m ? m[1] : '');
}

function parseRssItems(xml, source, limit = 6) {
  const body = String(xml || '');
  const matches = Array.from(body.matchAll(/<item\b[\s\S]*?<\/item>/gi));
  return matches.slice(0, limit).map((m) => {
    const raw = m[0];
    const title = stripHtml(pickTag(raw, 'title'));
    const link = stripHtml(pickTag(raw, 'link'));
    const pubDate = stripHtml(pickTag(raw, 'pubDate')) || stripHtml(pickTag(raw, 'published')) || stripHtml(pickTag(raw, 'updated'));
    const description = stripHtml(pickTag(raw, 'description') || pickTag(raw, 'content:encoded'));
    const parsedTs = pubDate ? Date.parse(pubDate) : NaN;
    return {
      source,
      title: title || '(untitled)',
      link,
      date: Number.isFinite(parsedTs) ? new Date(parsedTs).toISOString() : '',
      summary: description.slice(0, 280),
    };
  }).filter((x) => x.title || x.summary);
}

async function tryFetchFirst(urls, parser) {
  const errors = [];
  for (const url of urls) {
    try {
      const text = await fetchText(url, { 'user-agent': `Anyone Monitor/${pkg.version}` });
      return parser(text, url);
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

let _newsCache = { ts: 0, data: null };
async function fetchAnyoneNewsFeed() {
  const now = Date.now();
  if (_newsCache.data && (now - _newsCache.ts) < 5 * 60 * 1000) return _newsCache.data;

  const result = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    links: { x: ANYONE_X_URL, telegram: ANYONE_TELEGRAM_URL },
    items: [],
    warnings: [],
  };

  try {
    const xItems = await tryFetchFirst([
      'https://rsshub.app/twitter/user/AnyoneFDN',
      'https://rsshub.pseudoyu.com/twitter/user/AnyoneFDN',
      'https://rss.noleron.com/twitter/user/AnyoneFDN',
    ], (text) => parseRssItems(text, 'X', 6));
    result.items.push(...xItems);
  } catch (e) {
    result.warnings.push('X feed alinamadi: ' + e.message);
  }

  try {
    const tgItems = await tryFetchFirst([
      'https://rsshub.app/telegram/channel/anyoneprotocol',
      'https://rsshub.pseudoyu.com/telegram/channel/anyoneprotocol',
      'https://rss.noleron.com/telegram/channel/anyoneprotocol',
    ], (text) => parseRssItems(text, 'Telegram', 6));
    result.items.push(...tgItems);
  } catch (e) {
    result.warnings.push('Telegram feed alinamadi: ' + e.message);
  }

  result.items.sort((a, b) => {
    const at = a.date ? Date.parse(a.date) : 0;
    const bt = b.date ? Date.parse(b.date) : 0;
    return bt - at;
  });
  result.items = result.items.slice(0, 12);
  if (!result.items.length) {
    result.ok = false;
    result.error = result.warnings.join('\n') || 'News feed alinamadi.';
  }
  _newsCache = { ts: now, data: result };
  return result;
}

let _tokenPriceCache = { ts: 0, data: null };
async function fetchAnyoneTokenPrice() {
  const now = Date.now();
  if (_tokenPriceCache.data && (now - _tokenPriceCache.ts) < 60 * 1000) return _tokenPriceCache.data;

  let data = null;
  try {
    const json = await fetchJson(`https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${ANYONE_TOKEN_CONTRACT}&vs_currencies=usd&include_24hr_change=true`);
    const row = json[String(ANYONE_TOKEN_CONTRACT).toLowerCase()] || json[ANYONE_TOKEN_CONTRACT];
    if (row && row.usd != null) {
      data = {
        ok: true,
        symbol: 'ANYONE',
        priceUsd: Number(row.usd),
        change24h: row.usd_24h_change == null ? null : Number(row.usd_24h_change),
        updatedAt: new Date(now).toISOString(),
        source: 'CoinGecko',
      };
    }
  } catch {}

  if (!data) {
    try {
      const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${ANYONE_TOKEN_CONTRACT}`);
      const pair = Array.isArray(json.pairs) ? json.pairs.find((x) => x.priceUsd != null) : null;
      if (pair) {
        data = {
          ok: true,
          symbol: 'ANYONE',
          priceUsd: Number(pair.priceUsd),
          change24h: pair.priceChange && pair.priceChange.h24 != null ? Number(pair.priceChange.h24) : null,
          updatedAt: new Date(now).toISOString(),
          source: 'DexScreener',
        };
      }
    } catch {}
  }

  if (!data) {
    data = { ok: false, error: 'ANYONE token fiyatı alinamadi.', updatedAt: new Date(now).toISOString() };
  }
  _tokenPriceCache = { ts: now, data };
  return data;
}

async function fetchRelayRewardsData(name, wallet) {
  const audit = await ipcAuditByName(name);
  if (!audit.ok) return audit;
  const fingerprint = audit.parsed && audit.parsed.FINGERPRINT;
  const boundWallet = String(wallet || '').trim() || extractWalletFromContact(audit.parsed && audit.parsed.contact);
  if (!fingerprint) {
    return { ok: false, error: 'Fingerprint bulunamadi. Once Audit relay calistir.' };
  }
  const result = { ok: true, audit: audit.parsed || {}, fingerprint, wallet: boundWallet, lookup: null, latestReward: null, claimed: null, miners: null };
  const tasks = [];
  tasks.push(fetchJson(`https://api.ec.anyone.tech/relays/${fingerprint}`).then(x => { result.lookup = x; }).catch(e => { result.lookupError = e.message; }));
  tasks.push(fetchJson(`https://relay-api.anyone.io/api/rewards/${fingerprint}`).then(x => { result.latestReward = x; }).catch(e => { result.latestRewardError = e.message; }));
  if (boundWallet) {
    tasks.push(fetchJson(`https://relay-api.anyone.io/api/miners/${boundWallet}`).then(x => {
      result.miners = x;
      const arr = Array.isArray(x) ? x : [];
      result.claimed = arr.some(item => String(item.deviceId || '').toUpperCase() === String(fingerprint).toUpperCase());
    }).catch(e => { result.minersError = e.message; }));
  }
  await Promise.all(tasks);
  return result;
}

function normalizeLatestReward(latestReward) {
  const item = Array.isArray(latestReward) ? latestReward[0] : latestReward;
  if (!item || typeof item !== 'object') return null;
  const amount = Number(item.amount ?? item.value ?? item.reward ?? 0);
  const date = item.date || item.timestamp || item.epochDate || item.createdAt || '';
  return {
    raw: item,
    amount: Number.isFinite(amount) ? amount : 0,
    date,
  };
}

function estimateEarnings(latestReward, claimed) {
  const normalized = normalizeLatestReward(latestReward);
  if (!normalized || !claimed) {
    return {
      latestAmount: 0,
      latestDate: normalized ? normalized.date : '',
      hourly: 0,
      daily: 0,
      monthly: 0,
    };
  }
  // relay-api returns per-epoch reward; epoch = 1 hour (roundPeriod = 3600)
  const hourly = Math.max(0, normalized.amount);
  const daily = hourly * 24;
  return {
    latestAmount: hourly,
    latestDate: normalized.date,
    hourly,
    daily,
    monthly: daily * 30,
  };
}

function normalizeClaimAndLock(rewards, fingerprint) {
  const latest = normalizeLatestReward(rewards && rewards.latestReward);
  const latestAmount = latest ? latest.amount : 0;
  const miners = Array.isArray(rewards && rewards.miners) ? rewards.miners : [];
  const miner = miners.find((item) => String(item.deviceId || '').toUpperCase() === String(fingerprint || '').toUpperCase());
  const lockAmount = miner
    ? Number(
        miner.locked ??
        miner.lock ??
        miner.lockAmount ??
        miner.stake ??
        miner.staked ??
        miner.tokensLocked ??
        miner.amount ??
        0
      )
    : 0;
  const hasReward = latestAmount > 0;
  let claimed = rewards ? rewards.claimed : null;
  let claimSource = rewards && rewards.claimed != null ? 'wallet' : 'unknown';
  if (claimed == null && hasReward) {
    claimed = true;
    claimSource = 'reward';
  }
  const earning = hasReward;
  const locked = lockAmount > 0 ? true : (claimed === true ? null : false);
  return {
    claimed,
    claimSource,
    locked,
    lockAmount: Number.isFinite(lockAmount) ? lockAmount : 0,
    earning,
    latestAmount,
    latestDate: latest ? latest.date : '',
  };
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
        wallet: s.wallet || extractWalletFromContact(parsed.contact) || '',
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
        wallet: s.wallet || '',
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
    copyText: rows.map((r) => `${r.name}\t${r.fingerprint || '-'}${r.wallet ? `\t${r.wallet}` : ''}`).join('\n'),
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
    return 'SSH kimlik bilgisi reddedildi; kullanici/parola/key kontrol et.';
  }
  if (/Connection refused|SSH reddedildi/i.test(text)) {
    return 'SSH portu reddedildi; sunucuda ssh/sshd veya firewall kontrol et.';
  }
  if (/timed out|timeout|zaman asimi/i.test(text)) {
    return 'SSH zaman asimi; sunucu veya ag gec yanit veriyor.';
  }
  if (/Could not resolve hostname|resolve hostname/i.test(text)) {
    return 'Host adi cozulmedi; relay host kaydini kontrol et.';
  }
  return text.slice(0, 220);
}

async function fetchDashboardTrackerSnapshot(forceRefreshFingerprints = false) {
  const fpsResult = await getDashboardTrackerFingerprints(forceRefreshFingerprints);
  if (!fpsResult.ok) return { ok: false, error: fpsResult.error || 'fingerprintler alinamadi' };
  const rows = await Promise.all((fpsResult.rows || []).map(async (row) => {
    const base = {
      name: row.name,
      nickname: row.nickname || '',
      fingerprint: row.fingerprint || '',
      wallet: row.wallet || '',
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
      blocked.push({ name: row.name, ok: false, error: 'server bulunamadi' });
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
        error: 'Yazilmadi: once yukaridaki SSH/config hatalari duzelmeli.',
      })),
    ];
    return {
      ok: false,
      updatedAt: new Date().toISOString(),
      count: plan.rows.length,
      okCount: 0,
      blockedCount: blocked.length,
      dryRunStopped: true,
      error: `${blocked.length} relay SSH/config precheck gecemedi. Hicbir relay degistirilmedi.`,
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

async function fetchFleetHealthAndRewards() {
  const cfg = config.load();
  const servers = cfg.servers || [];
  const fpsResult = await fetchAllRelayFingerprints();
  const familyPlan = await buildRelayFamilyPlan();
  const familyMap = new Map((familyPlan.rows || []).map((row) => [row.name, row]));
  const rows = await Promise.all((fpsResult.rows || []).map(async (row) => {
    const family = familyMap.get(row.name) || {};
    const hasContactInfo = !!extractWalletFromContact(row.wallet || '') || !!extractWalletFromContact(row.contact || '') || !!String(row.wallet || '').trim();
    const hasMyFamily = !!String(row.myFamily || '').trim();
    const base = {
      name: row.name,
      ok: !!row.ok,
      fingerprint: row.fingerprint || '',
      wallet: row.wallet || '',
      myFamily: row.myFamily || '',
      familyUpToDate: family.familyUpToDate != null ? !!family.familyUpToDate : null,
      expectedFamilyLine: family.familyLine || '',
      currentFamilyLine: family.currentFamilyLine || row.myFamily || '',
      hasContactInfo,
      hasMyFamily,
      claimed: null,
      claimSource: 'unknown',
      locked: null,
      lockAmount: 0,
      earning: false,
      latestAmount: 0,
      latestDate: '',
      estHourly: 0,
      estDaily: 0,
      estMonthly: 0,
      error: row.error || '',
    };
    if (!row.ok || !row.fingerprint) return base;
    try {
      const rewards = await fetchRelayRewardsData(row.name, row.wallet || '');
      const state = normalizeClaimAndLock(rewards, row.fingerprint);
      const earnings = estimateEarnings(rewards.latestReward, state.claimed === true);
      const zeroReason = rewards.latestRewardError
        ? 'Reward API su an veri donmuyor'
        : (state.claimed === false
            ? 'Claim yok veya wallet eslesmedi'
            : (state.claimed == null
                ? 'Claim durumu dogrulanamadi'
                : (!state.earning ? 'Bu relay icin reward kaydi bulunamadi' : '')));
      return {
        ...base,
        claimed: state.claimed,
        claimSource: state.claimSource,
        locked: state.locked,
        lockAmount: state.lockAmount,
        earning: state.earning,
        latestAmount: earnings.latestAmount,
        latestDate: earnings.latestDate,
        estHourly: earnings.hourly,
        estDaily: earnings.daily,
        estMonthly: earnings.monthly,
        zeroReason,
        rewardWarning: rewards.latestRewardError || rewards.minersError || rewards.lookupError || '',
      };
    } catch (e) {
      return { ...base, error: e.message };
    }
  }));
  const totals = rows.reduce((acc, row) => {
    acc.hourly += Number(row.estHourly || 0);
    acc.daily += Number(row.estDaily || 0);
    acc.monthly += Number(row.estMonthly || 0);
    if (row.claimed === true) acc.claimed += 1;
    if (row.claimed === false) acc.unclaimed += 1;
    if (row.locked === true) acc.locked += 1;
    if (row.earning === true) acc.earning += 1;
    if (!row.hasContactInfo) acc.missingContact += 1;
    if (!row.hasMyFamily) acc.missingFamily += 1;
    if (row.familyUpToDate === false) acc.outdatedFamily += 1;
    return acc;
  }, { hourly: 0, daily: 0, monthly: 0, claimed: 0, unclaimed: 0, locked: 0, earning: 0, missingContact: 0, missingFamily: 0, outdatedFamily: 0 });
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    rows,
    totals,
  };
}

function extractWalletFromContact(contact) {
  const m = String(contact || '').match(/0x[a-fA-F0-9]{40}/);
  return m ? m[0] : '';
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
            error: 'Relay API bu fingerprint icin henuz flag/veri donmedi',
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
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };
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
let dashboardKeepAliveWin = null;
let dashboardKeepAliveTimer = null;
let dashboardKeepAliveState = {
  enabled: false,
  reloadMinutes: 5,
  url: ANYONE_RELAYS_URL,
  lastReloadAt: '',
  lastLoadAt: '',
  lastError: '',
};
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
          if (!hasFlagData) { dashboardFlagsCache.set(name, { ok: false, error: 'veri yok' }); return; }
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
const autoFixInProgress = new Set();
const uptimeStatsPath = path.join(app.getPath('userData'), 'uptime-stats.json');
const uptimeStats = new Map();

// --- Kalıcı günlük ödül geçmişi (reward-history.json) ---
const rewardHistoryPath = path.join(app.getPath('userData'), 'reward-history.json');
let rewardHistoryStore = { days: {} }; // dayKey "YYYY-MM-DD" -> { fleetDaily, perRelay:{fp:rate}, ts }
function loadRewardHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(rewardHistoryPath, 'utf8'));
    rewardHistoryStore = raw && raw.days ? raw : { days: {} };
  } catch { rewardHistoryStore = { days: {} }; }
  if (!rewardHistoryStore.days) rewardHistoryStore.days = {};
  if (!Array.isArray(rewardHistoryStore.samples)) rewardHistoryStore.samples = [];
}
function saveRewardHistory() {
  try {
    const keys = Object.keys(rewardHistoryStore.days).sort();
    while (keys.length > 90) delete rewardHistoryStore.days[keys.shift()]; // son 90 gün
    fs.writeFileSync(rewardHistoryPath, JSON.stringify(rewardHistoryStore), 'utf8');
  } catch {}
}

function emitDashboardTrackerState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('dashboard-tracker-state', { ...dashboardKeepAliveState });
  }
}

function setDashboardTrackerState(patch) {
  dashboardKeepAliveState = { ...dashboardKeepAliveState, ...patch };
  emitDashboardTrackerState();
}

function clearDashboardKeepAliveTimer() {
  if (dashboardKeepAliveTimer) clearInterval(dashboardKeepAliveTimer);
  dashboardKeepAliveTimer = null;
}

function destroyDashboardKeepAliveWindow() {
  if (dashboardKeepAliveWin && !dashboardKeepAliveWin.isDestroyed()) {
    try { dashboardKeepAliveWin.destroy(); } catch {}
  }
  dashboardKeepAliveWin = null;
}

function ensureDashboardKeepAliveWindow() {
  if (dashboardKeepAliveWin && !dashboardKeepAliveWin.isDestroyed()) return dashboardKeepAliveWin;
  dashboardKeepAliveWin = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'Anyone Dashboard KeepAlive',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  dashboardKeepAliveWin.on('closed', () => {
    dashboardKeepAliveWin = null;
    if (dashboardKeepAliveState.enabled) setDashboardTrackerState({ lastError: 'Background dashboard window kapandi.' });
  });
  dashboardKeepAliveWin.webContents.on('did-finish-load', () => {
    setDashboardTrackerState({ lastLoadAt: new Date().toISOString(), lastError: '' });
  });
  dashboardKeepAliveWin.webContents.on('did-fail-load', (_e, code, desc) => {
    setDashboardTrackerState({ lastError: `did-fail-load ${code}: ${desc}` });
  });
  dashboardKeepAliveWin.webContents.on('render-process-gone', (_e, details) => {
    setDashboardTrackerState({ lastError: `render-process-gone: ${details && details.reason ? details.reason : 'unknown'}` });
  });
  return dashboardKeepAliveWin;
}

async function reloadDashboardKeepAlive(reason = 'manual') {
  try {
    const keeper = ensureDashboardKeepAliveWindow();
    await keeper.loadURL(ANYONE_RELAYS_URL);
    setDashboardTrackerState({ lastReloadAt: new Date().toISOString(), lastError: '' });
    return { ok: true, reason };
  } catch (e) {
    setDashboardTrackerState({ lastReloadAt: new Date().toISOString(), lastError: e.message });
    return { ok: false, error: e.message, reason };
  }
}

async function setDashboardKeepAliveEnabled(enabled, reloadMinutes) {
  const nextMinutes = Math.max(1, Math.min(60, Number(reloadMinutes) || dashboardKeepAliveState.reloadMinutes || 5));
  setDashboardTrackerState({ enabled: !!enabled, reloadMinutes: nextMinutes, url: ANYONE_RELAYS_URL });
  clearDashboardKeepAliveTimer();
  if (!enabled) {
    destroyDashboardKeepAliveWindow();
    return { ok: true, ...dashboardKeepAliveState };
  }
  await reloadDashboardKeepAlive('enable');
  dashboardKeepAliveTimer = setInterval(() => {
    void reloadDashboardKeepAlive('timer');
  }, nextMinutes * 60 * 1000);
  return { ok: true, ...dashboardKeepAliveState };
}

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
    return { autoFixable: false, reason: 'SSH kimlik bilgisi veya host key sorunu var; uzaktan komut calistirilemez.' };
  }
  // Bağlantı kurulamadan kopan durumlar da auto-fix'e KAPALI olmalı: komut
  // çalıştırılacak bir oturum yok. Türkçe formatlanmış mesajlar da eşleşmeli —
  // classifyAutoFixability'ye monitor.js'in ürettiği metin geliyor, ham ssh çıktısı değil.
  // (2026-08-21: "Connection reset" kalıbı eksik olduğu için erişilemeyen 3 kutuya
  //  saatlerce OpenAI isteği atıldı ve ulaşılamayan makinede komut denendi.)
  if (/SSH reddedildi|Connection refused|No route to host|Network is unreachable|Operation timed out|timed out/i.test(msg)
      || /Connection reset|reset by peer|Connection closed by|Broken pipe|kex_exchange_identification|banner exchange/i.test(msg)
      || /oturumu uzak tarafca kapatildi|baglantisi koptu|Ag erisimi yok/i.test(msg)) {
    return { autoFixable: false, reason: 'SSH baglantisi kurulamiyor; sunucuya erismeden auto-fix komutu calistirilamaz.' };
  }
  return { autoFixable: true, reason: '' };
}

async function triggerAutoFix(snap) {
  if (autoFixInProgress.has(snap.name)) return;
  autoFixInProgress.add(snap.name);
  autoFixLog(`${snap.name} tetiklendi — hata: ${(snap.error || 'offline').slice(0, 120)}`);
  try {
    const cfg = config.load();
    if (!cfg.autoFixEnabled) { autoFixLog(`${snap.name} atlandi — autofix kapali`); return; }
    const verdict = classifyAutoFixability(snap.error);
    if (!verdict.autoFixable) {
      autoFixLog(`${snap.name} atlandi — auto-fix uygulanamaz: ${verdict.reason}`);
      showDesktopNotification(`Auto-Fix Skipped: ${snap.name}`, verdict.reason);
      const result = { ok: false, action: 'none', reason: verdict.reason, error: snap.error || '' };
      const payload = { name: snap.name, result };
      if (win && !win.isDestroyed()) win.webContents.send('autofix-result', payload);
      else pendingAutoFixResults.push(payload);
      return;
    }
    showDesktopNotification(`Auto-Fix: ${snap.name}`, 'AI analiz ediyor...');
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
        const ageLabel = ageSec < 120 ? `${ageSec} saniye önce` : `${Math.round(ageSec / 60)} dakika önce`;
        recentLogs = [`(SSH erişilemiyor — bu loglar ${ageLabel} önbelleğe alındı, kaynak: ${cached.source})`, ...cached.lines];
        logSource = `cached(${ageLabel})`;
        autoFixLog(`${snap.name} canlı log alınamadı, önbellekten kullanılıyor (${ageLabel} önce, ${cached.lines.length} satır)`);
      }
    }
    const server = (cfg.servers || []).find(s => s.name === snap.name);
    if (!server) { autoFixLog(`${snap.name} atlandi — sunucu config'de bulunamadi`); return; }
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
    const lastKnownAnon = cached && cached.anonState ? `Son bilinen anon durumu: ${cached.anonState.active || 'bilinmiyor'}` : '';
    const offlineCtx = offlineSince > 5 ? `Offline süresi: ~${offlineSince < 120 ? offlineSince + 's' : Math.round(offlineSince / 60) + ' dakika'}` : '';
    const logCtx = logSource !== 'live' ? `Log kaynağı: ${logSource}` : '';
    const errorMsg = [snap.error || 'Sunucu offline', dashboardHint, lastKnownAnon, offlineCtx, logCtx].filter(Boolean).join(' | ');
    const result = await AiFixer.analyzeAndFix({
      server,
      errorMsg,
      recentLogs,
      cfg,
      runCommandFn: dryRun
        ? async (_name, cmd) => ({ ok: true, output: `[dry-run] ${cmd}` })
        : (name, cmd) => monitor.runCommand(name, cmd),
    });
    autoFixLog(`${snap.name} sonuc: action=${result.action || 'error'} ok=${result.ok} dryRun=${dryRun ? 'yes' : 'no'} reason=${result.reason || ''} error=${result.error || ''}`);
    if (result.action === 'none') {
      showDesktopNotification(`Auto-Fix: ${snap.name}`, `AI: ${result.reason}`);
    } else if (dryRun) {
      showDesktopNotification(`Auto-Fix DRY-RUN: ${snap.name}`, `${result.commandName || 'command'} calistirilmadi\n${result.reason || ''}`.trim());
    } else if (result.ok) {
      showDesktopNotification(`Auto-Fix OK: ${snap.name}`, `${result.commandName} calistirildi\n${result.reason}`);
    } else {
      showDesktopNotification(`Auto-Fix Hatasi: ${snap.name}`, result.error || 'bilinmeyen hata');
    }
    const payload = { name: snap.name, result };
    if (win && !win.isDestroyed()) {
      win.webContents.send('autofix-result', payload);
    } else {
      pendingAutoFixResults.push(payload);
    }
  } catch (e) {
    autoFixLog(`${snap.name} istisna: ${e.message}`);
    showDesktopNotification(`Auto-Fix Hatasi: ${snap.name}`, e.message);
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
      webviewTag: true,
    },
  });
  const trialCfg = config.load();
  const TRIAL_DAYS = 14;
  const trialExpired = !isLicensed(trialCfg) && trialCfg.firstLaunchAt && (Date.now() - trialCfg.firstLaunchAt) > TRIAL_DAYS * 24 * 60 * 60 * 1000;
  win.loadFile(path.join(__dirname, 'renderer', trialExpired ? 'trial-expired.html' : 'index.html'));
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
  destroyDashboardKeepAliveWindow();
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
    const menu = Menu.buildFromTemplate([
      { label: 'Open Dashboard', click: () => toggleWindow() },
      { label: 'Reload', click: () => win && win.reload() },
      { type: 'separator' },
      {
        label: `Auto-Fix: ${fixEnabled ? 'Acik ✓' : 'Kapali'}`,
        click: () => {
          const c = config.load();
          c.autoFixEnabled = !c.autoFixEnabled;
          config.save(c);
          if (win && !win.isDestroyed()) win.webContents.send('autofix-toggle', { autoFixEnabled: c.autoFixEnabled });
        },
      },
      {
        label: `Dry-run: ${cfg.autoFixDryRun ? 'Acik ✓' : 'Kapali'}`,
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
  loadUptimeStats();
  loadRewardHistory();

  // Inject ethereum provider into dashboard.anyone.io webview
  // Preload must be a real filesystem path (cannot be inside .asar), so copy to userData
  try {
    const { session: electronSession } = require('electron');
    const dashSession = electronSession.fromPartition('persist:anyondash');
    const preloadSrc = path.join(__dirname, 'src', 'webview-preload.js');
    const preloadDest = path.join(app.getPath('userData'), 'webview-preload.js');
    fs.writeFileSync(preloadDest, fs.readFileSync(preloadSrc, 'utf8'), 'utf8');
    dashSession.setPreloads([preloadDest]);
    // Write wallet address so preload can read it (same userData path as config)
    const cfg0 = config.load();
    const walletServer = (cfg0.servers || []).find(s => s.wallet && String(s.wallet).trim());
    const walletAddr = walletServer ? String(walletServer.wallet).trim() : '';
    const walletJsonPath = path.join(app.getPath('userData'), 'webview-wallet.json');
    fs.writeFileSync(walletJsonPath, JSON.stringify({ wallet: walletAddr }), 'utf8');
    console.log('[ok] webview preload set, wallet:', walletAddr ? walletAddr.slice(0, 10) + '…' : 'none');

    // Intercept webview network responses to capture reward data from AO/dashboard
    dashSession.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
      if (!details.responseHeaders) return;
      const ct = (details.responseHeaders['content-type'] || details.responseHeaders['Content-Type'] || []).join('');
      if (!ct.includes('json')) return;
      // Only capture AO / arweave / anyone reward-related endpoints
      const url = details.url || '';
      if (!/arweave|ao-testnet|cu\.|su-router|anyone\.io/i.test(url)) return;
      // Forward URL hint to renderer so it can fetch+parse
      if (win && !win.isDestroyed()) {
        win.webContents.send('webview-reward-url', { url, statusCode: details.statusCode });
      }
    });
  } catch(e) { console.error('[webview-preload] setup failed:', e && e.message); }

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
  monitor = new Monitor(config.load(), { debugLogPath });
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
        autoFixLog(`${data.name} hâlâ offline (${offlineCount}. ardışık snapshot) — auto-fix tekrar tetikleniyor`);
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
          autoFixLog(`${data.name} anon servisi durdu (${nextAnon}, ${nextInactiveCount}. ardışık) — auto-fix tetikleniyor`);
          const syntheticSnap = { ...data, error: `anon servisi ${nextAnon} oldu` };
          handleOfflineIncident(syntheticSnap, { source: 'anon' });
        } else if (nextAnon === 'active' && prevAnon !== 'active' && prevAnon !== undefined && prevAnon !== 'unknown') {
          // İlk poll'da (prevAnon===undefined) "tekrar aktif" yazma — relay zaten sağlıklı.
          // Sadece gerçekten inactive/failed gözlemlenmiş bir relay toparlanınca logla.
          autoFixLog(`${data.name} anon servisi tekrar aktif`);
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
        const syntheticSnap = { ...data, error: 'dashboard_running=false: relay agda gorunmuyor, port veya guard sorunu olabilir' };
        handleOfflineIncident(syntheticSnap, { source: 'dashboard' });
      }
    } else if (data.flags && data.flags.running === true) {
      if ((dashboardRedCounts.get(data.name) || 0) > 0) {
        autoFixLog(`${data.name} dashboard running=true — toparlandı, sayaç sıfırlandı`);
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

// --- IPC handlers ---
ipcMain.handle('servers:get', () => config.load().servers);
ipcMain.handle('servers:save', (_e, servers) => {
  const cfg = config.load();
  cfg.servers = servers;
  config.save(cfg);
  dashboardTrackerFingerprintCache = { updatedAt: '', rows: [] };
  monitor.updateServers(servers);
  return true;
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
    languageMode: cfg.languageMode || 'en',
    alarmEnabled: cfg.alarmEnabled !== false,
    alarmSound: ALERT_SOUNDS[cfg.alarmSound] ? cfg.alarmSound : 'Blow',
    alarmRepeatMinutes: Math.max(1, Math.min(60, Number(cfg.alarmRepeatMinutes) || 5)),
    ramWarnPct: Math.max(70, Math.min(99, Number(cfg.ramWarnPct) || 90)),
    connectionMode: cfg.connectionMode || 'https',
  };
});
ipcMain.handle('settings:save', (_e, s) => {
  const cfg = config.load();
  Object.assign(cfg, s);
  config.save(cfg);
  monitor.updateSettings(s);
  ramWarnPct = Math.max(70, Math.min(99, Number(cfg.ramWarnPct) || 90));
  return true;
});
ipcMain.handle('alarm:test', async () => {
  const alarm = getAlarmSettings();
  if (!alarm.alarmEnabled) return { ok: false, error: 'Alarm kapali. Once aktif et.' };
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
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };
  return await monitor.setupHealthCheck(s);
});
ipcMain.handle('relay:bindWallet', async (_e, name, wallet) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };
  return await monitor.bindRelayWallet(s, wallet);
});
ipcMain.handle('relay:rewards', async (_e, name, wallet) => {
  return await fetchRelayRewardsData(name, wallet);
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
ipcMain.handle('relay:fleetHealthRewards', async () => {
  return await fetchFleetHealthAndRewards();
});

// --- Günlük ödül geçmişi (kalıcı) ---
ipcMain.handle('rewardHistory:get', () => ({
  days: rewardHistoryStore.days || {},
  samples: rewardHistoryStore.samples || [],
}));
ipcMain.handle('rewardHistory:append', (_e, payload) => {
  try {
    const dayKey = String((payload && payload.day) || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return { ok: false, error: 'gecersiz gun' };
    const prev = rewardHistoryStore.days[dayKey] || {};
    const accum = Number(payload.fleetAccum) || 0;
    const ts = Number(payload.ts) || Date.now();
    rewardHistoryStore.days[dayKey] = {
      fleetDaily: Number(payload.fleetDaily) || prev.fleetDaily || 0,
      // birikmiş toplam gün içinde artar → o günün en yükseğini sakla (monoton)
      fleetAccum: Math.max(accum, Number(prev.fleetAccum) || 0),
      perRelay: (payload.perRelay && typeof payload.perRelay === 'object') ? payload.perRelay : (prev.perRelay || {}),
      ts,
    };
    // Saatlik çözünürlük için zaman damgalı Σ örneği (son 72 saat / 200 örnek)
    if (!Array.isArray(rewardHistoryStore.samples)) rewardHistoryStore.samples = [];
    if (accum > 0) {
      rewardHistoryStore.samples.push({ ts, accum });
      const cutoff = ts - 72 * 3600000;
      rewardHistoryStore.samples = rewardHistoryStore.samples.filter(s => s && s.ts >= cutoff).slice(-200);
    }
    saveRewardHistory();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Returns AO reward data keyed by fingerprint so renderer can compute per-relay estimates
ipcMain.handle('relay:aoFingerprintRewards', async (_e, fingerprints = [], wallets = []) => {
  try {
    const AO_CU = 'https://cu.anyone.tech';
    const RELAY_REWARDS_PROCESS = 'uEtOd6F1Yv0Fg_Ym161taXFjIokBgDUNEBDcgGWA6aA';
    const ownerWallet = (Array.isArray(wallets) && wallets.find(w => w && String(w).startsWith('0x'))) || '0x0000000000000000000000000000000000000000';
    const aoResp = await fetch(`${AO_CU}/dry-run?process-id=${RELAY_REWARDS_PROCESS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Id: '1234', Owner: ownerWallet, Tags: [{ name: 'Action', value: 'View-State' }], Data: '' }),
    });
    if (!aoResp.ok) {
      // AO Scheduler Unit hiz siniri uygularsa govde 429 dondurur (HTTP 500 icinde de gelebilir).
      const body = await aoResp.text().catch(() => '');
      const busy = aoResp.status === 429 || /\b429\b|too many requests/i.test(body);
      return { ok: false, busy, error: busy ? 'AO agi mesgul (429)' : `AO HTTP ${aoResp.status}` };
    }
    const aoData = await aoResp.json();
    const msgs = (aoData && aoData.Messages) || [];
    if (!msgs.length) return { ok: false, error: 'AO: no messages' };
    const state = JSON.parse(msgs[0].Data);
    const tps = Number((state.Configuration && state.Configuration.TokensPerSecond) || '0') / 1e18;
    const tfr = state.TotalFingerprintReward || {};
    const tar = state.TotalAddressReward || {};
    const claimed = state.Claimed || {};
    const roundPeriod = Number((state.PreviousRound && state.PreviousRound.Period) || 3600);

    // Compute total accumulated rewards across all fingerprints (back-compat fpShares)
    let totalAccum = 0;
    for (const v of Object.values(tfr)) totalAccum += Number(v);
    const fpShares = {};
    if (totalAccum > 0) {
      for (const [fp, v] of Object.entries(tfr)) fpShares[fp] = Number(v) / totalAccum;
    }

    // --- KESIN HESAPLAMA: gercek birikmis odul + delta-tabanli gercek hiz ---
    const reqFps = (Array.isArray(fingerprints) ? fingerprints : [])
      .map(f => String(f || '').toUpperCase()).filter(f => /^[A-F0-9]{40}$/.test(f));
    const now = Date.now();
    const fpRewards = {};
    for (const fp of reqFps) {
      const cum = tfr[fp] !== undefined ? Number(tfr[fp]) / 1e18 : 0;
      fpRewards[fp] = { total: cum, hourly: null, daily: null, ready: false };
    }

    // Kalici snapshot gecmisi — delta ile gercek saatlik/gunluk hiz
    const histPath = path.join(app.getPath('userData'), 'reward-history.json');
    let hist = { snapshots: [] };
    try { hist = JSON.parse(fs.readFileSync(histPath, 'utf8')) || { snapshots: [] }; } catch {}
    if (!Array.isArray(hist.snapshots)) hist.snapshots = [];
    const snapFps = {};
    for (const fp of reqFps) if (tfr[fp] !== undefined) snapFps[fp] = Number(tfr[fp]) / 1e18;
    if (Object.keys(snapFps).length) {
      const last = hist.snapshots[hist.snapshots.length - 1];
      if (!last || (now - last.ts) > 5 * 60 * 1000) {
        hist.snapshots.push({ ts: now, fps: snapFps });
      } else {
        last.ts = now; last.fps = { ...last.fps, ...snapFps };
      }
    }
    // 35 gunden eski kayitlari at, en fazla 5000 snapshot tut
    const cutoff = now - 35 * 24 * 3600 * 1000;
    hist.snapshots = hist.snapshots.filter(s => s.ts >= cutoff);
    if (hist.snapshots.length > 5000) hist.snapshots = hist.snapshots.slice(-5000);

    // Her fp icin: en eski snapshot ile simdiki deger arasindaki fark = gercek hiz
    for (const fp of reqFps) {
      let oldest = null;
      for (const s of hist.snapshots) {
        if (s.fps && s.fps[fp] !== undefined) { oldest = s; break; }
      }
      if (oldest && oldest.ts < now) {
        const elapsedH = (now - oldest.ts) / 3600000;
        if (elapsedH >= 1) { // en az 1 tur (1 saat) verisi birikmis olmali
          const delta = fpRewards[fp].total - Number(oldest.fps[fp]);
          const hourly = delta > 0 ? delta / elapsedH : 0;
          fpRewards[fp].hourly = hourly;
          fpRewards[fp].daily = hourly * 24;
          fpRewards[fp].ready = true;
          fpRewards[fp].windowH = elapsedH;
        }
      }
    }
    try { fs.writeFileSync(histPath, JSON.stringify(hist)); } catch {}

    // Cuzdan toplamlari (gercek birikmis / talep edilmis / edilmemis)
    const findCI = (m, w) => { for (const [k, v] of Object.entries(m)) if (k.toLowerCase() === String(w).toLowerCase()) return v; return null; };
    const walletTotals = {};
    for (const w of (Array.isArray(wallets) ? wallets : [])) {
      if (!w || !String(w).startsWith('0x')) continue;
      const acc = findCI(tar, w); const cl = findCI(claimed, w);
      const accA = acc != null ? Number(acc) / 1e18 : 0;
      const clA = cl != null ? Number(cl) / 1e18 : 0;
      walletTotals[w] = { accumulated: accA, claimed: clA, unclaimed: Math.max(0, accA - clA) };
    }

    return { ok: true, tps, totalActiveRelays: Object.keys(tfr).length, fpShares, fpRewards, walletTotals, roundPeriod };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('relay:aoRewardEstimates', async () => {
  try {
    const cfg = config.load();
    const wallet = ((cfg.servers || []).map(s => s.wallet).find(w => w && w.startsWith('0x')) || '').trim();

    const AO_CU = 'https://cu.anyone.tech';
    const RELAY_REWARDS_PROCESS = 'uEtOd6F1Yv0Fg_Ym161taXFjIokBgDUNEBDcgGWA6aA';

    const aoResp = await fetch(`${AO_CU}/dry-run?process-id=${RELAY_REWARDS_PROCESS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Id: '1234',
        Owner: wallet || '0x0000000000000000000000000000000000000000',
        Tags: [{ name: 'Action', value: 'View-State' }],
        Data: '',
      }),
    });
    if (!aoResp.ok) {
      // AO Scheduler Unit hiz siniri uygularsa govde 429 dondurur (HTTP 500 icinde de gelebilir).
      const body = await aoResp.text().catch(() => '');
      const busy = aoResp.status === 429 || /\b429\b|too many requests/i.test(body);
      return { ok: false, busy, error: busy ? 'AO agi mesgul (429)' : `AO HTTP ${aoResp.status}` };
    }
    const aoData = await aoResp.json();

    const msgs = (aoData && aoData.Messages) || [];
    if (!msgs.length) return { ok: false, error: 'AO: no messages' };

    const state = JSON.parse(msgs[0].Data);
    const tpsRaw = state.Configuration && state.Configuration.TokensPerSecond ? state.Configuration.TokensPerSecond : '0';
    // TokensPerSecond is in wei (1e18 = 1 ANYONE), represents total network emission per second
    const tps = Number(tpsRaw) / 1e18;
    // TotalFingerprintReward is ACCUMULATED (not per-round), so do NOT use it as rate
    // Use tps × (userRelayCount / totalActiveRelays) for correct rate estimates
    const totalFingerprintReward = state.TotalFingerprintReward || {};
    const totalActiveRelays = Object.keys(totalFingerprintReward).length || 1;

    // Try to read user fingerprints from ALL_FINGERPRINTS.txt (no SSH)
    const fpFilePaths = [
      path.join(app.getPath('userData'), 'ALL_FINGERPRINTS.txt'),
      path.join(app.getPath('home'), 'anon-backup', 'ALL_FINGERPRINTS.txt'),
      path.join(app.getPath('desktop'), 'ALL_FINGERPRINTS.txt'),
    ];
    const userFingerprints = new Set();
    for (const fpath of fpFilePaths) {
      try {
        const text = fs.readFileSync(fpath, 'utf8');
        for (const line of text.split('\n')) {
          const m = line.match(/[A-Fa-f0-9]{40}/);
          if (m) userFingerprints.add(m[0].toUpperCase());
        }
        if (userFingerprints.size > 0) break;
      } catch {}
    }

    let hourly = 0, daily = 0, monthly = 0, method = '', userRelayCount = 0;

    // Method 1: count user's fingerprints that are active in AO reward map
    if (userFingerprints.size > 0) {
      let activeCount = 0;
      for (const fp of userFingerprints) {
        if (totalFingerprintReward[fp] !== undefined) activeCount++;
      }
      if (activeCount > 0) {
        userRelayCount = activeCount;
        hourly = tps * 3600 * (activeCount / totalActiveRelays);
        daily = tps * 86400 * (activeCount / totalActiveRelays);
        monthly = daily * 30;
        method = 'fingerprints';
      }
    }

    // Method 2: use relay count from monitoring state
    if (hourly === 0) {
      // Count all configured relays (online+stale+offline) as a proxy
      const configuredCount = (config.load().servers || []).length;
      const onlineCount = Array.from(relayAlertStates.values()).filter(s => s === 'online' || s === 'stale').length;
      userRelayCount = onlineCount > 0 ? onlineCount : configuredCount;
      if (userRelayCount > 0) {
        hourly = tps * 3600 * (userRelayCount / totalActiveRelays);
        daily = tps * 86400 * (userRelayCount / totalActiveRelays);
        monthly = daily * 30;
        method = onlineCount > 0 ? 'online-count' : 'configured-count';
      }
    }

    return { ok: true, hourly, daily, monthly, tps, totalActiveRelays, userRelayCount, fingerprintsFound: userFingerprints.size, method };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dashboard:open', async () => {
  await shell.openExternal(ANYONE_DASHBOARD_URL);
  return { ok: true };
});

ipcMain.handle('anyon:contractData', async (_e, walletAddress) => {
  try {
    const wallet = String(walletAddress || '').trim();
    if (!wallet) return { ok: false, error: 'wallet adresi yok' };

    const ETH_RPC = 'https://1rpc.io/eth';
    const TOKEN_CONTRACT = '0xFeAc2Eae96899709a43E252B6B92971D32F9C0F9';
    const STAKING_CONTRACT = '0x0d9a1ca7Bc756AE009672Db626CdE3c9BEF583EF';

    function padAddr(addr) {
      return addr.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
    }

    async function ethCall(to, data) {
      const resp = await fetch(ETH_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      });
      const json = await resp.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    }

    function hexToDec(hex, decimals = 18) {
      if (!hex || hex === '0x') return 0;
      const big = BigInt(hex);
      if (big === 0n) return 0;
      const factor = BigInt(10) ** BigInt(decimals);
      const whole = Number(big / factor);
      const frac = Number((big % factor) * 1000000n / factor) / 1000000;
      return Math.round((whole + frac) * 100) / 100;
    }

    const walletPadded = padAddr(wallet);

    const [balResult, stakedResult] = await Promise.allSettled([
      ethCall(TOKEN_CONTRACT, '0x70a08231' + walletPadded),
      ethCall(STAKING_CONTRACT, '0x79ec5d3a' + walletPadded),
    ]);

    const walletBalance = balResult.status === 'fulfilled' ? hexToDec(balResult.value) : null;
    const staked = stakedResult.status === 'fulfilled' ? hexToDec(stakedResult.value) : null;

    // Each staked relay locks 100 ANYONE; derive locked relay count from staked amount
    const lockedRelays = staked != null ? Math.round(staked / 100) : null;
    const locked = lockedRelays != null ? lockedRelays * 100 : null;

    const cfg = config.load();
    const totalRelays = (cfg.servers || []).length;

    // Active relay count from live monitor state (online relays)
    const activeRelays = Array.from(relayAlertStates.values()).filter(s => s === 'online').length || null;

    // Also try relay-api as fallback for reward/claim fields (may be down)
    const apiMiners = await fetchJson(`https://relay-api.anyone.io/api/miners/${wallet}`).catch(() => null);
    const apiRewards = await fetchJson(`https://relay-api.anyone.io/api/rewards/wallet/${wallet}`).catch(() => null);

    const miners = {
      staked: null,
      // locked = relay operator locking (100 ANYONE per relay), from staking contract selector
      locked: apiMiners && apiMiners.locked != null ? apiMiners.locked : null,
      vaulted: apiMiners && apiMiners.vaulted != null ? apiMiners.vaulted : null,
      walletBalance,
      // stakedContract = raw staking contract value (same as locked for relay operators)
      stakedContract: apiMiners && apiMiners.staked != null ? apiMiners.staked : staked,
      totalRelays: apiMiners && apiMiners.totalRelays != null ? apiMiners.totalRelays : totalRelays,
      activeRelays: apiMiners && apiMiners.activeRelays != null ? apiMiners.activeRelays : activeRelays,
      lockedRelays: apiMiners && apiMiners.lockedRelays != null ? apiMiners.lockedRelays : lockedRelays,
      claimedRelays: apiMiners && apiMiners.claimedRelays != null ? apiMiners.claimedRelays : null,
      hardwareRelays: apiMiners ? (apiMiners.hardwareRelays != null ? apiMiners.hardwareRelays : null) : null,
      claimableRelay: apiMiners && apiMiners.claimableRelay != null ? apiMiners.claimableRelay : null,
      claimableStaking: apiMiners && apiMiners.claimableStaking != null ? apiMiners.claimableStaking : null,
      totalClaimable: apiMiners && apiMiners.totalClaimable != null ? apiMiners.totalClaimable : null,
      totalClaimed: apiMiners && apiMiners.totalClaimed != null ? apiMiners.totalClaimed : null,
    };

    return { ok: true, miners, rewards: apiRewards || {} };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('dashboard:trackerState', async () => ({ ok: true, ...dashboardKeepAliveState }));
ipcMain.handle('dashboard:trackerEnable', async (_e, enabled, reloadMinutes) => {
  return await setDashboardKeepAliveEnabled(enabled, reloadMinutes);
});
ipcMain.handle('dashboard:trackerReload', async () => {
  const result = await reloadDashboardKeepAlive('manual');
  return { ...result, ...dashboardKeepAliveState };
});
ipcMain.handle('dashboard:trackerFingerprints', async (_e, forceRefresh = false) => {
  return await getDashboardTrackerFingerprints(!!forceRefresh);
});
ipcMain.handle('dashboard:trackerSnapshot', async (_e, forceRefreshFingerprints = false) => {
  return await fetchDashboardTrackerSnapshot(!!forceRefreshFingerprints);
});
ipcMain.handle('news:get', async () => {
  return await fetchAnyoneNewsFeed();
});
ipcMain.handle('market:tokenPrice', async () => {
  return await fetchAnyoneTokenPrice();
});
ipcMain.handle('app:info', async () => {
  return {
    version: pkg.version,
    name: pkg.build?.productName || pkg.name || 'Anyone Monitor',
    userDataPath: app.getPath('userData'),
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
ipcMain.handle('external:open', async (_e, url) => {
  const safe = String(url || '').trim();
  if (!/^https?:\/\//i.test(safe)) return { ok: false, error: 'gecersiz url' };
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
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };
  return await monitor.readAnonrc(s);
});
ipcMain.handle('anonrc:write', async (_e, name, content, opts) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };
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
  if (!targets.length) return { ok: false, error: 'server bulunamadi' };
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
// Skips servers listed in the exclude array (e.g. ['baris1']).
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
  if (!servers.length) return { ok: false, error: 'hedef server bulunamadi' };
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
  if (!servers.length) return { ok: false, error: 'hedef server bulunamadi' };

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
  if (!targets.length) return { ok: false, error: 'server bulunamadi' };
  let ip = String(ipOverride || '').trim();
  if (!ip) ip = await getPublicIp();
  if (!ip) return { ok: false, error: 'Public IP algilanamadi. Internet baglantisi kontrol et.' };
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
  if (!targets.length) return { ok: false, error: 'server bulunamadi' };
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
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };
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
ipcMain.handle('network:relayStats', async (_e, fingerprints) => fetchRelayNetworkStats(fingerprints));
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
  cfg.openaiApiKey = s.openaiApiKey || '';
  cfg.claudeApiKey = s.claudeApiKey || '';
  cfg.autoFixCommands = Array.isArray(s.autoFixCommands) ? s.autoFixCommands : [];
  config.save(cfg);
  return true;
});
ipcMain.handle('autofix:test', async (_e, s) => {
  const base = config.load();
  const cfg = {
    ...base,
    ...(s || {}),
    autoFixCommands: Array.isArray(s && s.autoFixCommands) ? s.autoFixCommands : (base.autoFixCommands || []),
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
      return Promise.resolve({ ok: false, error: 'Parola dosyasi yazilamadi: ' + e.message });
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
      return Promise.resolve({ ok: false, error: 'Script dosyasi yazilamadi: ' + e.message });
    }
    const script = `tell application "Terminal"\n  activate\n  do script ${asq('bash ' + shq(tmpFile))}\nend tell`;
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], (err) => {
        if (err) resolve({ ok: false, error: err.message });
        else resolve({ ok: true });
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
        return finish({ ok: false, error: 'Terminal bulunamadi. sudo apt-get install gnome-terminal' });
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

// Open `nyx -s /run/anon/control` on the given server in a new Terminal window.
// We use `osascript` so the user gets a real pty terminal (arrow keys, m/l/c pages all work).
ipcMain.handle('nyx:open', async (_e, name) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };
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
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };
  const remoteCmd = `journalctl -u anon@default -n 50 --no-pager 2>/dev/null || journalctl -u anon -n 50 --no-pager 2>/dev/null || tail -n 50 /var/log/anon/notices.log 2>/dev/null || echo '(log bulunamadi)'; echo; echo '---'; echo 'kapatmak icin herhangi bir tusa bas'; read -n1 -s`;
  return openRemoteTerminal(s, remoteCmd, 'anon log');
});

ipcMain.handle('agent:httpsTest', async (_e, name) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };
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
    if (scheme === 'https') opts.rejectUnauthorized = false;
    const req = mod.request(opts, (res) => {
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
    req.on('error', (e) => resolve({ ok: false, status: 0, text: `HTTPS err: ${e.message}` }));
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
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };

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
  if (monitor) monitor.updateServers(updated);
  return { ok: true, token, port };
});

ipcMain.handle('agent:installAll', async () => {
  const cfg = config.load();
  const servers = cfg.servers || [];
  if (!servers.length) return { ok: false, error: 'kayitli relay yok' };

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
  if (monitor) monitor.updateServers(nextServers);

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
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };

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
  if (monitor) monitor.updateServers(updated);
  return { ok: true };
});

ipcMain.handle('htop:open', async (_e, name) => {
  const cfg = config.load();
  const s = (cfg.servers || []).find(x => x.name === name);
  if (!s) return { ok: false, error: 'server bulunamadi: ' + name };
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
  destroyDashboardKeepAliveWindow();
  try { monitor && monitor.stop(); } catch {}
});
