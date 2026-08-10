// JSON config store plus encrypted sidecar secret vault in the Electron userData dir.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const TOP_LEVEL_SECRET_FIELDS = ['claudeApiKey', 'openaiApiKey'];
const SERVER_SECRET_FIELDS = ['password', 'agentToken'];

const DEFAULTS = {
  pollMs: 120000,
  logLines: 1000,
  defaultNetworkMode: 'direct',
  connectionMode: 'https',
  themeMode: 'dark',
  languageMode: 'en',
  alarmEnabled: true,
  alarmSound: 'Hero',
  alarmRepeatMinutes: 5,
  autoFixEnabled: true,
  aiProvider: 'openai',
  claudeApiKey: '',
  openaiApiKey: '',
  autoFixDryRun: false,
  anyoneClientEnabled: false,
  routeThroughAnyone: false,
  anyoneSocksPort: 19150,
  anyoneControlPort: 19151,
  anyoneOrPort: 0,
  appAuthEnabled: false,
  appAuthUser: '',
  appAuthSalt: '',
  appAuthHash: '',
  dashboardTiles: { uptime: true, pubip: true, anon: true, nic: true, load: true },
  dashboardTileStyle: 'flat',
  zoomFactor: 1,
  firstLaunchAt: 0,
  licensed: false,
  licenseKey: '',
  autoFixCommands: [
    { id: 1, name: 'Restart relay service', command: 'for svc in anon anon@default anyone anyone-relay tor-anon; do systemctl cat "$svc" >/dev/null 2>&1 && systemctl restart "$svc" && echo "restarted: $svc" && break; done' },
    { id: 2, name: 'Check service status', command: 'for svc in anon anon@default anyone anyone-relay tor-anon; do s=$(systemctl is-active "$svc" 2>/dev/null); [ -n "$s" ] && echo "$svc=$s"; done' },
    { id: 3, name: 'Last 50 log lines', command: 'journalctl -u anon -n 50 --no-pager 2>/dev/null || journalctl -u anyone-relay -n 50 --no-pager 2>/dev/null || echo "(log not found)"' },
    { id: 5, name: 'Restart SSH service', command: 'systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null; echo "ssh=$(systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null)"' },
    { id: 12, name: 'Disk usage', command: 'df -h / /var /tmp 2>/dev/null' },
    { id: 13, name: 'RAM and load', command: 'free -m 2>/dev/null || vm_stat; uptime' },
    { id: 16, name: 'Reboot required?', command: '[ -f /var/run/reboot-required ] && cat /var/run/reboot-required || echo "no reboot needed"' },
  ],
  servers: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildDefaults(data = {}) {
  return {
    ...clone(DEFAULTS),
    ...data,
    dashboardTiles: { ...DEFAULTS.dashboardTiles, ...(data.dashboardTiles || {}) },
    autoFixCommands: Array.isArray(data.autoFixCommands) ? data.autoFixCommands : clone(DEFAULTS.autoFixCommands),
    servers: Array.isArray(data.servers) ? data.servers : clone(DEFAULTS.servers),
  };
}

class Config {
  constructor(dir) {
    this.path = path.join(dir, 'anyone-monitor.json');
    this.secretsPath = path.join(dir, 'anyone-monitor.secrets.json');
  }

  load() {
    let data;
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      data = JSON.parse(raw);
    } catch {
      data = clone(DEFAULTS);
    }

    const merged = buildDefaults(data);
    const migrated = this._hydrateSecrets(merged);

    if (!migrated.firstLaunchAt) migrated.firstLaunchAt = Date.now();

    if (!migrated.pollMs || migrated.pollMs < 30000) {
      migrated.pollMs = DEFAULTS.pollMs;
      try { this.save(migrated); } catch {}
    } else if (!fs.existsSync(this.path) || migrated.__secretMigrationApplied || !data.firstLaunchAt) {
      try { this.save(migrated); } catch {}
    }

    delete migrated.__secretMigrationApplied;
    return migrated;
  }

  save(data) {
    const vault = this._readVault();
    const persisted = this._stripSecretsForDisk(buildDefaults(data), vault);
    delete persisted.__secretMigrationApplied;
    this._writeVault(vault);
    this._atomicWrite(this.path, JSON.stringify(persisted, null, 2));
  }

  // Atomik yazma: önce geçici dosyaya yaz, sonra rename (POSIX'te atomik).
  // Yazma yarıda kesilse bile (crash/güç/disk dolması) eski dosya bozulmadan kalır.
  // ÖNCEKİ RİSK: doğrudan writeFileSync -> yarım yazma -> config bozulur -> tüm server'lar kaybolurdu.
  _atomicWrite(targetPath, content, mode) {
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    } catch {}
    const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      if (mode != null) { try { fs.chmodSync(tmp, mode); } catch {} }
      fs.renameSync(tmp, targetPath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  _hydrateSecrets(cfg) {
    const vault = this._readVault();
    let changed = false;

    for (const field of TOP_LEVEL_SECRET_FIELDS) {
      const refKey = `${field}Ref`;
      const plain = String(cfg[field] || '');
      let ref = String(cfg[refKey] || '');
      if (plain && !ref) ref = this._topLevelRef(field);
      if (plain && ref && !vault.items[ref]) {
        vault.items[ref] = this._encryptSecret(plain);
        changed = true;
      }
      const secret = ref && vault.items[ref] ? this._decryptSecret(vault.items[ref]) : plain;
      cfg[field] = secret || '';
      if (ref) cfg[refKey] = ref;
    }

    cfg.servers = (cfg.servers || []).map((server, index) => {
      const next = { ...server };
      for (const field of SERVER_SECRET_FIELDS) {
        const refKey = `${field}Ref`;
        const plain = String(next[field] || '');
        let ref = String(next[refKey] || '');
        if (plain && !ref) ref = this._serverRef(next, field, index);
        if (plain && ref && !vault.items[ref]) {
          vault.items[ref] = this._encryptSecret(plain);
          changed = true;
        }
        const secret = ref && vault.items[ref] ? this._decryptSecret(vault.items[ref]) : plain;
        next[field] = secret || '';
        if (ref) next[refKey] = ref;
      }
      return next;
    });

    if (changed) {
      this._writeVault(vault);
      cfg.__secretMigrationApplied = true;
    }
    return cfg;
  }

  _stripSecretsForDisk(cfg, vault) {
    for (const field of TOP_LEVEL_SECRET_FIELDS) {
      const refKey = `${field}Ref`;
      const value = String(cfg[field] || '');
      const currentRef = String(cfg[refKey] || this._topLevelRef(field));
      if (value) {
        vault.items[currentRef] = this._encryptSecret(value);
        cfg[refKey] = currentRef;
      } else {
        delete vault.items[currentRef];
        delete cfg[refKey];
      }
      cfg[field] = '';
    }

    cfg.servers = (cfg.servers || []).map((server, index) => {
      const next = { ...server };
      for (const field of SERVER_SECRET_FIELDS) {
        const refKey = `${field}Ref`;
        const value = String(next[field] || '');
        const currentRef = String(next[refKey] || this._serverRef(next, field, index));
        if (value) {
          vault.items[currentRef] = this._encryptSecret(value);
          next[refKey] = currentRef;
        } else {
          delete vault.items[currentRef];
          delete next[refKey];
        }
        next[field] = '';
      }
      return next;
    });

    return cfg;
  }

  _topLevelRef(field) {
    return `app:${field}`;
  }

  _serverRef(server, field, index) {
    const name = String(server && server.name || '').trim() || `row-${index}`;
    return `server:${name}:${field}`;
  }

  _readVault() {
    try {
      const raw = fs.readFileSync(this.secretsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') return parsed;
    } catch {}
    return { version: 1, items: {} };
  }

  _writeVault(vault) {
    this._atomicWrite(this.secretsPath, JSON.stringify(vault, null, 2), 0o600);
  }

  _encryptSecret(value) {
    const plain = String(value || '');
    if (!plain) return '';
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return `safe:${safeStorage.encryptString(plain).toString('base64')}`;
      }
    } catch {}
    return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`;
  }

  _decryptSecret(payload) {
    const raw = String(payload || '');
    if (!raw) return '';
    try {
      if (raw.startsWith('safe:')) {
        return safeStorage.decryptString(Buffer.from(raw.slice(5), 'base64'));
      }
      if (raw.startsWith('plain:')) {
        return Buffer.from(raw.slice(6), 'base64').toString('utf8');
      }
    } catch {}
    return '';
  }
}

module.exports = Config;
