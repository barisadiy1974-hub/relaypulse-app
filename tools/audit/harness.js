// Izole denetim kosumu: gercek main.js + src/*.js yuklenir, electron sahtelenir.
// Hicbir SSH baglantisi kurulmaz, hicbir dosya silinmez, kullanici config'i yazilmaz.
const path = require('path'), fs = require('fs'), os = require('os');
// Depo koku: tools/audit/ -> ../..  (CI'da da, elde de ayni)
const ROOT = process.argv[2] || path.resolve(__dirname, '..', '..');

const captured = { handlers: {}, windows: [], shellOpens: [], notifications: [] };
const noop = () => {};
function fnProxy(name) {
  return new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : fnProxy(name + '.' + String(p))),
    apply: () => fnProxy(name + '()'),
    construct: () => new Proxy({}, { get: (t, p) => (p === 'then' ? undefined : fnProxy(name + '#' + String(p))) }),
  });
}
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-audit-'));
// Electron'un app'inde sahtelenmemis bir metoda dokunulursa ne yapmali?
// Bu bir UYGULAMA hatasi degil, KOSUM eksigidir: main.js:106 gibi platforma ozel
// cagrilar (app.disableHardwareAcceleration, sadece linux) macOS'ta hic
// calismadigi icin yerelde yesil, Ubuntu runner'da patlak veriyordu. Bilinmeyen
// anahtar sessizce no-op doner ve kaydedilir; check.js sonunda listeler, boylece
// eksik sessiz kalmaz.
const stubGaps = new Set();
function tolerant(obj, label) {
  return new Proxy(obj, {
    get(t, k) {
      if (k in t) return t[k];
      // 'then' no-op donerse nesne thenable sanilir ve await'ler kirilir.
      if (typeof k !== 'string' || k === 'then') return undefined;
      stubGaps.add(`${label}.${k}`);
      return () => {};
    },
  });
}
const electronStub = {
  app: {
    getPath: (k) => (k === 'userData' ? tmpUserData : os.tmpdir()),
    getVersion: () => require(path.join(ROOT, 'package.json')).version, getName: () => 'RelayPulse', getLocale: () => 'en-US',
    whenReady: () => new Promise(() => {}), on: noop, once: noop, quit: noop,
    isPackaged: false, setLoginItemSettings: noop, getLoginItemSettings: () => ({}),
    requestSingleInstanceLock: () => true, relaunch: noop, exit: noop, dock: { setBadge: noop, setIcon: noop },
    setAboutPanelOptions: noop, commandLine: { appendSwitch: noop },
  },
  __wrapApp: true,
  BrowserWindow: class { constructor(o) { captured.windows.push(o || {}); this.webContents = { send: noop, on: noop, once: noop, setWindowOpenHandler: noop, session: { setCertificateVerifyProc: noop, webRequest: { onBeforeRequest: noop } }, openDevTools: noop, executeJavaScript: async () => {} }; }
    static getAllWindows() { return []; } loadFile() {} loadURL() {} on() {} once() {} show() {} hide() {} focus() {} isDestroyed() { return false; } setMenu() {} },
  ipcMain: { handle: (ch, fn) => { captured.handlers[ch] = fn; }, on: noop, removeHandler: noop },
  shell: { openExternal: async (u) => { captured.shellOpens.push(u); return true; }, showItemInFolder: noop, openPath: async () => '' },
  dialog: { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  Notification: class { constructor(o) { captured.notifications.push(o); } show() {} static isSupported() { return true; } },
  Menu: { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop },
  Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} setImage() {} destroy() {} },
  nativeImage: { createFromPath: () => ({ resize: () => ({}), isEmpty: () => true }), createEmpty: () => ({}) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => String(b).replace(/^enc:/, '') },
  powerMonitor: { on: noop }, screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
  systemPreferences: { getMediaAccessStatus: () => 'granted' }, session: { defaultSession: { setCertificateVerifyProc: noop } },
};
const Module = require('module'); const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return electronStub;
  // ssh2 tek harici bagimlilik. Sahtelenince kosum node_modules'suz calisir
  // (CI'da npm ci yok) ve bir kontrol yanlislikla GERCEK baglanti kurmaya
  // kalkarsa sessizce gecmek yerine yuksek sesle patlar.
  if (req === 'ssh2') {
    return { Client: class { constructor() { throw new Error('denetim kosumu SSH acmaz'); } } };
  }
  return origLoad.apply(this, arguments);
};
delete electronStub.__wrapApp;
electronStub.app = tolerant(electronStub.app, 'app');
module.exports = { ROOT, captured, tmpUserData, electronStub, stubGaps, load: (rel) => require(path.join(ROOT, rel)) };
