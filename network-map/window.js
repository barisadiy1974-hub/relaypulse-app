/**
 * network-map/window.js — main process.
 *
 * Opens the network concentration map in its own window, on demand.
 * Wire it up once in your main process:
 *
 *     const networkMap = require('./network-map/window');
 *     networkMap.register();                     // IPC handlers, call once at startup
 *     // ...and from wherever the Settings button lives:
 *     ipcMain.on('open-network-map', () => networkMap.open({ parent: mainWindow, fleet }));
 *
 * The window is a singleton: clicking the button twice focuses the existing one
 * instead of opening a second copy.
 */

'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const https = require('https');

const ALLOWED_HOSTS = new Set(['api.ec.anyone.tech', 'api-stage.ec.anyone.tech']);
const DEFAULT_BASE = 'https://api.ec.anyone.tech';

let win = null;
let registered = false;
// Control Room raili "Reports / AI Hub / Settings" icin ana pencereyi one getirir.
// Bu pencere read-only oldugundan o bolumler burada yok; ana penceredeki gercek
// ekranlara yonlendirilir (once sadece "burada yok" uyarisi veriyorlardi).
let parentWin = null;

// Some networks get a blanket 404 from the primary host — the stage host serves the
// same data and is used as an automatic fallback. Whichever answers first is kept.
const BASES = [DEFAULT_BASE, 'https://api-stage.ec.anyone.tech'];
let activeBase = null;
let noticeSent = false;

/**
 * Fetch a path, trying the known hosts in order until one answers.
 * Remembers the host that worked so later calls go straight there.
 */
async function fetchJsonAny(rawPath) {
  const order = activeBase ? [activeBase, ...BASES.filter(b => b !== activeBase)] : BASES;
  let lastErr;

  for (const base of order) {
    try {
      const data = await fetchJson(rawPath, base);
      if (activeBase !== base) {
        activeBase = base;
        console.log('[network-map] using', base);
        if (base !== DEFAULT_BASE && !noticeSent) {
          noticeSent = true;
          if (win && !win.isDestroyed()) {
            win.webContents.send(
              'network-map:notice',
              'The primary Anyone endpoint is not answering from this network — showing data from the stage endpoint instead.'
            );
          }
        }
      }
      return data;
    } catch (e) {
      lastErr = e;
      console.warn('[network-map]', base + rawPath, 'failed:', e && e.message);
    }
  }
  throw lastErr || new Error('All endpoints failed for ' + rawPath);
}

/** Fetch from the main process — no CORS, and the renderer never gets network access. */
async function fetchJson(rawPath, base = DEFAULT_BASE) {
  const url = new URL(rawPath, base);

  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`Blocked request to ${url.hostname}`);
  }

  const headers = { accept: 'application/json' };

  // net.fetch needs Electron 22+; fall back to https for older runtimes.
  if (net && typeof net.fetch === 'function') {
    const res = await net.fetch(url.toString(), { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.pathname}`);
    return res.json();
  }

  return new Promise((resolve, reject) => {
    const req = https.get(url.toString(), { headers, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url.pathname}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

/** Install the IPC handler. Safe to call more than once. */
function register() {
  if (registered) return;
  registered = true;

  ipcMain.handle('network-map:fetch', async (_event, requestedPath) => {
    if (typeof requestedPath !== 'string' || !requestedPath.startsWith('/')) {
      throw new Error('Invalid path');
    }
    return fetchJsonAny(requestedPath);
  });

  // Ana pencereyi one getir ve istenen ekrani ac. Yalnizca bilinen hedefler
  // kabul edilir — sayfa rastgele bir kanal/sekme adi gonderemez.
  const ALLOWED_TARGETS = new Set(['rewards', 'settings', 'ai']);
  ipcMain.handle('network-map:focus-main', (_event, target) => {
    if (!ALLOWED_TARGETS.has(target)) return { ok: false, error: 'unknown target' };
    if (!parentWin || parentWin.isDestroyed()) return { ok: false, error: 'main window unavailable' };
    try {
      if (parentWin.isMinimized()) parentWin.restore();
      parentWin.show();
      parentWin.focus();
      parentWin.webContents.send('focus-tab', target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
  });
}

/**
 * @param {object}   [opts]
 * @param {BrowserWindow} [opts.parent]
 * @param {Array<{label?: string, lat: number, lon: number}>} [opts.fleet]
 *        The operator's own relay coordinates — marked on the map automatically.
 */
function open({ parent = null, fleet = [] } = {}) {
  register();
  if (parent && !parent.isDestroyed()) parentWin = parent;
  console.log('[network-map] open() called, fleet:', (fleet || []).length);

  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    if (fleet.length) win.webContents.send('network-map:fleet', fleet);
    return win;
  }

  // Deliberately NOT a child window: as a child of the main window it can inherit
  // hidden/minimised state and never appear. Independent top-level window instead.
  win = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    title: 'Network Geographic Concentration',
    backgroundColor: '#0b0d10',
    show: true,            // shown immediately — never wait on ready-to-show
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);

  win.loadFile(path.join(__dirname, 'index.html')).catch((e) => {
    console.error('[network-map] loadFile failed:', e && e.message);
  });

  win.once('ready-to-show', () => { try { win.show(); win.focus(); } catch {} });

  // Last-resort: if anything above went quiet, force it visible.
  setTimeout(() => {
    try {
      if (win && !win.isDestroyed() && !win.isVisible()) { win.show(); win.focus(); }
    } catch {}
  }, 1200);

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[network-map] page failed to load:', code, desc);
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    console.error('[network-map] preload error in', file, err && err.message);
  });

  win.webContents.on('did-finish-load', () => {
    if (fleet.length) win.webContents.send('network-map:fleet', fleet);
  });

  // Any link in the page opens in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });

  return win;
}

function close() {
  if (win && !win.isDestroyed()) win.close();
}

module.exports = { register, open, close, fetchJson, fetchJsonAny };
