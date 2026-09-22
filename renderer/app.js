// Renderer: render server cards, sparkline charts, logs, settings.
// No framework — small enough to stay plain.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const HISTORY = 40; // points per sparkline (~6 min @ 10s poll)
const snaps = new Map(); // name -> { last, lastOk, rxHist, txHist }
let servers = [];
let settings = { pollMs: 10000, logLines: 200, themeMode: 'light', languageMode: 'en', alarmEnabled: true, alarmSound: 'Hero', alarmRepeatMinutes: 5, ramWarnPct: 90, dashboardTiles: { uptime: true, pubip: true, anon: true, nic: true, load: true }, dashboardTileStyle: 'vivid' };
let autoFixSettings = { autoFixEnabled: false, aiProvider: 'openai', openaiApiKey: '', autoFixCommands: [] };
let networkStatsTimer = null;
let autoFixLogLines = [];
let embeddedTerminal = null;
let embeddedTerminalFit = null;
let embeddedTerminalSessionId = '';
const relayFingerprintCache = new Map(); // server name -> fingerprint
const relayStateEvents = []; // recent snapshot transitions for the 1h summary
let networkStatsData = null;
let myTotalBwMbps = 0;
let windowVisible = !document.hidden;
let pendingCardUpdates = new Set();
let aggregateDirty = false;
let dashboardFilters = { query: '', state: 'all', anon: 'all' };
let fleetReferenceRenderQueued = false;
const I18N = {
  en: {
    app_name: 'RelayPulse',
    nav_dashboard: 'Relays',
    nav_config: 'Tools',
    nav_settings: 'Settings',
    system_online: 'System: Online',
    refresh_now: 'Refresh Now',
    open_config: 'Relay Config',
    search_placeholder: 'Search relays...',
    filter_all: 'All',
    filter_online: 'Online',
    filter_warn: 'Warning',
    filter_offline: 'Offline',
    anon_all: 'Service: All',
    anon_ok: 'Service: OK',
    anon_down: 'Service: Down',
    summary_total: 'Total',
    summary_online: 'Online',
    summary_warn: 'Warning',
    summary_offline: 'Offline',
    ai_log_empty: 'AI log: none yet',
    head_status: 'Status',
    head_relay: 'Relay Name',
    head_band: 'Bandwidth (RX / TX)',
    head_fingerprint: 'Fingerprint',
    server: 'Server',
    fleet_fingerprints: 'Fleet Fingerprints',
    defaults: 'Defaults',
    language: 'Language',
    polling: 'Polling',
    alarm: 'Alarm',
    subtab_servers: 'Relay Connections',
    subtab_general: 'General',
    subtab_monitoring: 'Monitoring',
    subtab_security: 'Security',
    subtab_aifix: 'AI Auto-Fix',
    subtab_about: 'About',
    zoom_title: 'View / Zoom',
    zoom_reset: 'Reset',
    test_title: 'Connection Test',
    ai_title: 'AI Auto-Fix',
    ai_enabled: 'Auto-Fix enabled',
    ai_dryrun: 'Dry-run mode',
    ai_provider: 'AI Provider',
    ai_cmds_title: 'Commands (editable)',
    theme_light: '☀︎ Light',
    theme_dark: '☾ Dark',
    theme_title_light: 'Theme: Light',
    theme_title_dark: 'Theme: Dark',
    network_label: 'Network',
    mode_anyone: 'Anyone',
    mode_direct: 'Direct',
    autofix_label: 'Auto-Fix',
    autofix_on: 'On',
    autofix_off: 'Off',
    dry_run: 'Dry-run',
    dry_run_title: 'Do not execute commands; only preview them.',
    autofix_title: 'Auto-fix runs real commands.',
    last_hour: 'Last 1h',
    last_hour_empty: 'Last 1h: no state changes',
    chip_ok: 'OK',
    chip_offline: 'Offline',
    chip_stale: 'Stale',
    chip_low_bw: 'Low BW',
    chip_api_red: 'API red',
    chip_dashboard_red: 'Dash red',
    chip_ssh: 'SSH',
    chip_anon: 'Service',
    chip_dashboard_down: 'Dashboard ↓',
    chip_offline_title: 'SSH/relay offline',
    chip_stale_title: 'Transient failure, last good data shown',
    chip_lowram: 'Low RAM',
    state_online: 'Online',
    state_stale: 'Warning',
    state_offline: 'Offline',
    last_seen: 'Last seen',
    claim_unknown: 'unknown',
    claim_yes: 'claimed',
    claim_no: 'unclaimed',
  },
};

function t(key) {
  return I18N.en[key] || key;
}

function getDisplaySnapshot(name) {
  const st = snaps.get(name) || {};
  return st.last || st.lastOk || null;
}

function getRelayState(name) {
  const snap = getDisplaySnapshot(name);
  return getEffectiveRelayState(snap);
}

function isAnonActive(snap) {
  return !!(snap && snap.anon && (snap.anon.active || '').includes('active') && !(snap.anon.active || '').includes('inactive'));
}

function hasRelayServiceWarning(snap) {
  if (!snap || !snap.ok) return false;
  // 'unknown' = bu poll'da servis durumu okunamadı (eksik SSH/agent çıktısı).
  // "kapalı" değil — uyarı gösterme, son bilinen duruma güven.
  const anonState = snap.anon && (snap.anon.active || '');
  const anonKnown = !!(snap.anon && Object.prototype.hasOwnProperty.call(snap.anon, 'active')) && anonState !== 'unknown';
  const anonDown = anonKnown && !isAnonActive(snap);
  const dashboardDown = !!(snap.flags && snap.flags.running === false);
  return anonDown || dashboardDown || String(snap.issueKind || '').toLowerCase() === 'anon';
}

function hasDashboardDown(snap) {
  // dashboard.anyone.io relay'i running=false bildiriyor — SSH OK ama ağda görünmüyor.
  return !!(snap && snap.ok && snap.flags && snap.flags.running === false);
}

function getEffectiveRelayState(snap) {
  if (!snap) return 'offline';
  const state = snap.state || (snap.ok ? 'online' : 'offline');
  if (state === 'online' && hasRelayServiceWarning(snap)) return 'stale';
  if (state === 'online' && hasDashboardDown(snap)) return 'stale';
  return state;
}

function shortFingerprint(fp) {
  const clean = String(fp || '').trim();
  if (!clean) return '—';
  if (clean.length <= 20) return clean;
  return `${clean.slice(0, 4)} ${clean.slice(4, 8)} ${clean.slice(8, 12)} … ${clean.slice(-12, -8)} ${clean.slice(-8, -4)} ${clean.slice(-4)}`;
}

function setMiniBar(card, selector, pct) {
  const bar = card.querySelector(selector);
  if (!bar) return;
  const n = Math.max(0, Math.min(100, Number(pct || 0)));
  bar.classList.remove('warn', 'err');
  if (n >= 85) bar.classList.add('err');
  else if (n >= 65) bar.classList.add('warn');
  const fill = bar.querySelector('span');
  if (fill) fill.style.width = `${n}%`;
}

// Sayıyı eski değerinden yenisine yumuşakça sayarak günceller (yüzde metrikleri için).
function animatePct(el, to) {
  if (!el) return;
  const target = Math.max(0, Math.min(100, Math.round(Number(to) || 0)));
  const prev = parseInt(el.textContent, 10);
  const from = Number.isFinite(prev) ? prev : target;
  if (from === target || Math.abs(target - from) < 2 ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    el.textContent = `${target}%`; return;
  }
  const t0 = performance.now(), dur = 500, token = (el._animTok = (el._animTok || 0) + 1);
  const step = (t) => {
    if (el._animTok !== token) return;
    let k = Math.min(1, (t - t0) / dur); k = 1 - Math.pow(1 - k, 3);
    el.textContent = `${Math.round(from + (target - from) * k)}%`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.body.dataset.theme = next;
  settings.themeMode = next;
  const btn = $('#themeToggleBtn');
  if (btn) {
    btn.textContent = next === 'dark' ? t('theme_dark') : t('theme_light');
    btn.title = next === 'dark' ? t('theme_title_dark') : t('theme_title_light');
  }
  const sel = $('#themeModeSelect');
  if (sel && sel.value !== next) sel.value = next;
}

async function toggleTheme() {
  const next = settings.themeMode === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { await window.api.saveSettings({ ...settings, themeMode: next }); } catch {}
}

function refreshHeaderBadges() {
  const networkBadge = $('#networkModeBadge');
  if (networkBadge) {
    const mode = settings.defaultNetworkMode === 'direct' ? t('mode_direct') : t('mode_anyone');
    networkBadge.textContent = `${t('network_label')}: ${mode}`;
  }
  const languageBadge = $('#languageModeBadge');
  if (languageBadge) {
    languageBadge.textContent = 'EN';
    languageBadge.title = 'English';
  }
  const autoFixBadge = $('#autoFixModeBadge');
  if (autoFixBadge) {
    const mode = autoFixSettings.autoFixEnabled ? t('autofix_on') : t('autofix_off');
    autoFixBadge.textContent = `${t('autofix_label')}: ${mode}${autoFixSettings.autoFixDryRun ? ` · ${t('dry_run')}` : ''}`;
    autoFixBadge.title = autoFixSettings.autoFixDryRun ? t('dry_run_title') : t('autofix_title');
  }
}

// Modul seviyesinde: renderSettingsFeatureCards() de bunu cagiriyor ama tanim
// applyLanguage()'in ICINDE yereldi. Sonuc: renderSettings() -> ReferenceError
// -> init() satir 774'te KESILIYOR ve arkasindaki her sey (ANYONE fiyat rozeti,
// tokenPriceTimer ...) hic calismiyordu.
function setText(sel, value) {
  const el = $(sel);
  if (el) el.textContent = value;
}

function applyLanguage(lang) {
  settings.languageMode = 'en';
  document.documentElement.lang = settings.languageMode;
  setText('#brandTitle', t('app_name'));
  setText('#sidebarBrandTitle', t('app_name'));
  setText('#navDashboard', t('nav_dashboard'));
  setText('#navConfig', t('nav_config'));
  setText('#navSettings', t('nav_settings'));
  setText('#sidebarSystemStatus', t('system_online'));
  setText('#dashboardRefreshBtn', t('refresh_now'));
  setText('#navOpenConfig', t('open_config'));
  const relaySearch = $('#relaySearch');
  if (relaySearch) relaySearch.placeholder = t('search_placeholder');
  const stateSel = $('#relayStateFilter');
  if (stateSel) {
    const labels = { all: t('filter_all'), online: t('filter_online'), stale: t('filter_warn'), offline: t('filter_offline') };
    Array.from(stateSel.options).forEach((opt) => { opt.textContent = labels[opt.value] || opt.textContent; });
  }
  const anonSel = $('#relayAnonFilter');
  if (anonSel) {
    const labels = { all: t('anon_all'), active: t('anon_ok'), inactive: t('anon_down') };
    Array.from(anonSel.options).forEach((opt) => { opt.textContent = labels[opt.value] || opt.textContent; });
  }
  setText('.summary-item span', t('summary_total'));
  setText('#summaryOnlineLabel', t('summary_online'));
  setText('#summaryWarnLabel', t('summary_warn'));
  setText('#summaryOfflineLabel', t('summary_offline'));
  const aiLog = $('#dashboardAutoFixLastLog');
  if (aiLog && aiLog.classList.contains('empty')) aiLog.textContent = t('ai_log_empty');
  setText('#headStatus', t('head_status'));
  setText('#headRelayName', t('head_relay'));
  setText('#headBand', t('head_band'));
  setText('#headFingerprint', t('head_fingerprint'));
  setText('#fleetFingerprintsTitle', t('fleet_fingerprints'));
  setText('#settingsDefaultsTitle', t('defaults'));
  setText('#languageModeLabel', t('language'));
  setText('#themeModeLabel', 'Theme');
  setText('#zoomRowLabel', 'Zoom level');
  setText('#settingsPollingTitle', t('polling'));
  {
    const en = true;
    setText('#pollMsLabel', 'Interval (ms)');
    setText('#cfgLogLinesLabel', 'Default log lines');
    setText('#sshRetryLabel', 'Retry count');
    setText('#sshTimeoutLabel', 'Timeout (seconds, 0 = auto)');
    setText('#offlineAfterLabel', 'Heartbeat threshold (missed polls → offline)');
    setText('#monPreviewTitle', 'Live Monitoring Preview');
    setText('#monAdvancedHint', 'Retry: how many times SSH re-tries a connection per poll. Timeout: max seconds for one poll (0 lets RelayPulse pick based on interval). Heartbeat: after this many consecutive failed polls a relay card turns red (before that it stays yellow "stale"). Applied live on Save.');
  }
  {
    setText('#settingsPhoneHint', 'Exports the fleet list (host, agent port, token) as a JSON file for the RelayPulse iPhone app. Send it to your phone with AirDrop, then use "Import" in the app. Re-run whenever agent tokens change.');
    setText('#exportPhoneBtn', 'Export for iPhone…');
  }
  setText('#settingsAlarmTitle', t('alarm'));
  setText('#settingsZoomTitle', t('zoom_title'));
  setText('#settingsTestTitle', t('test_title'));
  setText('#settingsAiTitle', t('ai_title'));
  setText('#autoFixEnabledLabel', t('ai_enabled'));
  setText('#autoFixDryRunLabel', t('ai_dryrun'));
  setText('#autoFixCmdsTitle', t('ai_cmds_title'));
  setText('#subtabServers', t('subtab_servers'));
  setText('#subtabGeneral', t('subtab_general'));
  setText('#subtabMonitoring', t('subtab_monitoring'));
  setText('#subtabSecurity', t('subtab_security'));
  setText('#subtabAifix', t('subtab_aifix'));
  setText('#subtabAbout', t('subtab_about'));
  setText('#zoomReset', t('zoom_reset'));
  setText('#saveSettings', settings.languageMode === 'en' ? 'Save settings' : 'Save settings');
  setText('#saveServers', settings.languageMode === 'en' ? 'Save' : 'Save');
  setText('#addServer', settings.languageMode === 'en' ? '+ Add server' : '+ Add server');
  setText('#fleetFingerprintRefresh', settings.languageMode === 'en' ? 'Refresh All' : 'Refresh All');
  setText('#fleetFingerprintCopy', settings.languageMode === 'en' ? 'Copy All' : 'Copy All');
  setText('#fleetMyFamilyCopy', settings.languageMode === 'en' ? 'Copy MyFamily' : 'Copy MyFamily');
  setText('#fleetMyFamilyPreview', settings.languageMode === 'en' ? 'Preview Family' : 'Preview Family');
  setText('#fleetMyFamilyApply', settings.languageMode === 'en' ? 'Apply Family All' : 'Apply Family All');
  setText('#testAlarmBtn', settings.languageMode === 'en' ? 'Test alarm' : 'Test alarm');
  setText('#testBtn', settings.languageMode === 'en' ? 'Run test' : 'Run test');
  setText('#addAutoFixCmd', '+ Add Command');
  setText('#saveAutoFix', 'Save');
  setText('#testAutoFixBtn', settings.languageMode === 'en' ? 'Test AI' : 'Test AI');
  setText('#quitBtn', 'Quit app');
  if (typeof renderAutoFix === 'function' && $('#incidentPolicy')) renderAutoFix();
  applyTheme(settings.themeMode || 'light');
  refreshHeaderBadges();
  updateNetworkBadge();
  renderCards();
  flushDeferredUiUpdates();
}

function updateSidebarCounts(total, online, warn, offline) {
  const relayCount = $('#sidebarRelayCount');
  if (relayCount) relayCount.textContent = String(total);
}

function applyDashboardFilters() {
  const query = String(dashboardFilters.query || '').trim().toLowerCase();
  const stateFilter = dashboardFilters.state || 'all';
  const anonFilter = dashboardFilters.anon || 'all';
  for (const card of $$('.cockpit-card', $('#cards'))) {
    const name = String(card.dataset.name || '').toLowerCase();
    const snap = getDisplaySnapshot(card.dataset.name);
    const state = getRelayState(card.dataset.name);
    const anon = isAnonActive(snap) ? 'active' : 'inactive';
    const matchesQuery = !query || name.includes(query);
    const matchesState = stateFilter === 'all' || state === stateFilter;
    const matchesAnon = anonFilter === 'all' || anon === anonFilter;
    card.classList.toggle('filtered-out', !(matchesQuery && matchesState && matchesAnon));
  }
}

function fmtTrafficGb(gb) {
  const n = Number(gb || 0);
  if (n >= 1024) return (n / 1024).toFixed(2) + ' TB';
  if (n >= 1) return n.toFixed(2) + ' GB';
  return (n * 1024).toFixed(1) + ' MB';
}

function fmtAnyoneAmount(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  if (v > 0) return v.toFixed(4);
  return '0';
}

function fmtMbpsPair(rx, tx) {
  return `↓ ${(Number(rx) || 0).toFixed(2)} / ↑ ${(Number(tx) || 0).toFixed(2)} Mb/s`;
}

function fmtRamGb(mb) {
  const n = Number(mb || 0);
  if (!Number.isFinite(n) || n <= 0) return '0.0G';
  return (n / 1024).toFixed(1) + 'G';
}

function fmtDiskGb(kb) {
  const n = Number(kb || 0);
  if (!Number.isFinite(n) || n <= 0) return '0.0G';
  return (n / 1024 / 1024).toFixed(1) + 'G';
}

function fmtCpuCount(count) {
  const n = Number(count || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${n} CPU`;
}

function fmtDurationShort(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const min = Math.floor(n / 60000);
  if (min < 1) return '0m';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr ? `${day}d ${remHr}h` : `${day}d`;
}

function fmtSince(ts) {
  const n = Number(ts || 0);
  if (!n) return '—';
  return fmtDurationShort(Date.now() - n) + ' ago';
}

function fmtPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(v >= 99 ? 2 : 1) + '%';
}

function getServerConfig(name) {
  return servers.find((srv) => srv.name === name) || null;
}

function isTextEditable(el) {
  return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
}

function runNativeEdit(action) {
  if (action === 'cut') return window.api.editCut();
  if (action === 'copy') return window.api.editCopy();
  if (action === 'paste') return window.api.editPaste();
  if (action === 'selectAll') return window.api.editSelectAll();
  return Promise.resolve(false);
}

function pushOpsEvent() {}

// Log satirini "[saat] Relay mesaj" seklinde ayristirir ve mesajdan sonucu
// siniflandirir. Duz metin yigini yerine durum renkli satirlar gostermek icin.
function parseAutoFixLine(line) {
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
  const time = m ? m[1] : '';
  let rest = m ? m[2] : line;
  const nameM = /^([A-Za-z][A-Za-z0-9]*)(?::\s*|\s+)/.exec(rest);
  const name = nameM ? nameM[1] : '';
  if (nameM) rest = rest.slice(nameM[0].length);
  let kind = 'info';
  if (/HATA|hata:|basarisiz|failed/i.test(rest)) kind = 'err';
  else if (/atlandi|mudahale etmedi|skipped/i.test(rest)) kind = 'warn';
  else if (/tekrar aktif|\bOK\b|duzeltildi|fixed/i.test(rest)) kind = 'ok';
  else if (/tetiklendi|triggered|hâlâ offline|hala offline/i.test(rest)) kind = 'warn';
  return { time, name, kind, msg: rest || line };
}

function renderAutoFixLogList(el) {
  if (!el) return;
  el.textContent = '';
  for (const raw of autoFixLogLines) {
    const p = parseAutoFixLine(raw);
    const row = document.createElement('div');
    row.className = 'ai-log-row';
    row.title = raw;
    const dot = document.createElement('span');
    dot.className = 'ai-log-dot ' + p.kind;
    const time = document.createElement('span');
    time.className = 'ai-log-time';
    time.textContent = p.time;
    const body = document.createElement('span');
    body.className = 'ai-log-msg';
    if (p.name) {
      const nm = document.createElement('b');
      nm.className = 'ai-log-name';
      nm.textContent = p.name;
      body.appendChild(nm);
      body.appendChild(document.createTextNode(' '));
    }
    body.appendChild(document.createTextNode(p.msg));
    row.append(dot, time, body);
    el.appendChild(row);
  }
}

function appendAutoFixLog(line) {
  if (!line) return;
  autoFixLogLines = [line, ...autoFixLogLines].slice(0, 40);
  const settingsEl = $('#autoFixLog');
  const dashboardEl = $('#dashboardAutoFixLog');
  const indicatorEl = $('#dashboardAutoFixLastLog');
  renderAutoFixLogList(settingsEl);
  renderAutoFixLogList(dashboardEl);
  const panelStatus = $('#aiLogPanelStatus');
  if (panelStatus) panelStatus.textContent = new Date().toLocaleTimeString();
  if (indicatorEl) {
    indicatorEl.classList.remove('empty');
    indicatorEl.textContent = `AI log: ${line}`;
    indicatorEl.title = line;
  }
}

function updateAutoFixDashboard() {
  const indicatorEl = $('#dashboardAutoFixLastLog');
  if (indicatorEl && !autoFixLogLines.length) {
    indicatorEl.classList.add('empty');
    indicatorEl.textContent = t('ai_log_empty');
    indicatorEl.title = t('ai_log_empty');
  }
  const dashboardEl = $('#dashboardAutoFixLog');
  if (dashboardEl && !autoFixLogLines.length) dashboardEl.textContent = t('ai_log_empty');
}

function summarizeRecentStateChanges() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recent = relayStateEvents.filter((e) => e.ts >= cutoff);
  const down = recent.filter((e) => e.to === 'offline').length;
  const warn = recent.filter((e) => e.to === 'stale').length;
  const recov = recent.filter((e) => e.from === 'offline' && e.to === 'online').length;
  const ssh = recent.filter((e) => e.kind === 'ssh').length;
  const anon = recent.filter((e) => e.kind === 'anon').length;
  const text = `${down}↓ ${warn}⚠ ${recov}↺${ssh ? ` ${ssh}s` : ''}${anon ? ` ${anon}a` : ''}`;
  const el = $('#lastHourBadge');
  if (el) {
    el.textContent = `${t('last_hour')}: ${text}`;
    el.title = recent.length
      ? recent.slice(-10).map((e) => `${new Date(e.ts).toLocaleTimeString()} ${e.name} ${e.from || '?'}→${e.to} ${e.kind || ''}`.trim()).join('\n')
      : t('last_hour_empty');
  }
  return text;
}

function openTab(name) {
  const btn = document.querySelector(`.tabs button[data-tab="${cssEscape(name)}"]`);
  if (btn) btn.click();
}

$$('.settings-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.settings-subtab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const pane = btn.dataset.pane;
    $$('.settings-pane').forEach(p => { p.style.display = p.id === pane ? '' : 'none'; });
  });
});

$$('[data-settings-pane]').forEach(btn => {
  btn.addEventListener('click', () => {
    const pane = btn.dataset.settingsPane;
    const tab = document.querySelector(`.settings-subtab[data-pane="${cssEscape(pane)}"]`);
    if (tab) tab.click();
  });
});

function bindDashboardControls() {
  const search = $('#relaySearch');
  if (search) search.addEventListener('input', () => {
    dashboardFilters.query = search.value || '';
    applyDashboardFilters();
  });
  const stateSel = $('#relayStateFilter');
  if (stateSel) stateSel.addEventListener('change', () => {
    dashboardFilters.state = stateSel.value || 'all';
    applyDashboardFilters();
  });
  const anonSel = $('#relayAnonFilter');
  if (anonSel) anonSel.addEventListener('change', () => {
    dashboardFilters.anon = anonSel.value || 'all';
    applyDashboardFilters();
  });
  const themeBtn = $('#themeToggleBtn');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
  const refreshBtn = $('#dashboardRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    renderCards();
    flushDeferredUiUpdates();
    await refreshNetworkStats();
  });
  const openConfigBtn = $('#openConfigBtn');
  if (openConfigBtn) openConfigBtn.addEventListener('click', () => {
    openTab('config');
    const anchor = $('#configServer');
    if (anchor) anchor.scrollIntoView({ block: 'center' });
  });
}

// --- right-click paste/copy on inputs ---
document.addEventListener('contextmenu', (e) => {
  const el = e.target;
  if (!isTextEditable(el)) return;
  e.preventDefault();
  el.focus();
  void window.api.showEditContextMenu();
});

document.addEventListener('keydown', (e) => {
  const el = e.target;
  if (!isTextEditable(el)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return;
  const key = String(e.key || '').toLowerCase();
  if (key === 'a') {
    e.preventDefault();
    void runNativeEdit('selectAll');
    return;
  }
  if (key === 'c') {
    e.preventDefault();
    void runNativeEdit('copy');
    return;
  }
  if (key === 'x') {
    e.preventDefault();
    void runNativeEdit('cut');
    return;
  }
  if (key === 'v') {
    e.preventDefault();
    void runNativeEdit('paste');
  }
}, true);

// --- tab switching ---
let _prevTab = null;
$$('.tabs button').forEach(btn => btn.addEventListener('click', () => {
  const nextTab = btn.dataset.tab;
  if (!nextTab) return; // action buttons in the nav (e.g. Config Dosyasi) are not tabs
  _prevTab = nextTab;
  $$('.tabs button').forEach(b => b.classList.remove('active'));
  $$('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  $('#tab-' + btn.dataset.tab).classList.add('active');
  if (btn.dataset.tab === 'config') {
    // Auto-pick the first server, but do not auto-load over SSH on tab open.
    // Network-bound loads here make the UI feel frozen when a host is slow.
    const cSel = $('#configServer');
    if (cSel && !cSel.value && servers && servers[0]) cSel.value = servers[0].name;
    if (cSel && cSel.value && typeof setConfigStatus === 'function') setConfigStatus('Server selected. Click "Load anonrc" to load it.');
  }
}));

$('#hideBtn').addEventListener('click', () => window.api.hideWindow());

// --- init ---
(async function init() {
  servers = await window.api.getServers();
  settings = await window.api.getSettings();
  autoFixSettings = await window.api.getAutoFixSettings();
  const appInfo = await window.api.getAppInfo();
  applyLanguage(settings.languageMode || 'en');
  applyTheme(settings.themeMode || 'light');
  $('#pollMs').value = settings.pollMs;
  $('#cfgLogLines').value = settings.logLines;
  if ($('#sshRetryCount')) $('#sshRetryCount').value = Math.max(1, Math.min(3, Number(settings.sshRetryCount) || 2));
  if ($('#sshTimeoutSec')) $('#sshTimeoutSec').value = Math.max(0, Math.min(60, Math.round((Number(settings.sshTimeoutMs) || 0) / 1000)));
  if ($('#offlineAfter')) $('#offlineAfter').value = Math.max(1, Math.min(5, Number(settings.offlineAfter) || 3));
  if ($('#watchServices')) $('#watchServices').value = (settings.watchServices || []).join(' ');
  if ($('#watchPorts')) $('#watchPorts').value = (settings.watchPorts || []).join(' ');
  const tiles = settings.dashboardTiles || {};
  $('#tileUptime').checked = tiles.uptime !== false;
  $('#tilePubip').checked = tiles.pubip !== false;
  $('#tileAnon').checked = tiles.anon !== false;
  $('#tileNic').checked = tiles.nic !== false;
  $('#tileLoad').checked = tiles.load !== false;
  $('#tileStyle').value = settings.dashboardTileStyle || 'vivid';
  applyTileVisibility();
  applyTileStyle();
  applyZoom(settings.zoomFactor || 1.0);
  const versionBadge = $('#appVersionBadge');
  if (versionBadge && appInfo && appInfo.version) versionBadge.textContent = `v${appInfo.version}`;
  const sidebarVersion = $('#sidebarVersionLabel');
  if (sidebarVersion && appInfo && appInfo.version) sidebarVersion.textContent = `v${appInfo.version}`;
  renderCards();
  updateAgg();
  renderSettings();
  renderAutoFix();
  bindAutoFixControls();
  renderQuickControls();
  refreshHeaderBadges();
  summarizeRecentStateChanges();
  bindDashboardControls();
  populateLogServerSelect();
  refreshRelayFingerprintCache();
  refreshNetworkStats();
  networkStatsTimer = setInterval(refreshNetworkStats, 60000);

  // Önce kullanıcı bağlantı modunu seçsin, sonra monitoring başlasın.
  // Bir kez "bir daha sorma" dendiyse dialog atlanır — mod Ayarlar > İzleme'den
  // her zaman değiştirilebilir.
  let connModeConfirmed = false;
  try { connModeConfirmed = localStorage.getItem('rp_connModeConfirmed') === '1'; } catch {}
  const chosenMode = connModeConfirmed
    ? (settings.connectionMode || 'https')
    : await showConnectionModeDialog(settings.connectionMode || 'https');
  await window.api.startMonitor(chosenMode);
})();

function showConnectionModeDialog(currentMode) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'connModeOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center';

    const box = document.createElement('div');
    box.style.cssText = 'background:#1a1a2e;border:1px solid #444;border-radius:12px;padding:32px 36px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.6);color:#e8e8f0;font-family:inherit';

    const isEn = settings.languageMode === 'en';
    box.innerHTML = `
      <h2 style="margin:0 0 8px;font-size:18px;color:#e8e8f0">Connection Mode</h2>
      <p style="margin:0 0 20px;font-size:13px;color:#aaa">How should this device connect to relays?</p>
      <label style="display:flex;align-items:flex-start;gap:10px;padding:12px;border:2px solid transparent;border-radius:8px;cursor:pointer;margin-bottom:10px;color:#e8e8f0" id="lbl-https">
        <input type="radio" name="connMode" value="https" style="margin-top:2px" ${currentMode !== 'ssh' ? 'checked' : ''}>
        <span>
          <strong style="color:#e8e8f0">HTTPS Agent</strong><br>
          <span style="font-size:12px;color:#999">Connects via HTTPS if an agent is installed on the server. Fast. Requires a token.</span>
        </span>
      </label>
      <label style="display:flex;align-items:flex-start;gap:10px;padding:12px;border:2px solid transparent;border-radius:8px;cursor:pointer;margin-bottom:24px;color:#e8e8f0" id="lbl-ssh">
        <input type="radio" name="connMode" value="ssh" style="margin-top:2px" ${currentMode === 'ssh' ? 'checked' : ''}>
        <span>
          <strong style="color:#e8e8f0">SSH</strong><br>
          <span style="font-size:12px;color:#999">No token required. Recommended for MacBooks or new devices.</span>
        </span>
      </label>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:12px;color:#9aa;cursor:pointer">
        <input type="checkbox" id="connModeDontAsk" checked style="width:auto">
        <span>Don't ask again (change later in Settings › Monitoring)</span>
      </label>
      <button id="connModeOk" style="width:100%;padding:10px;font-size:14px;font-weight:600;border-radius:8px;border:none;cursor:pointer;background:#7c6af7;color:#fff">Connect</button>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Highlight selected
    const highlight = () => {
      const val = box.querySelector('input[name="connMode"]:checked')?.value;
      box.querySelector('#lbl-https').style.borderColor = val === 'https' ? 'var(--accent,#7c6af7)' : 'transparent';
      box.querySelector('#lbl-ssh').style.borderColor = val === 'ssh' ? 'var(--accent,#7c6af7)' : 'transparent';
    };
    highlight();
    box.querySelectorAll('input[name="connMode"]').forEach(r => r.addEventListener('change', highlight));

    box.querySelector('#connModeOk').addEventListener('click', () => {
      const mode = box.querySelector('input[name="connMode"]:checked')?.value || 'https';
      const dontAsk = box.querySelector('#connModeDontAsk')?.checked;
      try { localStorage.setItem('rp_connModeConfirmed', dontAsk ? '1' : '0'); } catch {}
      overlay.remove();
      settings = { ...settings, connectionMode: mode };
      const cmEl = $('#connectionMode');
      if (cmEl) cmEl.value = mode;
      resolve(mode);
    });
    // Kullanıcı "Bağlan"a tıklayana kadar bekle — monitoring başlamaz.
  });
}

function flushDeferredUiUpdates() {
  // windowVisible kontrolü kaldırıldı — kart güncellemeleri her zaman yapılmalı.
  // Snapshot verisini göstermek kritik; odak kaybı UI'ı dondurmamalı.
  // Her kart ayrı try/catch — bir kartın hatası diğerlerini kilitlemesin.
  for (const name of pendingCardUpdates) {
    try { updateCard(name); }
    catch (e) { console.error('[updateCard error]', name, e && e.message); }
  }
  pendingCardUpdates.clear();
  if (aggregateDirty) {
    try { updateAgg(); } catch (e) { console.error('[updateAgg error]', e && e.message); }
    aggregateDirty = false;
  }
}
// Fallback: windowVisible false kalsa bile 800ms'de bir bekleyen güncellemeleri uygula.
setInterval(() => {
  if (pendingCardUpdates.size > 0 || aggregateDirty) flushDeferredUiUpdates();
}, 800);

document.addEventListener('visibilitychange', () => {
  windowVisible = !document.hidden;
  if (windowVisible) flushDeferredUiUpdates();
});

let scrollPerfTimer = null;
window.addEventListener('scroll', () => {
  document.body.classList.add('scrolling');
  clearTimeout(scrollPerfTimer);
  scrollPerfTimer = setTimeout(() => {
    document.body.classList.remove('scrolling');
    flushDeferredUiUpdates();
  }, 160);
}, { passive: true });

if (window.api.onWindowVisibility) {
  window.api.onWindowVisibility(({ visible }) => {
    windowVisible = !!visible;
    if (windowVisible) flushDeferredUiUpdates();
  });
}

function updateSettingsSnapshot(name) {
  const row = [...$$('#serversTable tbody tr')].find(tr => tr.dataset.serverName === name);
  const snap = snaps.get(name)?.last;
  if (!snap) return;
  const state = getEffectiveRelayState(snap);
  const label = state === 'online' ? 'Online' : state === 'stale' ? 'Warning' : 'Offline';
  if (row) {
    const dot = row.querySelector('.state-dot');
    const status = row.querySelector('.server-state');
    const last = row.querySelector('.server-last-check');
    if (dot) dot.className = `state-dot ${state}`;
    if (status) { status.className = `server-state ${state}`; status.textContent = label; }
    if (last) last.textContent = snap.ts ? fmtSince(snap.ts) : '—';
  }
  if (selectedSettingsServerName !== name) return;
  const pane = $('#selectedRelayDetail');
  const status = pane?.querySelector('.relay-detail-status');
  const dot = pane?.querySelector('.relay-edit-title .state-dot');
  if (status) {
    status.className = `relay-detail-status ${state}`;
    const text = status.querySelector('span');
    const detail = status.querySelector('small');
    if (text) text.textContent = label;
    if (detail) detail.textContent = snap.ts ? 'Last check ' + fmtSince(snap.ts) : 'Awaiting first check';
  }
  if (dot) dot.className = `state-dot ${state}`;
}

window.api.onSnapshot((s) => {
  let st = snaps.get(s.name);
  if (!st) { st = { rxHist: [], txHist: [], totalRxGb: 0, totalTxGb: 0, peakMbps: 0 }; snaps.set(s.name, st); }
  const prevSnap = st.last || null;
  st.last = s;
  if (s.ok) {
    const prevOk = st.lastOk;
    if (prevOk && typeof prevOk.ts === 'number' && typeof s.ts === 'number') {
      const dt = Math.max(0, (s.ts - prevOk.ts) / 1000);
      if (dt > 0) {
        st.totalRxGb = (st.totalRxGb || 0) + ((s.rxMbps || 0) * dt / 8 / 1000);
        st.totalTxGb = (st.totalTxGb || 0) + ((s.txMbps || 0) * dt / 8 / 1000);
      }
    }
    st.peakMbps = Math.max(st.peakMbps || 0, s.rxMbps || 0, s.txMbps || 0);
    // Remember the last good snapshot so stale cards can keep showing data.
    st.lastOk = s;
    st.rxHist.push(s.rxMbps); if (st.rxHist.length > HISTORY) st.rxHist.shift();
    st.txHist.push(s.txMbps); if (st.txHist.length > HISTORY) st.txHist.shift();
  }
  if (!s.ok && s.state === 'offline') {
    pushOpsEvent(`${s.name}: ${s.error || 'host offline'}`);
  }
  const prevState = prevSnap ? getEffectiveRelayState(prevSnap) : null;
  const nextState = getEffectiveRelayState(s);
  if (prevState !== nextState) {
    relayStateEvents.push({
      ts: typeof s.ts === 'number' ? s.ts : Date.now(),
      name: s.name,
      from: prevState || 'unknown',
      to: nextState,
      kind: String(s.issueKind || '').toLowerCase(),
    });
    while (relayStateEvents.length && relayStateEvents[0].ts < Date.now() - 60 * 60 * 1000) relayStateEvents.shift();
    summarizeRecentStateChanges();
  }
  pendingCardUpdates.add(s.name);
  updateSettingsSnapshot(s.name);
  renderMonitoringPreview();
  aggregateDirty = true;
  flushDeferredUiUpdates();
});


// --- cards ---
function renderCards() {
  const grid = $('#cards');
  grid.innerHTML = '';
  grid.classList.add('cockpit-grid');
  for (const srv of servers) {
    const card = document.createElement('div');
    card.className = 'card cockpit-card';
    card.dataset.name = srv.name;
    card.innerHTML = `
      <div class="card-glow"></div>
      <div class="cockpit-head">
        <div class="relay-title-block">
          <div class="status-row">
            <span class="status"></span>
            <span class="state-label">Waiting</span>
          </div>
          <div class="name-row">
            <span class="cname">${escapeHtml(srv.name)}</span>
            <span class="fav-star">★</span>
          </div>
          <div class="subline host-line">Host: ${escapeHtml(srv.host || srv.sshAlias || '—')}</div>
          <div class="subline last-seen">Last seen: —</div>
        </div>
        <div class="health-ring" title="Health">
          <div class="health-num">—</div>
          <div class="health-label">HEALTH</div>
        </div>
      </div>

      <div class="relay-chips"></div>
      <div class="anon-line">anon: <span class="anon-state">?</span></div>

      <div class="cockpit-kpis">
        <div class="kpi kpi-family"><span>Family</span><b class="family-main">—</b></div>
        <div class="kpi kpi-conn"><span>Connection</span><b class="connection-main">—</b></div>
        <div class="kpi kpi-fingerprint"><span>Fingerprint</span><b class="fingerprint-main">—</b><button class="fingerprint-copy" title="Copy fingerprint">⧉</button></div>
      </div>

      <div class="resource-grid">
        <div class="cell metric-stack cpu-box">
          <div class="metric-head"><span>CPU</span><b class="mini-value cpu">—</b></div>
          <div class="mini-bar cpu-bar"><span></span></div>
          <div class="mini-sub cpu-sub">—</div>
        </div>
        <div class="cell metric-stack ram-box">
          <div class="metric-head"><span>RAM</span><b class="mini-value mem">—</b></div>
          <div class="mini-bar mem-bar"><span></span></div>
          <div class="mini-sub mem-sub">—</div>
        </div>
        <div class="cell metric-stack net-box">
          <div class="metric-head"><span>NET</span><b class="mini-value hourly">—</b></div>
          <div class="net-rates"><span class="rval rx">—</span><span class="rval tx">—</span></div>
          <canvas class="sparkline" width="180" height="38"></canvas>
        </div>
      </div>

      <div class="service-grid">
        <div class="service-item"><span>SSH</span><b class="ssh-main">—</b></div>
        <div class="service-item"><span>HTTPS</span><b class="https-main">—</b></div>
        <div class="service-item"><span>Anon</span><b class="anon-main">—</b></div>
        <div class="service-item"><span>Port 9001</span><b class="port-main">—</b></div>
      </div>

      <div class="tile-bar">
        <div class="tile tile-uptime"><div class="tile-label">Uptime</div><div class="tile-value">—</div></div>
        <div class="tile tile-pubip"><div class="tile-label">Public IP</div><div class="tile-value">—</div></div>
        <div class="tile tile-anon"><div class="tile-label">Anon</div><div class="tile-value">—</div></div>
        <div class="tile tile-nic"><div class="tile-label">NIC</div><div class="tile-value">—</div></div>
        <div class="tile tile-load"><div class="tile-label">Load 5/15m</div><div class="tile-value">—</div></div>
        <div class="tile tile-netweight"><div class="tile-label">Net Weight</div><div class="tile-value">—</div></div>
      </div>

      <div class="actions-row">
        <button class="relay-nyx" title="Open Nyx for this relay">▣ Nyx</button>
        <button class="relay-log" title="Open last 50 anon log lines">▤ Log</button>
        <button class="relay-https" title="Test agent HTTPS status">▣ HTTPS</button>
        <button class="relay-ai-log" title="Open AI Auto-Fix log / anon log">AI Log</button>
        <button class="relay-setup-check" title="Run setup health check">🔍 Check</button>
      </div>

      <div class="hidden-compat">
        <div class="cell status-cell"></div>
        <div class="cell relay-cell"></div>
        <div class="cell band-cell"></div>
        <div class="cell metric-slim"><div class="mini-value conn">—</div><div class="mini-value load">—</div></div>
        <div class="cell fingerprint-cell"></div>
        <div class="mini-value disk">—</div><div class="mini-bar disk-bar"><span></span></div><div class="mini-sub disk-sub">—</div>
      </div>
      <div class="err"></div>
    `;
    const copyBtn = card.querySelector('.fingerprint-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const fp = String(copyBtn.dataset.fp || '').trim();
        if (!fp) return;
        try {
          await window.api.clipboardWriteText(fp);
          flash(copyBtn, 'OK');
        } catch {}
      });
    }
    const nyxBtn = card.querySelector('.relay-nyx');
    if (nyxBtn) {
      nyxBtn.addEventListener('click', async () => {
        nyxBtn.disabled = true;
        try {
          const r = await window.api.openNyx(srv.name);
          if (r && r.embedded) {
            const terminalTab = [...document.querySelectorAll('.tabs button')].find((btn) => btn.dataset.tab === 'terminal');
            if (terminalTab) terminalTab.click();
            const embedded = await openEmbeddedTerminal(srv.name, 'nyx');
            if (!embedded || !embedded.ok) throw new Error(embedded && embedded.error || 'Could not open Nyx');
          }
          if (!r.ok) throw new Error(r.error || 'Could not open Nyx');
          flash(nyxBtn, 'OK');
        } catch {
          flash(nyxBtn, 'ERR');
        } finally {
          nyxBtn.disabled = false;
        }
      });
    }
    const logBtn = card.querySelector('.relay-log');
    const openLog = async (btn) => {
      btn.disabled = true;
      try {
        const r = await window.api.openAnonLog(srv.name);
        if (!r.ok) throw new Error(r.error || 'Could not open log');
        flash(btn, 'OK');
      } catch {
        flash(btn, 'ERR');
      } finally {
        btn.disabled = false;
      }
    };
    if (logBtn) logBtn.addEventListener('click', () => openLog(logBtn));
    const aiLogBtn = card.querySelector('.relay-ai-log');
    if (aiLogBtn) aiLogBtn.addEventListener('click', () => openLog(aiLogBtn));
    const httpsBtn = card.querySelector('.relay-https');
    if (httpsBtn) {
      httpsBtn.addEventListener('click', async () => {
        httpsBtn.disabled = true;
        try {
          httpsBtn.textContent = '...';
          let r = await window.api.testAgentHttps(srv.name);
          if (!r || !r.ok) {
            flash(httpsBtn, settings.languageMode === 'en' ? 'INSTALL' : 'KUR');
            const install = await window.api.installAgent(srv.name);
            if (!install || !install.ok) throw new Error((install && install.error) || 'Could not install HTTPS agent');
            const refreshed = await window.api.getServers();
            if (Array.isArray(refreshed)) servers = refreshed;
            r = await window.api.testAgentHttps(srv.name);
          }
          flash(httpsBtn, r && r.text ? r.text : (r && r.ok ? 'OK' : 'ERR'));
        } catch {
          flash(httpsBtn, 'ERR');
        } finally {
          httpsBtn.disabled = false;
          if (httpsBtn.textContent === '...' || httpsBtn.textContent === 'OK' || httpsBtn.textContent === 'ERR' || httpsBtn.textContent === 'KUR') {
            setTimeout(() => { httpsBtn.textContent = '▣ HTTPS'; }, 900);
          }
        }
      });
    }

    const setupCheckBtn = card.querySelector('.relay-setup-check');
    if (setupCheckBtn) {
      setupCheckBtn.addEventListener('click', async () => {
        showSetupCheckModal(srv.name, null); // spinner göster
        try {
          const result = await window.api.setupCheck(srv.name);
          showSetupCheckModal(srv.name, result);
        } catch (e) {
          showSetupCheckModal(srv.name, { ok: false, error: String(e && e.message || e) });
        }
      });
    }
    grid.appendChild(card);
  }
  applyDashboardFilters();
}
function updateCard(name) {
  const card = document.querySelector(`.card[data-name="${cssEscape(name)}"]`);
  if (!card) return;
  const st = snaps.get(name);
  if (!st || !st.last) return;
  const s = st.last;
  const display = st.lastOk || s;
  const status = card.querySelector('.status');
  const errEl = card.querySelector('.err');
  const badge = card.querySelector('.anon-badge');
  const stateLabel = card.querySelector('.state-label');
  const anonState = card.querySelector('.anon-state');

  // Three visual states:
  //   online  — fresh successful poll → green dot, live data
  //   stale   — 1-2 failed polls but had a recent good one → yellow dot,
  //             show the last known data dimmed, no error text (no flap)
  //   offline — 3+ consecutive fails → red dot, show error
  const state = getEffectiveRelayState(s);
  const setMetricText = (sel, value) => {
    const el = card.querySelector(sel);
    if (el) el.textContent = value;
  };
  const setState = (cls, text) => {
    status.className = `status ${cls}`;
    if (stateLabel) {
      stateLabel.className = `state-label ${cls}`;
      stateLabel.textContent = text;
    }
  };
  const seenTs = typeof display.ts === 'number' ? display.ts : 0;
  setMetricText('.last-seen', `${t('last_seen')}: ${seenTs ? fmtSince(seenTs) : '—'}`);
  const chipRow = card.querySelector('.relay-chips');
  const hourAvg = (st.rxHist.length ? st.rxHist.reduce((a, b) => a + b, 0) / st.rxHist.length : 0) +
                  (st.txHist.length ? st.txHist.reduce((a, b) => a + b, 0) / st.txHist.length : 0);
  const issueChips = [];
  if (state === 'offline') issueChips.push({ kind: 'err', text: t('chip_offline'), title: s.error || t('chip_offline_title') });
  else if (state === 'stale') issueChips.push({ kind: 'warn', text: t('chip_stale'), title: s.error || t('chip_stale_title') });
  if (hourAvg > 0 && hourAvg < 11) issueChips.push({ kind: 'warn', text: t('chip_low_bw'), title: `${hourAvg.toFixed(2)} Mb/s < 11 Mb/s` });
  if (String(s.issueKind || '').toLowerCase() === 'ssh') issueChips.push({ kind: 'warn', text: t('chip_ssh'), title: s.error || 'SSH issue' });
  if (hasRelayServiceWarning(s)) issueChips.push({ kind: 'warn', text: t('chip_anon'), title: s.error || 'anon service inactive' });
  if (s && s.ramLow) issueChips.push({ kind: 'warn', text: t('chip_lowram'), title: s.mem ? `RAM ${s.mem.pct}% in use — available is low, freeze/OOM risk` : 'Low RAM' });
  if (hasDashboardDown(s)) issueChips.push({ kind: 'dashboard', text: t('chip_dashboard_down'), title: 'dashboard.anyone.io: relay running=false — SSH OK but not visible on the network' });
  if (state === 'online' && s && s.warnLines && s.warnLines.length) {
    issueChips.push({ kind: 'log-warn', text: `⚠ ${s.warnLines.length} WARN`, title: s.warnLines.join('\n') });
  }
  if (chipRow) {
    chipRow.innerHTML = issueChips.length
      ? issueChips.map((c) => `<span class="relay-chip ${c.kind}" title="${escapeHtml(c.title || c.text)}">${escapeHtml(c.text)}</span>`).join('')
      : `<span class="relay-chip neutral">${escapeHtml(t('chip_ok'))}</span>`;
  }

  const setCockpitHealth = (pct, cls) => {
    const hn = card.querySelector('.health-num');
    const hr = card.querySelector('.health-ring');
    if (hn) hn.textContent = pct;
    if (hr) {
      hr.classList.remove('ok','warn','err');
      if (cls) hr.classList.add(cls);
    }
  };
  const setService = (sel, value, cls) => {
    const el = card.querySelector(sel);
    if (!el) return;
    el.textContent = value;
    el.className = cls || '';
  };
  if (state === 'offline') {
    setCockpitHealth('10%', 'err');
    setService('.ssh-main', 'FAIL', 'err');
    setService('.https-main', '—', 'warn');
    setService('.anon-main', 'Down', 'err');
    setService('.port-main', '—', 'warn');
    setService('.family-main', 'Unknown', 'warn');
    setService('.connection-main', '0 aktif', 'err');
    setState('err', t('state_offline'));
    card.classList.remove('stale', 'online');
    card.classList.add('err-card');
    errEl.textContent = s.error || 'error';
    errEl.title = 'Click to copy full error';
    errEl.onclick = async () => {
      try {
        await window.api.clipboardWriteText(s.error || '');
        errEl.style.outline = '1px solid #34d399';
        setTimeout(() => { errEl.style.outline = ''; }, 600);
      } catch {}
    };
    if (anonState) anonState.textContent = 'down';
    setMetricText('.rx', '—');
    setMetricText('.tx', '—');
    setMetricText('.conn', '—');
    setMetricText('.cpu', '—');
    setMetricText('.cpu-sub', '—');
    setMetricText('.mem', '—');
    setMetricText('.mem-sub', '—');
    setMetricText('.disk', '—');
    setMetricText('.disk-sub', '—');
    setMetricText('.load', '—');
    setMetricText('.hourly', '—');
    setMiniBar(card, '.cpu-bar', 0);
    setMiniBar(card, '.mem-bar', 0);
    setMiniBar(card, '.disk-bar', 0);
    drawSpark(card.querySelector('canvas'), [], []);
    applyDashboardFilters();
    return;
  }

  if (state === 'stale') {
    setCockpitHealth('73%', 'warn');
    setService('.ssh-main', 'STALE', 'warn');
    setState('warn', t('state_stale'));
    card.classList.remove('online', 'err-card');
    card.classList.add('stale');
    errEl.textContent = '';
  } else {
    setCockpitHealth('96%', 'ok');
    setService('.ssh-main', 'OK', 'ok');
    setState('ok', t('state_online'));
    card.classList.remove('stale', 'err-card');
    card.classList.add('online');
    errEl.textContent = '';
  }

  const current = display;
  card.querySelector('.rx').textContent = `↓ ${Number(current.rxMbps || 0).toFixed(2)} Mb/s`;
  card.querySelector('.tx').textContent = `↑ ${Number(current.txMbps || 0).toFixed(2)} Mb/s`;
  const connCount = Number(current.conn);
  const connText = Number.isFinite(connCount) ? `${connCount} active` : '—';
  card.querySelector('.conn').textContent = Number.isFinite(connCount) ? String(connCount) : '—';
  setService('.connection-main', connText, Number.isFinite(connCount) && connCount > 0 ? 'ok' : 'warn');

  const cpuEl = card.querySelector('.cpu');
  const cpuCountText = fmtCpuCount(current.cpuCount);
  animatePct(cpuEl, current.cpuPct);
  cpuEl.className = 'mini-value cpu ' + (current.cpuPct > 80 ? 'err' : current.cpuPct > 50 ? 'warn' : 'ok');
  setMetricText('.cpu-sub', cpuCountText || 'CPU');
  setMiniBar(card, '.cpu-bar', current.cpuPct || 0);

  const memEl = card.querySelector('.mem');
  if (current.mem) animatePct(memEl, current.mem.pct); else memEl.textContent = '—';
  if (current.mem) memEl.className = 'mini-value mem ' + (current.mem.pct > 85 ? 'err' : current.mem.pct > 65 ? 'warn' : 'ok');
  setMetricText('.mem-sub', current.mem ? `${fmtRamGb(current.mem.usedMB)} / ${fmtRamGb(current.mem.totalMB)}` : '—');
  setMiniBar(card, '.mem-bar', current.mem ? current.mem.pct : 0);

  const diskPct = current.disk ? parseInt(current.disk.usedPct) : 0;
  const diskEl = card.querySelector('.disk');
  diskEl.textContent = current.disk ? `${current.disk.usedPct}%` : '—';
  if (current.disk) diskEl.className = 'mini-value disk ' + (diskPct > 85 ? 'err' : diskPct > 70 ? 'warn' : 'ok');
  setMetricText('.disk-sub', current.disk ? `${fmtDiskGb(current.disk.usedKB)} / ${fmtDiskGb(current.disk.totalKB)}` : '—');
  setMiniBar(card, '.disk-bar', diskPct);

  card.querySelector('.load').textContent = (current.load || []).length ? Number(current.load[0] || 0).toFixed(2) : '—';
  const avgRx = st.rxHist.length ? st.rxHist.reduce((a, b) => a + b, 0) / st.rxHist.length : 0;
  const avgTx = st.txHist.length ? st.txHist.reduce((a, b) => a + b, 0) / st.txHist.length : 0;
  const hourlyEl = card.querySelector('.hourly');
  if (hourlyEl) {
    const avgTotal = avgRx + avgTx;
    hourlyEl.textContent = `${avgTotal.toFixed(2)} Mb/s`;
    hourlyEl.className = 'mini-value hourly ' + (avgTotal > 0 ? 'ok' : (state === 'offline' ? 'err' : 'warn'));
    hourlyEl.title = 'Average traffic';
  }

  const anonOkNow = isAnonActive(current);
  // Durum okunamadiysa "Inactive" (kirmizi) yazmak yaniltici — notr goster.
  const anonUnknownNow = ((current.anon && current.anon.active) || '') === 'unknown';
  if (current.anon && anonState) anonState.textContent = anonOkNow ? 'ok' : 'down';
  setService('.https-main', state === 'offline' ? '—' : 'OK', state === 'offline' ? 'warn' : 'ok');
  setService('.anon-main', anonOkNow ? 'Active' : (anonUnknownNow ? '—' : 'Inactive'), anonOkNow ? 'ok' : (anonUnknownNow ? 'warn' : 'err'));
  const hasPort9001 = current.anon && Array.isArray(current.anon.ports) && current.anon.ports.some((p) => String(p).includes('9001'));
  setService('.port-main', hasPort9001 || anonOkNow ? 'Open' : '—', hasPort9001 || anonOkNow ? 'ok' : 'warn');
  setService('.family-main', state === 'offline' ? 'Unknown' : 'OK', state === 'offline' ? 'warn' : 'ok');
  updateCardFlags(name);
  updateCardTiles(card, current, state);
  drawSpark(card.querySelector('canvas'), st.rxHist, st.txHist);
  applyDashboardFilters();
}

function updateCardTiles(card, snap, state) {
  const setTile = (cls, value, sub) => {
    const tile = card.querySelector('.' + cls);
    if (!tile) return;
    const v = tile.querySelector('.tile-value');
    if (v) v.textContent = value || '—';
    if (sub !== undefined) tile.title = sub || '';
  };
  // Uptime — server gives a string like "up 5 days, 21 hours"
  const upRaw = String(snap.uptime || '').replace(/^up\s+/i, '').trim();
  setTile('tile-uptime', shortUptime(upRaw), upRaw);
  // Public IP
  setTile('tile-pubip', snap.publicIp || '—', snap.publicIp || '');
  // Anon service
  const anonOk = isAnonActive(snap);
  const ports = (snap.anon && snap.anon.ports) ? snap.anon.ports.length : 0;
  const anonUnknown = ((snap.anon && snap.anon.active) || '') === 'unknown';
  setTile('tile-anon', anonOk ? `Active${ports ? ' · ' + ports + 'p' : ''}` : (anonUnknown ? '—' : 'Inactive'), JSON.stringify(snap.anon || {}));
  const anonTile = card.querySelector('.tile-anon');
  if (anonTile) anonTile.classList.toggle('bad', !anonOk && !anonUnknown);
  // NIC
  setTile('tile-nic', snap.iface || '—', snap.iface || '');
  // Load 5/15m
  const ld = Array.isArray(snap.load) ? snap.load : [];
  if (ld.length >= 3) setTile('tile-load', `${ld[1].toFixed(2)} / ${ld[2].toFixed(2)}`, `1m: ${ld[0].toFixed(2)}`);
  else setTile('tile-load', '—', '');

  // Uptime streak chip — kesintisiz online gün = ödül tier sinyali
  const streakEl = card.querySelector('.rw-streak');
  if (streakEl) {
    const us = snap.uptimeStats || {};
    const ms = Number(us.streakMs) || 0;
    if (ms > 0 && state !== 'offline') {
      const days = ms / 86400000;
      let mult, cls, next;
      if (days >= 45)      { mult = '5x'; cls = 't4'; next = null; }
      else if (days >= 14) { mult = '3x'; cls = 't3'; next = 45; }
      else if (days >= 3)  { mult = '2x'; cls = 't2'; next = 14; }
      else                 { mult = '1x'; cls = 't1'; next = 3; }
      const isEnStreak = settings.languageMode === 'en';
      const dStr = days >= 1 ? `${Math.floor(days)}${isEnStreak ? 'd' : 'g'}` : `${Math.max(1, Math.floor(ms / 3600000))}${isEnStreak ? 'h' : 's'}`;
      streakEl.textContent = `🔥 ${dStr}`;
      streakEl.className = 'rw-streak show ' + cls;
      streakEl.title = isEnStreak
        ? `Uninterrupted online: ~${days.toFixed(1)} days · estimated multiplier ~${mult}`
          + (next ? ` · next tier at ${next}d (${Math.max(0, next - days).toFixed(1)}d left). One interruption RESETS the streak.`
                  : ' · top tier 🎉')
          + `\n⚠ This value is based on THIS MONITOR's observation (it can't see interruptions while the monitor was off) — not Anyone's official tier. Check the official Anyone dashboard for the official uptime score.`
        : `Continuous online time: ~${days.toFixed(1)} days · estimated multiplier ~${mult}`
          + (next ? ` · next tier at ${next} days (${Math.max(0, next - days).toFixed(1)} days remaining). One outage resets the streak.`
                  : ' · highest tier 🎉')
          + `\n⚠ This value is based on THIS MONITOR's observations (it cannot see outages while the monitor is closed) — it is not Anyone's official tier. See the Anyone dashboard for the official uptime score.`;
    } else {
      streakEl.textContent = '';
      streakEl.className = 'rw-streak';
      streakEl.title = '';
    }
  }
}

function shortUptime(s) {
  if (!s) return '—';
  // "5 days, 21 hours, 3 minutes" -> "5d 21h" (en) / "5g 21s" (tr)
  let days = (s.match(/(\d+)\s*day/i) || [])[1] || 0;
  let hours = (s.match(/(\d+)\s*hour/i) || [])[1] || 0;
  let mins = (s.match(/(\d+)\s*minute/i) || [])[1] || 0;
  days = Number(days); hours = Number(hours); mins = Number(mins);
  const isEn = settings.languageMode === 'en';
  if (isEn) {
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }
  if (days) return `${days}g ${hours}s`;
  if (hours) return `${hours}s ${mins}d`;
  return `${mins}dk`;
}


function drawSpark(cvs, rxH, txH) {
  if (document.body.classList.contains('scrolling')) return;
  const ctx = cvs.getContext('2d');
  const w = cvs.width, h = cvs.height;
  ctx.clearRect(0, 0, w, h);
  const all = rxH.concat(txH);
  const max = Math.max(1, ...all);
  drawSeries(ctx, rxH, max, w, h, getCss('--rx'));
  drawSeries(ctx, txH, max, w, h, getCss('--tx'));
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
}
function drawSeries(ctx, data, max, w, h, color) {
  if (!data.length) return;
  const step = w / Math.max(HISTORY - 1, 1);
  const pts = data.map((v, i) => ({ x: i * step, y: h - (v / max) * (h - 4) - 2 }));
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  if (pts.length > 1) ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(pts[pts.length - 1].x, h);
  ctx.lineTo(pts[0].x, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '44');
  grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad;
  ctx.fill();
}
function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#60a5fa';
}

function updateAgg() {
  let online = 0, warn = 0, offline = 0, rx = 0, tx = 0;
  const warnNames = [], offlineNames = [];
  // Uptime streak agregasyonu — Anyone ödül çarpanı tier'ları (kesinti sıfırlar).
  let streakSum = 0, streakN = 0;
  const tierCount = { '5x': 0, '3x': 0, '2x': 0, '1x': 0 };
  const levelupNames = [];
  const nextTierDays = (d) => d < 3 ? 3 : d < 14 ? 14 : d < 45 ? 45 : null;
  const tierOf = (d) => d >= 45 ? '5x' : d >= 14 ? '3x' : d >= 3 ? '2x' : '1x';
  for (const srv of servers) {
    const st = snaps.get(srv.name);
    const snap = st && st.last;
    const state = getEffectiveRelayState(snap);
    if (state === 'online') {
      online++;
      rx += snap.rxMbps || 0;
      tx += snap.txMbps || 0;
      const d = (Number(snap.uptimeStats && snap.uptimeStats.streakMs) || 0) / 86400000;
      streakSum += d; streakN++;
      tierCount[tierOf(d)]++;
      const nt = nextTierDays(d);
      // Sadece anlamlı streak biriktirmiş (>=1g) ve bir üst tier'a <=3g kalanlar — yeni/sıfırlanmış relay gürültüsü değil.
      if (nt && d >= 1 && (nt - d) <= 3) levelupNames.push(settings.languageMode === 'en'
        ? `${srv.name} — ${d.toFixed(1)}d → ${(nt - d).toFixed(1)}d left to the ${nt}d tier`
        : `${srv.name} — ${d.toFixed(1)} days → ${(nt - d).toFixed(1)} days until the ${nt}-day tier`);
    } else if (state === 'stale') {
      warn++;
      warnNames.push(srv.name);
      const base = st.lastOk || snap || {};
      rx += base.rxMbps || 0;
      tx += base.txMbps || 0;
    } else {
      offline++;
      offlineNames.push(srv.name);
    }
  }
  myTotalBwMbps = rx + tx;
  const statOnline = $('#statOnline');
  const statRx = $('#statRx');
  const statTx = $('#statTx');
  if (statOnline) statOnline.textContent = `${online} / ${servers.length}`;
  if (statRx) statRx.textContent = `${rx.toFixed(2)} Mb/s`;
  if (statTx) statTx.textContent = `${tx.toFixed(2)} Mb/s`;
  $('#agg').textContent = `${online}/${servers.length} · ↓${rx.toFixed(1)} ↑${tx.toFixed(1)} Mb/s`;
  const summaryTotal = $('#summaryTotal');
  const summaryOnline = $('#summaryOnline');
  const summaryWarn = $('#summaryWarn');
  const summaryOffline = $('#summaryOffline');
  if (summaryTotal) summaryTotal.textContent = String(servers.length);
  if (summaryOnline) summaryOnline.textContent = String(online);
  if (summaryWarn) summaryWarn.textContent = String(warn);
  if (summaryOffline) summaryOffline.textContent = String(offline);
  const summaryWarnNames = $('#summaryWarnNames');
  const summaryOfflineNames = $('#summaryOfflineNames');
  if (summaryWarnNames) summaryWarnNames.textContent = warnNames.join('\n');
  if (summaryOfflineNames) summaryOfflineNames.textContent = offlineNames.join('\n');
  const avgStreak = streakN ? (streakSum / streakN) : 0;
  const summaryStreak = $('#summaryStreak');
  const summaryStreakNames = $('#summaryStreakNames');
  const summaryLevelup = $('#summaryLevelup');
  const summaryLevelupNames = $('#summaryLevelupNames');
  const isEnLang = settings.languageMode === 'en';
  if (summaryStreak) {
    summaryStreak.textContent = `${avgStreak.toFixed(1)}${isEnLang ? 'd' : 'g'}`;
    const p = summaryStreak.closest('.summary-item');
    if (p) p.title = isEnLang
      ? `Average uninterrupted uptime streak (online relays): ${avgStreak.toFixed(1)} days\n`
        + `Reward tier distribution → 5x: ${tierCount['5x']} · 3x: ${tierCount['3x']} · 2x: ${tierCount['2x']} · 1x: ${tierCount['1x']}\n`
        + `Streak = uninterrupted online days; one interruption RESETS it. (Based on this monitor's observation — check the official Anyone dashboard for the official tier.)`
      : `Average continuous uptime streak (online relays): ${avgStreak.toFixed(1)} days\n`
        + `Reward tier distribution → 5x: ${tierCount['5x']} · 3x: ${tierCount['3x']} · 2x: ${tierCount['2x']} · 1x: ${tierCount['1x']}\n`
        + `Streak = continuous online days; one outage resets it. (Based on this monitor's observations — see the Anyone dashboard for the official tier.)`;
  }
  if (summaryLevelup) summaryLevelup.textContent = String(levelupNames.length);
  if (summaryLevelupNames) {
    summaryLevelupNames.textContent = levelupNames.length
      ? (isEnLang
        ? '⚡ Relays less than 3 days from their next reward tier — do NOT let these go offline:\n\n' + levelupNames.join('\n')
        : '⚡ Relays within three days of the next reward multiplier — avoid interrupting them:\n\n' + levelupNames.join('\n'))
      : 'No relays close to leveling up a tier.';
  }
  updateSidebarCounts(servers.length, online, warn, offline);
  updateMyShareStat();
  scheduleFleetReferenceRender();
}

function scheduleFleetReferenceRender() {
  if (fleetReferenceRenderQueued) return;
  fleetReferenceRenderQueued = true;
  requestAnimationFrame(() => {
    fleetReferenceRenderQueued = false;
    renderFleetAlertPanel();
    drawFleetTrafficChart();
  });
}

function renderFleetAlertPanel() {
  const list = $('#fleetAlertList');
  const count = $('#fleetAlertsCount');
  if (!list || !count) return;
  const issues = [];
  for (const srv of servers) {
    const st = snaps.get(srv.name);
    const snap = st && st.last;
    // İlk tarama tamamlanmadan henüz veri gelmeyen relay'leri uyarı sayma.
    if (!snap) continue;
    const state = getEffectiveRelayState(snap);
    if (state === 'online') continue;
    const isOffline = state === 'offline';
    const serviceIssue = hasRelayServiceWarning(snap);
    // Tek turluk geçici SSH timeout'ları (stale/sarı, servis sorunu yok) paneli
    // doldurmasın — bir sonraki poll'da yeşile dönüyorlar. Kart yine sararır;
    // panel yalnızca müdahale gerekenleri listeler: offline veya anon/dashboard uyarısı.
    if (state === 'stale' && !serviceIssue) continue;
    const title = isOffline
      ? `${escapeHtml(srv.name)} offline`
      : `${escapeHtml(srv.name)} needs attention`;
    const description = isOffline
      ? escapeHtml(snap.error || 'The last connection check failed.')
      : escapeHtml(serviceIssue ? 'The watched service or the dashboard needs attention.' : (snap.error || 'The last check was delayed.'));
    const when = typeof snap.ts === 'number' ? fmtSince(snap.ts) : 'just now';
    issues.push({ isOffline, serviceIssue, title, description, when });
  }
  issues.sort((a, b) => Number(b.isOffline) - Number(a.isOffline));
  count.textContent = String(issues.length);
  count.className = issues.length ? (issues.some((i) => i.isOffline) ? 'critical' : 'warning') : 'ok';
  if (!issues.length) {
    list.innerHTML = '<div class="fleet-alert-empty ok"><span>●</span> No active alerts.</div>';
    return;
  }
  list.innerHTML = issues.slice(0, 5).map((issue) => `
    <article class="fleet-alert ${issue.isOffline ? 'critical' : 'warning'}">
      <div class="fleet-alert-dot"></div>
      <div><b>${issue.title}</b><p>${issue.description}</p><small>${issue.when}</small></div>
    </article>`).join('');
}

function drawFleetTrafficChart() {
  const cvs = $('#fleetTrafficChart');
  if (!cvs) return;
  const cssW = Math.max(320, Math.floor(cvs.clientWidth || 760));
  const cssH = Math.max(120, Math.floor(cvs.clientHeight || 180));
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  if (cvs.width !== cssW * ratio || cvs.height !== cssH * ratio) {
    cvs.width = cssW * ratio;
    cvs.height = cssH * ratio;
  }
  const ctx = cvs.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const rx = Array(HISTORY).fill(0);
  const tx = Array(HISTORY).fill(0);
  let samples = 0;
  for (const st of snaps.values()) {
    if (!st || !st.last || getEffectiveRelayState(st.last) === 'offline') continue;
    const rxHist = st.rxHist || [];
    const txHist = st.txHist || [];
    const start = Math.max(0, HISTORY - Math.max(rxHist.length, txHist.length));
    for (let i = 0; i < rxHist.length && start + i < HISTORY; i++) rx[start + i] += Number(rxHist[i]) || 0;
    for (let i = 0; i < txHist.length && start + i < HISTORY; i++) tx[start + i] += Number(txHist[i]) || 0;
    samples++;
  }
  const pad = { top: 12, right: 10, bottom: 20, left: 34 };
  const chartW = cssW - pad.left - pad.right;
  const chartH = cssH - pad.top - pad.bottom;
  const max = Math.max(1, ...rx, ...tx) * 1.12;
  ctx.strokeStyle = 'rgba(116, 157, 220, .14)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#6e86aa';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  for (let i = 0; i < 4; i++) {
    const y = pad.top + (chartH / 3) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(cssW - pad.right, y); ctx.stroke();
    const value = max - (max / 3) * i;
    ctx.fillText(value >= 1000 ? `${(value / 1000).toFixed(1)}G` : `${value.toFixed(0)}M`, 0, y + 3);
  }
  const drawLine = (values, color, fill) => {
    ctx.beginPath();
    values.forEach((value, i) => {
      const x = pad.left + (i / (HISTORY - 1)) * chartW;
      const y = pad.top + chartH - (value / max) * chartH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (fill) {
      ctx.lineTo(pad.left + chartW, pad.top + chartH);
      ctx.lineTo(pad.left, pad.top + chartH);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
      gradient.addColorStop(0, fill);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    ctx.beginPath();
    values.forEach((value, i) => {
      const x = pad.left + (i / (HISTORY - 1)) * chartW;
      const y = pad.top + chartH - (value / max) * chartH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  drawLine(rx, '#2e9cff', 'rgba(46, 156, 255, .18)');
  drawLine(tx, '#21d5df', 'rgba(33, 213, 223, .10)');
  ctx.fillStyle = '#7287a8';
  ctx.fillText(samples ? `${samples} relays with live traffic` : 'Waiting for live traffic samples', pad.left, cssH - 4);
}

function updateMyShareStat() {
  const el = $('#statMyShare');
  if (!el) return;
  if (!networkStatsData || !networkStatsData.ok || !networkStatsData.totalBwGbps) {
    el.textContent = '—';
    el.title = networkStatsData && networkStatsData.error ? networkStatsData.error : 'Waiting for network bandwidth data';
    return;
  }
  const netMbps = networkStatsData.totalBwGbps * 1000;
  if (netMbps <= 0) {
    el.textContent = '—';
    el.title = 'Network bandwidth is zero or invalid';
    return;
  }
  const share = (myTotalBwMbps / netMbps) * 100;
  el.textContent = share < 0.01 ? '<0.01%' : share.toFixed(2) + '%';
  el.title = `My relay traffic: ${myTotalBwMbps.toFixed(2)} Mb/s / Network: ${netMbps.toFixed(0)} Mb/s`;
}

async function refreshNetworkStats() {
  const relEl = $('#statNetRelays');
  const bwEl = $('#statNetBw');
  const shareEl = $('#statMyShare');
  if (!windowVisible) return;
  if (relEl && (!networkStatsData || !networkStatsData.updatedAt)) relEl.textContent = '…';
  if (bwEl && (!networkStatsData || !networkStatsData.updatedAt)) bwEl.textContent = '…';
  const r = await window.api.fetchNetworkStats();
  networkStatsData = r;
  if (relEl) {
    relEl.textContent = r.ok && r.totalRelays != null ? r.totalRelays.toLocaleString() : '—';
    relEl.title = r.ok
      ? `Updated ${formatWhen(r.updatedAt)}`
      : (r.error || 'Could not fetch network relay count');
  }
  if (bwEl) {
    if (r.ok && r.totalBwGbps != null) {
      bwEl.textContent = r.totalBwGbps >= 1 ? r.totalBwGbps.toFixed(1) + ' GB/s' : (r.totalBwGbps * 1000).toFixed(0) + ' Mb/s';
      bwEl.title = `Updated ${formatWhen(r.updatedAt)}${r.source ? ` · ${r.source}` : ''}`;
    } else {
      bwEl.textContent = '—';
      bwEl.title = r.error || 'Could not fetch network bandwidth';
    }
  }
  if (shareEl && r && !r.ok && r.error) shareEl.title = r.error;
  updateMyShareStat();
}

function updateCardFlags(name) {
  const card = document.querySelector(`.card[data-name="${cssEscape(name)}"]`);
  if (!card) return;
  const fpEl = card.querySelector('.fingerprint-main');
  const copyBtn = card.querySelector('.fingerprint-copy');
  const cachedFp = relayFingerprintCache.get(name) || '';
  if (fpEl) fpEl.textContent = cachedFp ? shortFingerprint(cachedFp) : '—';
  if (copyBtn) copyBtn.dataset.fp = cachedFp;

  const netEl = card.querySelector('.tile-netweight .tile-value');
  const net = relayNetStatsCache.get(name);
  if (netEl && net) {
    netEl.textContent = net.consensusWeight ? net.consensusWeight.toLocaleString() : '0';
    const mbps = net.observedBandwidth ? (net.observedBandwidth * 8 / 1e6).toFixed(1) : '0';
    netEl.title = `${net.nickname} · ${mbps} Mb/s · ${net.measured ? 'olculdu' : 'olculmedi'} · ${net.running ? 'agda' : 'agda degil'}`;
  }
}

// Ag tarafi relay verisi (consensus weight / observed bandwidth).
// SSH gerektirmez — Anyone API'sinden fingerprint ile sorgulanir.
const relayNetStatsCache = new Map();

async function loadRelayNetworkStats() {
  const byFp = new Map();
  for (const srv of servers) {
    const fp = relayFingerprintCache.get(srv.name);
    if (fp) byFp.set(String(fp).toUpperCase(), srv.name);
  }
  if (!byFp.size) return;

  let res;
  try {
    res = await window.api.fetchRelayNetworkStats([...byFp.keys()]);
  } catch { return; }
  if (!res || !res.ok) return;

  for (const [fp, name] of byFp) {
    const info = res.relays[fp];
    if (info) relayNetStatsCache.set(name, info);
  }
  for (const srv of servers) updateCardFlags(srv.name);
}

async function refreshRelayFingerprintCache() {
  try {
    const r = await window.api.fetchRelayFingerprints();
    if (!r.ok) return;
    for (const row of (r.rows || [])) {
      if (row && row.ok && row.fingerprint) relayFingerprintCache.set(row.name, row.fingerprint);
    }
    for (const srv of servers) updateCardFlags(srv.name);
    // Fingerprint'ler doldu — ağ verisini güncelle
    loadRelayNetworkStats();
  } catch {}
}

function renderBandwidthView() {
  const tbody = $('#bwTable tbody');
  if (!tbody) return;
  const rows = servers.map((srv) => {
    const st = snaps.get(srv.name) || {};
    const last = st.last || {};
    const avgRx = st.rxHist && st.rxHist.length ? st.rxHist.reduce((a, b) => a + b, 0) / st.rxHist.length : 0;
    const avgTx = st.txHist && st.txHist.length ? st.txHist.reduce((a, b) => a + b, 0) / st.txHist.length : 0;
    const totalGb = (st.totalRxGb || 0) + (st.totalTxGb || 0);
    return {
      name: srv.name,
      state: last.state || (last.ok ? 'online' : 'offline'),
      nowRx: last.rxMbps || 0,
      nowTx: last.txMbps || 0,
      avg: avgRx + avgTx,
      peak: st.peakMbps || 0,
      totalGb,
    };
  }).sort((a, b) => (b.nowRx + b.nowTx) - (a.nowRx + a.nowTx));

  let nowRxTotal = 0, nowTxTotal = 0, sessionTotal = 0;
  rows.forEach((r) => { nowRxTotal += r.nowRx; nowTxTotal += r.nowTx; sessionTotal += r.totalGb; });
  $('#bwNowTotal').textContent = fmtMbpsPair(nowRxTotal, nowTxTotal);
  $('#bwSessionTotal').textContent = fmtTrafficGb(sessionTotal);
  $('#bwTopCurrent').textContent = rows[0] ? `${rows[0].name} · ${(rows[0].nowRx + rows[0].nowTx).toFixed(2)} Mb/s` : '—';
  const topTotal = [...rows].sort((a, b) => b.totalGb - a.totalGb)[0];
  $('#bwTopTotal').textContent = topTotal ? `${topTotal.name} · ${fmtTrafficGb(topTotal.totalGb)}` : '—';

  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td><b>${escapeHtml(r.name)}</b></td>
      <td><span class="bw-state ${cssEscape(r.state)}">${escapeHtml(r.state)}</span></td>
      <td>${fmtMbpsPair(r.nowRx, r.nowTx)}</td>
      <td>${r.avg.toFixed(2)} Mb/s</td>
      <td>${r.peak.toFixed(2)} Mb/s</td>
      <td>${fmtTrafficGb(r.totalGb)}</td>
    </tr>
  `).join('');
}

function formatWhen(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function updateNetworkBadge() {
  refreshHeaderBadges();
}

function renderQuickControls() {}

function bindSecretField(inputId, opts = {}) {
  const input = $(`#${inputId}`);
  if (!input || input.dataset.secretBound === '1') return;
  input.dataset.secretBound = '1';
  const toggleBtn = opts.toggleId ? $(`#${opts.toggleId}`) : null;
  const copyBtn = opts.copyId ? $(`#${opts.copyId}`) : null;
  const clearBtn = opts.clearId ? $(`#${opts.clearId}`) : null;

  const syncToggleLabel = () => {
    if (!toggleBtn) return;
    toggleBtn.textContent = input.type === 'password' ? 'Show' : 'Hide';
  };

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      syncToggleLabel();
    });
  }
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (!input.value) return;
      await window.api.clipboardWriteText(input.value);
      flash(copyBtn, 'Copied');
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      input.type = 'password';
      // Kasitli silme isareti: sadece bu durumda kaydetme kasadaki sirri siler.
      // Kutunun sadece bos gorunmesi silme sebebi degil (bkz. readSecretField).
      input.dataset.cleared = '1';
      syncToggleLabel();
    });
  }
  input.addEventListener('input', () => { delete input.dataset.cleared; });
  syncToggleLabel();
}

// --- server select populate (logs tab removed) ---
function populateLogServerSelect() {
  const testSel = $('#testSel');
  const nyxSel = $('#nyxServer');
  const htopSel = $('#htopServer');
  const terminalSel = $('#terminalServer');
  const configSel = $('#configServer');
  // Mevcut secimleri sakla. Bu fonksiyon her cagrildiginda listeleri sifirdan
  // dolduruyor; onceden secim korunmadigi icin kullanici Araclar'da bir relay
  // secip Ayarlar'da "Save"e bastiginda secim ilk sunucuya donuyordu ve
  // nyx/htop/anonrc yanlis sunucuya baglaniyordu.
  const keep = [testSel, nyxSel, htopSel, terminalSel, configSel].map(el => el ? el.value : '');
  if (testSel) testSel.innerHTML = '';
  if (nyxSel) nyxSel.innerHTML = '';
  if (htopSel) htopSel.innerHTML = '';
  if (terminalSel) terminalSel.innerHTML = '';
  if (configSel) configSel.innerHTML = '';
  for (const s of servers) {
    const o = document.createElement('option'); o.value = s.name; o.textContent = s.name;
    if (testSel) { const o2 = o.cloneNode(true); testSel.appendChild(o2); }
    if (nyxSel) { const o3 = o.cloneNode(true); nyxSel.appendChild(o3); }
    if (htopSel) { const o5 = o.cloneNode(true); htopSel.appendChild(o5); }
    if (terminalSel) { const o7 = o.cloneNode(true); terminalSel.appendChild(o7); }
    if (configSel) { const o6 = o.cloneNode(true); configSel.appendChild(o6); }
  }
  // Secim hala listede varsa geri yukle.
  [testSel, nyxSel, htopSel, terminalSel, configSel].forEach((el, i) => {
    if (el && keep[i] && servers.some(s => s.name === keep[i])) el.value = keep[i];
  });
}

// --- settings tab ---
let selectedSettingsServerName = '';

function renderSelectedRelayDetail() {
  const pane = $('#selectedRelayDetail');
  if (!pane) return;
  const srv = servers.find(s => s.name === selectedSettingsServerName) || servers[0];
  if (!srv) {
    pane.innerHTML = '<div class="relay-edit-empty">Add a relay to configure its connection.</div>';
    return;
  }
  selectedSettingsServerName = srv.name;
  const snap = snaps.get(srv.name)?.last;
  const state = snap ? getEffectiveRelayState(snap) : 'waiting';
  const stateText = state === 'online' ? 'Online' : state === 'stale' ? 'Warning' : state === 'offline' ? 'Offline' : 'Waiting';
  pane.innerHTML = `
    <div class="relay-edit-title"><div><span class="state-dot ${state}"></span>${escapeHtml(srv.name)}</div><button class="detail-close" title="Clear selection">×</button></div>
    <p class="hint">Edit the selected relay. Save Connections writes these values to RelayPulse.</p>
    <div class="relay-detail-status ${state}"><span>${stateText}</span><small>${snap?.ts ? 'Last check ' + fmtSince(snap.ts) : 'Awaiting first check'}</small></div>
    <label>Relay name<input data-detail-f="name" value="${escAttr(srv.name || '')}" autocomplete="off"></label>
    <label>Host or SSH Alias<input data-detail-f="hostAlias" value="${escAttr(srv.host || srv.sshAlias || '')}" placeholder="relay.example.com"></label>
    <label>User<input data-detail-f="user" value="${escAttr(srv.user || '')}" placeholder="root"></label>
    <label>Port<input data-detail-f="port" type="number" min="1" max="65535" value="${escAttr(String(srv.port || 22))}"></label>
    <label>SSH key<input data-detail-f="key" value="${escAttr(srv.key || '')}" placeholder="~/.ssh/id_ed25519"></label>
    <label>Password<input data-detail-f="password" type="password" value="${escAttr(srv.password || '')}" placeholder="Optional — encrypted storage" autocomplete="new-password"></label>
    <div class="relay-detail-actions"><button class="detail-test" type="button">Test connection</button><button class="detail-save primary" type="button">Save Relay</button></div>`;

  const updateDetail = (event) => {
    const field = event.currentTarget.dataset.detailF;
    const row = [...$$('#serversTable tbody tr')].find(tr => tr.dataset.serverName === selectedSettingsServerName);
    if (!row || !field) return;
    const val = event.currentTarget.value;
    if (field === 'hostAlias') {
      const host = row.querySelector('input[data-f="host"]');
      const alias = row.querySelector('input[data-f="sshAlias"]');
      // Keep the existing connection style: an alias-only relay remains an
      // alias-only relay; direct-host relays keep using their host field.
      if (host && host.value.trim()) host.value = val;
      else if (alias) alias.value = val;
      else if (host) host.value = val;
    } else {
      const input = row.querySelector(`input[data-f="${field}"]`);
      if (input) input.value = val;
    }
    if (field === 'name' && val.trim()) {
      row.dataset.serverName = val.trim();
      selectedSettingsServerName = val.trim();
    }
  };
  $$('[data-detail-f]', pane).forEach(input => input.addEventListener('input', updateDetail));
  pane.querySelector('.detail-save')?.addEventListener('click', () => $('#saveServers')?.click());
  pane.querySelector('.detail-test')?.addEventListener('click', () => {
    const name = selectedSettingsServerName;
    const testSel = $('#testSel');
    if (testSel) testSel.value = name;
    $('#testBtn')?.click();
  });
  pane.querySelector('.detail-close')?.addEventListener('click', () => {
    selectedSettingsServerName = '';
    renderSelectedRelayDetail();
  });
}

function renderSettingsFeatureCards() {
  setText('#settingsPollingSummary', `${Math.max(10, Math.round((Number(settings.pollMs) || 120000) / 1000))} seconds`);
  setText('#settingsConnectionSummary', (settings.connectionMode || 'https') === 'ssh' ? 'SSH' : 'HTTPS Agent');
  setText('#settingsAlarmSummary', settings.alarmEnabled === false ? 'Disabled' : 'Enabled');
  setText('#settingsAutoFixSummary', autoFixSettings.autoFixEnabled ? 'Enabled' : 'Disabled');
}

function renderMonitoringPreview() {
  const wrap = $('#monPreviewWrap');
  if (!wrap) return;
  const isEn = settings.languageMode === 'en';
  const rows = servers.map(s => snaps.get(s.name)?.last).filter(Boolean);
  const counts = { online: 0, stale: 0, offline: 0 };
  const latency = [];
  for (const snap of rows) {
    const state = getEffectiveRelayState(snap);
    if (counts[state] != null) counts[state]++;
    if (snap.ok && Number.isFinite(Number(snap.responseMs))) latency.push(Number(snap.responseMs));
  }
  const avg = latency.length ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) : 0;
  const maxLatency = Math.max(100, ...latency);
  const points = latency.slice(-24).map((v, i, a) => {
    const x = a.length === 1 ? 50 : (i / (a.length - 1)) * 100;
    const y = 34 - (v / maxLatency) * 28;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const bar = (label, value, cls) => `<div class="mon-preview-stat"><span class="mon-dot ${cls}"></span><b>${value}</b><small>${label}</small></div>`;
  wrap.innerHTML = `<div class="mon-preview-head"><span>Current fleet signal</span><small>${rows.length}/${servers.length} reporting</small></div>
    <div class="mon-preview-stats">${bar('Online', counts.online, 'online')}${bar('Stale', counts.stale, 'stale')}${bar('Offline', counts.offline, 'offline')}<div class="mon-preview-stat latency"><b>${avg || '—'}<small>${avg ? ' ms' : ''}</small></b><small>Avg response</small></div></div>
    <div class="mon-preview-chart"><div class="mon-preview-axis"><span>Response time</span><span>${latency.length ? `${maxLatency} ms` : '—'}</span></div><svg viewBox="0 0 100 38" preserveAspectRatio="none"><path class="mon-grid-line" d="M0 6H100 M0 20H100 M0 34H100"/><polyline class="mon-preview-line" points="${points}"/></svg><small>${latency.length ? 'Last 24 successful polls' : 'Waiting for the first poll…'}</small></div>`;
}

function renderSettings() {
  const tbody = $('#serversTable tbody');
  tbody.innerHTML = '';
  if (!servers.some(s => s.name === selectedSettingsServerName)) selectedSettingsServerName = servers[0]?.name || '';
  for (const s of servers) {
    const tr = document.createElement('tr');
    tr.dataset.serverName = s.name;
    // serverName, relay adi duzenlenince guncelleniyor (updateDetail). origName ise
    // render anindaki adi tutar ve ASLA degismez — agentToken/agentPort gibi tabloda
    // input'u olmayan alanlari kaydederken geri bulmak icin tek saglam capa budur.
    tr.dataset.origName = s.name;
    const isEnRow = settings.languageMode === 'en';
    const last = snaps.get(s.name)?.last;
    const state = last ? getEffectiveRelayState(last) : 'waiting';
    const stateText = state === 'online' ? 'Online' : state === 'stale' ? 'Warning' : state === 'offline' ? 'Offline' : 'Waiting';
    const hostText = s.host || s.sshAlias || '—';
    const agentBtnLabel = s.agentEnabled ? '🟢 Agent' : '⚙ Install';
    const agentBtnTitle = s.agentEnabled
      ? 'Agent running — click to remove'
      : 'Install agent (connects once via SSH)';
    tr.innerHTML = `
      <td><button class="server-pick"><span class="state-dot ${state}"></span>${escapeHtml(s.name)}</button>
        <input data-f="name" type="hidden" value="${escAttr(s.name)}">
        <input data-f="sshAlias" type="hidden" value="${escAttr(s.sshAlias||'')}">
        <input data-f="user" type="hidden" value="${escAttr(s.user||'')}">
        <input data-f="host" type="hidden" value="${escAttr(s.host||'')}">
        <input data-f="port" type="hidden" value="${escAttr(s.port||22)}">
        <input data-f="key" type="hidden" value="${escAttr(s.key||'')}">
        <input data-f="password" type="hidden" value="${escAttr(s.password||'')}">
      </td>
      <td><span class="server-state ${state}">${stateText}</span></td>
      <td class="server-host">${escapeHtml(hostText)}</td>
      <td><span class="mode-chip">SSH</span></td>
      <td><button class="agent-btn" title="${escAttr(agentBtnTitle)}">${agentBtnLabel}</button></td>
      <td class="server-last-check">${last?.ts ? fmtSince(last.ts) : '—'}</td>
      <td class="server-actions"><button class="edit-server">Edit</button><button class="del" title="Remove relay">✕</button></td>
    `;
    const pick = () => { selectedSettingsServerName = tr.dataset.serverName || s.name; renderSelectedRelayDetail(); };
    tr.querySelector('.server-pick').addEventListener('click', pick);
    tr.querySelector('.edit-server').addEventListener('click', pick);
    tr.querySelector('.del').addEventListener('click', () => { tr.remove(); });
    tr.querySelector('.agent-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const name = tr.querySelector('input[data-f="name"]').value.trim();
      const isEnClick = settings.languageMode === 'en';
      if (s.agentEnabled) {
        if (!confirm(`Remove agent for ${name}?`)) return;
        btn.textContent = '⏳'; btn.disabled = true;
        const r = await window.api.removeAgent(name);
        if (r.ok) { s.agentEnabled = false; s.agentPort = undefined; s.agentToken = undefined; s.agentScheme = undefined; renderSettings(); }
        else { btn.textContent = '⚙ Install'; btn.disabled = false; alert('Error: ' + r.error); }
      } else {
        btn.textContent = '⏳'; btn.disabled = true;
        const r = await window.api.installAgent(name);
        if (r.ok) { s.agentEnabled = true; s.agentPort = r.port; s.agentToken = r.token; s.agentScheme = 'https'; renderSettings(); }
        else { btn.textContent = '⚙ Install'; btn.disabled = false; alert('Install error: ' + r.error); }
      }
    });
    tbody.appendChild(tr);
  }
  renderSelectedRelayDetail();
  renderSettingsFeatureCards();
  renderMonitoringPreview();
  $('#defaultNetworkMode').value = 'direct';
  const cmEl = $('#connectionMode');
  if (cmEl) cmEl.value = settings.connectionMode || 'https';
  const languageModeEl = $('#languageMode');
  if (languageModeEl) languageModeEl.value = settings.languageMode || 'en';
  const autoFixDryRunEl = $('#autoFixDryRun');
  if (autoFixDryRunEl) autoFixDryRunEl.checked = !!autoFixSettings.autoFixDryRun;
  $('#alarmEnabled').checked = settings.alarmEnabled !== false;
  $('#alarmSound').value = settings.alarmSound || 'Hero';
  $('#alarmRepeatMinutes').value = Math.max(1, Math.min(60, Number(settings.alarmRepeatMinutes) || 5));
  if ($('#ramWarnPct')) $('#ramWarnPct').value = Math.max(70, Math.min(99, Number(settings.ramWarnPct) || 90));
  if ($('#sshRetryCount')) $('#sshRetryCount').value = Math.max(1, Math.min(3, Number(settings.sshRetryCount) || 2));
  if ($('#sshTimeoutSec')) $('#sshTimeoutSec').value = Math.max(0, Math.min(60, Math.round((Number(settings.sshTimeoutMs) || 0) / 1000)));
  if ($('#offlineAfter')) $('#offlineAfter').value = Math.max(1, Math.min(5, Number(settings.offlineAfter) || 3));
  if ($('#watchServices')) $('#watchServices').value = (settings.watchServices || []).join(' ');
  if ($('#watchPorts')) $('#watchPorts').value = (settings.watchPorts || []).join(' ');
  updateNetworkBadge();
  renderQuickControls();
  refreshHeaderBadges();
}
const languageModeEl = $('#languageMode');
if (languageModeEl) {
  const applySelectedLanguage = async () => {
    const next = 'en';
    settings = { ...settings, languageMode: next };
    languageModeEl.value = next;
    applyLanguage(next);
    try { await window.api.saveSettings(settings); } catch {}
  };
  languageModeEl.addEventListener('change', applySelectedLanguage);
  languageModeEl.addEventListener('input', applySelectedLanguage);
}
const themeModeSelectEl = $('#themeModeSelect');
if (themeModeSelectEl) {
  themeModeSelectEl.value = settings.themeMode === 'light' ? 'light' : 'dark';
  themeModeSelectEl.addEventListener('change', async () => {
    const next = themeModeSelectEl.value === 'light' ? 'light' : 'dark';
    applyTheme(next);
    try { await window.api.saveSettings({ ...settings, themeMode: next }); } catch {}
  });
}
const defaultNetworkModeEl = $('#defaultNetworkMode');
if (defaultNetworkModeEl) {
  const applySelectedNetworkMode = async () => {
    const next = 'direct';
    settings = { ...settings, defaultNetworkMode: next };
    defaultNetworkModeEl.value = next;
    updateNetworkBadge();
    renderQuickControls();
    try { await window.api.saveSettings(settings); } catch {}
  };
  defaultNetworkModeEl.addEventListener('change', applySelectedNetworkMode);
  defaultNetworkModeEl.addEventListener('input', applySelectedNetworkMode);
}
const connectionModeEl = $('#connectionMode');
if (connectionModeEl) {
  connectionModeEl.value = settings.connectionMode || 'https';
  connectionModeEl.addEventListener('change', async () => {
    settings = { ...settings, connectionMode: connectionModeEl.value };
    try { await window.api.saveSettings(settings); } catch {}
    // Değişikliği canlıya uygula — yeniden başlatmayı bekletme.
    try { await window.api.startMonitor(connectionModeEl.value); } catch {}
    refreshHeaderBadges();
  });
}
async function refreshLicenseStatus() {
  const row = $('#licenseStatusRow');
  const entryRow = $('#licenseEntryRow');
  if (!row) return;
  try {
    // Mac App Store build: no license key, no trial clock. Entitlement comes
    // from the App Store purchase, and the key entry must not be shown at all.
    const info = await window.api.getAppInfo();
    if (info && info.mas) {
      const heading = $('#licenseHeading');
      if (heading) heading.textContent = 'Purchase';
      if (entryRow) entryRow.style.display = 'none';
      const s = await window.api.getIapStatus();
      if (s && s.purchased) {
        row.innerHTML = '<span style="color:#4caf50;font-weight:600">✓ Unlocked — unlimited relays</span>';
      } else {
        const limit = info.freeRelayLimit || 3;
        row.innerHTML = `<span style="color:#f0c040">Free tier — up to ${limit} relays monitored</span>`
          + '<div class="hint" style="margin-top:2px">Unlock once to monitor your whole fleet.</div>'
          + '<button id="openPurchaseBtn" class="primary" style="margin-top:8px">Unlock RelayPulse</button>';
        const btn = $('#openPurchaseBtn');
        if (btn) btn.addEventListener('click', () => { window.location.href = 'purchase.html'; });
      }
      return;
    }
    const r = await window.api.getLicenseStatus();
    if (r && r.licensed) {
      row.innerHTML = '<span style="color:#4caf50;font-weight:600">✓ Licensed</span>';
      if (entryRow) entryRow.style.display = 'none';
    } else {
      const TRIAL_DAYS = 14;
      const start = (r && r.firstLaunchAt) || Date.now();
      const expiresAt = start + TRIAL_DAYS * 24 * 60 * 60 * 1000;
      const daysLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
      const expiresStr = new Date(expiresAt).toLocaleDateString();
      row.innerHTML = `<span style="color:#f0c040">Trial mode — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left</span><div class="hint" style="margin-top:2px">Trial expires on ${expiresStr}</div>`;
      if (entryRow) entryRow.style.display = '';
    }
  } catch {}
}
refreshLicenseStatus();

// Demo fleet: a badge in the title bar so nobody can mistake invented relays
// for their own, and a toggle in Settings. Switching restarts the app.
async function refreshDemoMode() {
  try {
    const r = await window.api.getDemoMode();
    const badge = $('#demoBadge');
    const btn = $('#demoToggleBtn');
    if (badge) {
      badge.textContent = (r && r.banner) || 'Demo data — not a real fleet';
      badge.style.display = r && r.enabled ? '' : 'none';
    }
    if (btn) btn.textContent = r && r.enabled ? 'Turn off demo fleet' : 'Turn on demo fleet';
    // Demo modunda Relay Connections paneli uydurma filoyu listeler: "Save
    // Connections" o ornekleri gercek yapilandirmanin uzerine yazardi (main.js
    // artik yazmayi reddediyor, bu da tiklamanin ise yaramis gibi gorunmesini
    // engeller), "Install HTTPS Agent on all" ise RFC 5737 belge adreslerine
    // SSH acardi.
    const demoOn = !!(r && r.enabled);
    for (const id of ['#saveServers', '#installAgentAll']) {
      const el = $(id);
      if (!el) continue;
      el.disabled = demoOn;
      el.title = demoOn ? 'Sample fleet — turn off the demo fleet in Settings › General to edit your own relays.' : '';
    }
    return demoOn;
  } catch { return false; }
}
refreshDemoMode();
const demoToggleBtn = $('#demoToggleBtn');
if (demoToggleBtn) {
  demoToggleBtn.addEventListener('click', async () => {
    const enabled = await refreshDemoMode();
    demoToggleBtn.disabled = true;
    demoToggleBtn.textContent = 'Restarting…';
    try { await window.api.setDemoMode(!enabled); } catch { demoToggleBtn.disabled = false; }
  });
}

const activateLicenseBtn = $('#activateLicenseBtn');
if (activateLicenseBtn) {
  activateLicenseBtn.addEventListener('click', async () => {
    const input = $('#licenseKeyInput');
    const msg = $('#licenseMsg');
    const key = (input && input.value || '').trim();
    if (!key) return;
    activateLicenseBtn.disabled = true;
    activateLicenseBtn.textContent = 'Checking…';
    if (msg) msg.textContent = '';
    try {
      const r = await window.api.activateLicense(key);
      if (r && r.ok) {
        if (msg) { msg.textContent = 'License activated.'; msg.style.color = '#4caf50'; }
        refreshLicenseStatus();
      } else {
        if (msg) { msg.textContent = (r && r.error) || 'Invalid license key.'; msg.style.color = '#f87171'; }
      }
    } catch {
      if (msg) { msg.textContent = 'Could not check the key.'; msg.style.color = '#f87171'; }
    }
    activateLicenseBtn.disabled = false;
    activateLicenseBtn.textContent = 'Activate';
  });
}
$('#navNetworkMapBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    // Pass the real monitored fleet, not placeholder rows. Coordinates remain
    // optional; when supplied they also ring the relay on the global map.
    const fleet = servers.map(s => {
      const snap = snaps.get(s.name)?.last || {};
      return {
        label: s.name,
        lat: Number.isFinite(Number(s.lat)) ? Number(s.lat) : undefined,
        lon: Number.isFinite(Number(s.lon)) ? Number(s.lon) : undefined,
        state: getEffectiveRelayState(snap),
        cpu: snap.cpu?.pct,
        connections: snap.conns,
        uptime: snap.uptime || '',
      };
    });
    const r = await window.api.openNetworkMap(fleet);
    if (r && r.ok === false) flash(btn, 'Failed');
  } catch { flash(btn, 'Failed'); }
  finally { btn.disabled = false; }
});

$('#addServer').addEventListener('click', () => {
  const base = 'new-relay';
  let suffix = 1;
  let name = base;
  while (servers.some(s => s.name === name)) name = `${base}-${suffix++}`;
  servers.push({ name, sshAlias: '', user: '', host: '', port: 22, key: '', password: '' });
  selectedSettingsServerName = name;
  renderSettings();
});

function collectServersFromSettingsRows() {
  const rows = $$('#serversTable tbody tr');
  return rows.map(tr => {
    const obj = {};
    $$('input', tr).forEach(i => {
      if (i.dataset.f === 'port') obj[i.dataset.f] = Number(i.value) || 22;
      else if (i.dataset.f === 'password') obj[i.dataset.f] = i.value;
      else obj[i.dataset.f] = i.value.trim();
    });
    // preserve agent fields set by installAgent
    // Once sadece yeni ada gore aranıyordu; relay adi duzenlendiginde eslesme
    // kopuyor ve agentToken/agentPort/agentScheme sessizce siliniyordu (agent
    // kurulu relay "token yok" durumuna dusuyordu). origName capasi bunu onler.
    const existing = servers.find(s => s.name === obj.name)
      || servers.find(s => s.name === tr.dataset.origName);
    // Kosul once `existing.agentEnabled` idi. Agent'i acip kapatmak ayri IPC'lerle
    // (agent:install / agent:remove) yapiliyor, yani bu tablonun agent alanlarini
    // dusurmesi icin mesru bir sebep yok. Dar kosul, agentEnabled bir sekilde
    // false/undefined gorundugunde token'i kasadan tamamen sildiriyordu.
    if (existing) {
      obj.agentEnabled = existing.agentEnabled;
      obj.agentPort = existing.agentPort;
      obj.agentToken = existing.agentToken;
      obj.agentScheme = existing.agentScheme;
    }
    return obj;
  }).filter(s => s.name);
}

$('#saveServers').addEventListener('click', async () => {
  const next = collectServersFromSettingsRows();
  servers = next;
  await window.api.saveServers(next);
  renderCards();
  populateLogServerSelect();
  flash($('#saveServers'), 'Saved');
});
$('#installAgentAll').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const next = collectServersFromSettingsRows();
  const isEnAll = settings.languageMode === 'en';
  if (!next.length) return alert('No relays to install.');
  servers = next;
  await window.api.saveServers(next);
  if (!confirm(`Install HTTPS agent on all relays? (${next.length})`)) return;
  const oldText = btn.textContent;
  btn.textContent = '⏳ Installing...';
  btn.disabled = true;
  const r = await window.api.installAgentAll();
  btn.textContent = oldText;
  btn.disabled = false;
  if (!r.ok) return alert('Install error: ' + (r.error || 'unknown error'));
  const errors = [];
  for (const item of (r.results || [])) {
    const existing = servers.find(s => s.name === item.name);
    if (!existing) continue;
    if (item.ok) {
      existing.agentEnabled = true;
      existing.agentPort = item.port;
      existing.agentScheme = item.scheme || 'https';
    } else {
      errors.push(`${item.name}: ${item.error}`);
    }
  }
  const refreshed = await window.api.getServers();
  servers = Array.isArray(refreshed) ? refreshed : servers;
  renderSettings();
  renderCards();
  populateLogServerSelect();
  if (errors.length) alert(`HTTPS agent install partially completed.\n\n${errors.join('\n')}`);
  else alert(`HTTPS agent installed on all relays. (${r.okCount} total)`);
});
$('#saveSettings').addEventListener('click', async () => {
  const pollMs = Math.max(30000, Number($('#pollMs').value) || 30000);
  const logLines = Math.max(50, Number($('#cfgLogLines').value) || 200);
  const defaultNetworkMode = $('#defaultNetworkMode').value === 'direct' ? 'direct' : 'anyone';
  const languageMode = 'en';
  const alarmEnabled = !!$('#alarmEnabled').checked;
  const alarmSound = $('#alarmSound').value || 'Hero';
  const alarmRepeatMinutes = Math.max(1, Math.min(60, Number($('#alarmRepeatMinutes').value) || 5));
  const ramWarnPct = $('#ramWarnPct') ? Math.max(70, Math.min(99, Number($('#ramWarnPct').value) || 90)) : (settings.ramWarnPct || 90);
  const sshRetryCount = Math.max(1, Math.min(3, Math.round(Number($('#sshRetryCount').value) || 2)));
  const sshTimeoutMs = Math.max(0, Math.min(60000, Math.round(Number($('#sshTimeoutSec').value) || 0) * 1000));
  const offlineAfter = Math.max(1, Math.min(5, Math.round(Number($('#offlineAfter').value) || 3)));
  // Bos birakilirsa varsayilanlar korunur; gecersiz karakterler atilir.
  const watchServices = ($('#watchServices')?.value || '').split(/[\s,]+/)
    .map(v => v.trim()).filter(v => /^[A-Za-z0-9@._-]+$/.test(v));
  const watchPorts = ($('#watchPorts')?.value || '').split(/[\s,]+/)
    .map(v => parseInt(v, 10)).filter(v => Number.isInteger(v) && v > 0 && v < 65536);
  const dashboardTiles = {
    uptime: !!$('#tileUptime').checked,
    pubip: !!$('#tilePubip').checked,
    anon: !!$('#tileAnon').checked,
    nic: !!$('#tileNic').checked,
    load: !!$('#tileLoad').checked,
  };
  const allowedStyles = ['vivid', 'neon', 'pastel', 'flat', 'glass', 'alien', 'predator', 'aurora'];
  const dashboardTileStyle = allowedStyles.includes($('#tileStyle').value) ? $('#tileStyle').value : 'vivid';
  settings = { ...settings, pollMs, logLines, defaultNetworkMode, languageMode, alarmEnabled, alarmSound, alarmRepeatMinutes, ramWarnPct, sshRetryCount, sshTimeoutMs, offlineAfter, dashboardTiles, dashboardTileStyle };
  if (watchServices.length) settings.watchServices = watchServices;
  if (watchPorts.length) settings.watchPorts = watchPorts;
  await window.api.saveSettings(settings);
  applyLanguage(languageMode);
  updateNetworkBadge();
  renderQuickControls();
  applyTileVisibility();
  applyTileStyle();
  renderMonitoringPreview();
  pushOpsEvent(`Default network saved as ${defaultNetworkMode === 'direct' ? 'Direct' : 'Anyone'}`);
  flash($('#saveSettings'), 'Saved');
});

$('#exportPhoneBtn')?.addEventListener('click', async () => {
  const btn = $('#exportPhoneBtn');
  const out = $('#exportPhoneResult');
  const en = settings.languageMode === 'en';
  btn.disabled = true;
  try {
    const r = await window.api.exportFleetForPhone();
    if (r && r.ok) {
      if (out) out.textContent = en
        ? `${r.count} relays written (${r.withToken} with token) → ${r.filePath}`
        : `${r.count} relays exported (${r.withToken} with tokens) → ${r.filePath}`;
      flash(btn, 'Exported');
    } else if (r && r.error) {
      if (out) out.textContent = 'Failed: ' + r.error;
      flash(btn, 'Failed');
    }
  } catch (e) {
    if (out) out.textContent = 'Failed: ' + (e && e.message ? e.message : e);
    flash(btn, 'Failed');
  } finally {
    btn.disabled = false;
  }
});

function applyTileVisibility() {
  const grid = document.getElementById('cards');
  if (!grid) return;
  const t = settings.dashboardTiles || {};
  grid.classList.toggle('hide-tile-uptime', t.uptime === false);
  grid.classList.toggle('hide-tile-pubip', t.pubip === false);
  grid.classList.toggle('hide-tile-anon', t.anon === false);
  grid.classList.toggle('hide-tile-nic', t.nic === false);
  grid.classList.toggle('hide-tile-load', t.load === false);
}

function applyTileStyle() {
  const grid = document.getElementById('cards');
  if (!grid) return;
  ['vivid', 'neon', 'pastel', 'flat', 'glass', 'alien', 'predator', 'aurora'].forEach((s) => grid.classList.remove('tile-style-' + s));
  const style = settings.dashboardTileStyle || 'vivid';
  grid.classList.add('tile-style-' + style);
}
$('#tileStyle').addEventListener('change', () => {
  const allowedStyles = ['vivid', 'neon', 'pastel', 'flat', 'glass', 'alien', 'predator', 'aurora'];
  const val = $('#tileStyle').value;
  settings.dashboardTileStyle = allowedStyles.includes(val) ? val : 'vivid';
  applyTileStyle();
});

function applyZoom(factor) {
  const f = Math.round(Math.max(0.5, Math.min(2.0, factor)) * 100) / 100;
  settings.zoomFactor = f;
  if (window.api.setZoom) window.api.setZoom(f);
  const lbl = $('#zoomLabel');
  if (lbl) lbl.textContent = Math.round(f * 100) + '%';
}

async function saveZoom() {
  await window.api.saveSettings({ ...settings });
}

$('#zoomOut').addEventListener('click', async () => {
  applyZoom((settings.zoomFactor || 1.0) - 0.05);
  await saveZoom();
});
$('#zoomIn').addEventListener('click', async () => {
  applyZoom((settings.zoomFactor || 1.0) + 0.05);
  await saveZoom();
});
$('#zoomReset').addEventListener('click', async () => {
  applyZoom(1.0);
  await saveZoom();
});

// Cmd+scroll zoom
let _zoomSaveTimer = null;
function _debouncedSaveZoom() {
  clearTimeout(_zoomSaveTimer);
  _zoomSaveTimer = setTimeout(saveZoom, 400);
}
window.addEventListener('wheel', (e) => {
  if (!e.metaKey) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.05 : 0.05;
  applyZoom((settings.zoomFactor || 1.0) + delta);
  _debouncedSaveZoom();
}, { passive: false });

// Cmd+/- / Cmd+0 keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.altKey || e.shiftKey) return;
  if (isTextEditable(e.target)) return;
  if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    applyZoom((settings.zoomFactor || 1.0) + 0.1);
    saveZoom();
  } else if (e.key === '-') {
    e.preventDefault();
    applyZoom((settings.zoomFactor || 1.0) - 0.1);
    saveZoom();
  } else if (e.key === '0') {
    e.preventDefault();
    applyZoom(1.0);
    saveZoom();
  }
});

$('#testAlarmBtn').addEventListener('click', async () => {
  $('#testOut').textContent = 'running alarm test…';
  const r = await window.api.testAlarm();
  $('#testOut').textContent = r.ok ? '✓ test alarm sent' : ('✗ ' + (r.error || 'alarm test fail'));
  pushOpsEvent(r.ok ? 'Test alarm run' : `Test alarm error: ${r.error || 'alarm test fail'}`);
});

$('#testBtn').addEventListener('click', async () => {
  const name = $('#testSel').value;
  const srv = servers.find(s => s.name === name);
  if (!srv) return;
  $('#testOut').textContent = 'testing ' + name + ' …';
  const r = await window.api.testServer(srv);
  $('#testOut').textContent = r.ok ? ('✓ ok\n' + r.output) : ('✗ fail\n' + r.error);
});
$('#quitBtn').addEventListener('click', () => window.api.quit());


function closeEmbeddedTerminal() {
  if (embeddedTerminalSessionId) window.api.terminalClose(embeddedTerminalSessionId);
  embeddedTerminalSessionId = '';
  if (embeddedTerminal) { try { embeddedTerminal.dispose(); } catch {} }
  embeddedTerminal = null;
  embeddedTerminalFit = null;
  const host = $('#embeddedTerminal');
  if (host) host.innerHTML = '';
}

async function openEmbeddedTerminal(name, kind = 'shell') {
  const host = $('#embeddedTerminal');
  const status = $('#terminalStatus');
  if (!host || !window.Terminal || !window.FitAddon) return { ok: false, error: 'The embedded terminal component could not be loaded.' };
  closeEmbeddedTerminal();
  embeddedTerminal = new window.Terminal({ cursorBlink: true, fontSize: 13, theme: { background: '#080b10', foreground: '#e5e7eb' } });
  embeddedTerminalFit = new window.FitAddon.FitAddon();
  embeddedTerminal.loadAddon(embeddedTerminalFit);
  embeddedTerminal.open(host);
  embeddedTerminalFit.fit();
  embeddedTerminal.writeln(`RelayPulse SSH · ${name}`);
  if (status) status.textContent = `Connecting: ${name}…`;
  const result = await window.api.openTerminal(name, kind);
  if (!result || !result.ok) {
    embeddedTerminal.writeln('\r\nConnection error: ' + ((result && result.error) || 'unknown'));
    if (status) status.textContent = (result && result.error) || 'Connection failed';
    return result || { ok: false };
  }
  embeddedTerminalSessionId = result.id;
  embeddedTerminal.onData((data) => window.api.terminalWrite(embeddedTerminalSessionId, data));
  embeddedTerminal.onResize(({ cols, rows }) => window.api.terminalResize(embeddedTerminalSessionId, cols, rows));
  window.addEventListener('resize', () => {
    if (!embeddedTerminal || !embeddedTerminalFit || !embeddedTerminalSessionId) return;
    embeddedTerminalFit.fit();
  }, { once: true });
  if (status) status.textContent = `Connected: ${name}`;
  return result;
}

window.api.onTerminalData(({ id, data }) => {
  if (embeddedTerminal && id === embeddedTerminalSessionId) embeddedTerminal.write(data);
});
window.api.onAlarmPlay(({ soundName }) => {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const low = soundName === 'Basso' || soundName === 'Submarine';
    osc.frequency.value = low ? 260 : 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (low ? 0.65 : 0.24));
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + (low ? 0.68 : 0.27));
    osc.onended = () => ctx.close();
  } catch {}
});

$('#terminalOpen')?.addEventListener('click', () => openEmbeddedTerminal($('#terminalServer').value, 'shell'));
$('#terminalClose')?.addEventListener('click', () => { closeEmbeddedTerminal(); const status = $('#terminalStatus'); if (status) status.textContent = 'Closed'; });
$('#importSshKey')?.addEventListener('click', async () => {
  const result = await window.api.importSshKey();
  if (result && result.ok) alert('SSH key imported into the encrypted vault.');
  else if (result && !result.canceled) alert(result.error || 'The SSH key could not be imported.');
});

// --- nyx tab ---
const nyxOpenBtn = $('#nyxOpen');
if (nyxOpenBtn) {
  nyxOpenBtn.addEventListener('click', async () => {
    const name = $('#nyxServer').value;
    const status = $('#nyxStatus');
    if (!name) { status.textContent = 'select a server first'; return; }
    status.textContent = 'Opening: ' + name + ' …';
    const r = await window.api.openNyx(name);
    if (r && r.embedded) {
      const terminalTab = [...document.querySelectorAll('.tabs button')].find((btn) => btn.dataset.tab === 'terminal');
      if (terminalTab) terminalTab.click();
      const embedded = await openEmbeddedTerminal(name, 'nyx');
      status.textContent = embedded && embedded.ok ? '✓ Nyx opened' : '✗ error: ' + (embedded && embedded.error || 'unknown');
      return;
    }
    status.textContent = r.ok
      ? '✓ Terminal opened for ' + name + ' (nyx connecting)'
      : '✗ error: ' + r.error;
  });
}

// --- htop tab ---
const htopOpenBtn = $('#htopOpen');
if (htopOpenBtn) {
  htopOpenBtn.addEventListener('click', async () => {
    const name = $('#htopServer').value;
    const status = $('#htopStatus');
    if (!name) { status.textContent = 'select a server first'; return; }
    status.textContent = 'Opening: ' + name + ' …';
    const r = await window.api.openHtop(name);
    if (r && r.embedded) {
      const terminalTab = [...document.querySelectorAll('.tabs button')].find((btn) => btn.dataset.tab === 'terminal');
      if (terminalTab) terminalTab.click();
      const embedded = await openEmbeddedTerminal(name, 'htop');
      status.textContent = embedded && embedded.ok ? '✓ htop opened' : '✗ error: ' + (embedded && embedded.error || 'unknown');
      return;
    }
    status.textContent = r.ok
      ? '✓ Terminal opened for ' + name + ' (htop connecting)'
      : '✗ error: ' + r.error;
  });
}

// --- config (anonrc editor) tab ---
// Lets the user load /etc/anon/anonrc over SSH, edit it in a textarea, and
// write it back. Writes auto-verify with `anon --verify-config`; on failure
// we roll back (server-side) so the relay doesn't get bricked. Also exposes
// "apply bandwidth preset" for single server or fleet-wide.
const configEditor = $('#configEditor');
const configStatus = $('#configStatus');
const configOut = $('#configOut');
const configPathEl = $('#configPath');
const configLinesEl = $('#configLines');
const configSel = $('#configServer');
let configRequestSeq = 0;
let configBusy = false;
let loadedConfigServerName = '';

function updateConfigActionState() {
  const hasLoadedConfig = !!loadedConfigServerName && !!configSel && loadedConfigServerName === configSel.value;
  if (configLoadBtn) configLoadBtn.disabled = configBusy;
  if (configSaveBtn) configSaveBtn.disabled = configBusy || !hasLoadedConfig;
  if (configSaveNoRestartBtn) configSaveNoRestartBtn.disabled = configBusy || !hasLoadedConfig;
  if (configEditor) configEditor.readOnly = configBusy || !hasLoadedConfig;
}

function resetConfigEditor(statusText) {
  loadedConfigServerName = '';
  if (configEditor) configEditor.value = '';
  if (configPathEl) configPathEl.textContent = '—';
  if (configOut) configOut.textContent = '';
  updateConfigLineCount();
  if (statusText) setConfigStatus(statusText);
  updateConfigActionState();
}

async function withUiTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function setConfigBusy(next, label) {
  configBusy = !!next;
  if (configSel) configSel.disabled = configBusy;
  if (configApplyPresetBtn) configApplyPresetBtn.disabled = configBusy;
  if (configApplyAllBtn) configApplyAllBtn.disabled = configBusy;
  if (configWhitelistOneBtn) configWhitelistOneBtn.disabled = configBusy;
  if (configWhitelistAllBtn) configWhitelistAllBtn.disabled = configBusy;
  updateConfigActionState();
  if (configBusy && label) setConfigStatus(label);
}

function setConfigStatus(text, kind) {
  if (!configStatus) return;
  configStatus.textContent = text || '';
  configStatus.style.color = kind === 'err' ? '#ff7a7a' : (kind === 'ok' ? '#7ee787' : '');
}
function updateConfigLineCount() {
  if (!configEditor || !configLinesEl) return;
  const n = configEditor.value ? configEditor.value.split('\n').length : 0;
  configLinesEl.textContent = String(n);
}
if (configEditor) configEditor.addEventListener('input', updateConfigLineCount);

async function loadAnonrcForSelected() {
  if (!configSel) return;
  if (configBusy) return;
  const name = configSel.value;
  if (!name) { setConfigStatus('select a server first', 'err'); return; }
  const requestId = ++configRequestSeq;
  setConfigBusy(true, 'loading: ' + name + ' …');
  if (configOut) configOut.textContent = '';
  try {
    const r = await withUiTimeout(window.api.readAnonrc(name), 30000, 'loading config');
    if (requestId !== configRequestSeq) return;
    if (!r.ok) {
      resetConfigEditor();
      setConfigStatus('✗ ' + (r.error || 'error'), 'err');
      return;
    }
    loadedConfigServerName = name;
    if (configEditor) configEditor.value = r.content || '';
    if (configPathEl) configPathEl.textContent = r.path || '—';
    updateConfigLineCount();
    updateConfigActionState();
    setConfigStatus('✓ loaded: ' + name + ' (' + r.path + ')', 'ok');
  } catch (e) {
    if (requestId !== configRequestSeq) return;
    resetConfigEditor();
    setConfigStatus('✗ ' + (e.message || String(e) || 'error'), 'err');
  } finally {
    if (requestId === configRequestSeq) setConfigBusy(false);
  }
}

const configLoadBtn = $('#configLoad');
if (configLoadBtn) configLoadBtn.addEventListener('click', loadAnonrcForSelected);
if (configSel) configSel.addEventListener('change', () => {
  if (configBusy) return;
  resetConfigEditor('server changed. Click "Load anonrc" for the new config.');
});

async function saveAnonrc(restart) {
  if (!configSel || !configEditor) return;
  if (configBusy) return;
  const name = configSel.value;
  if (!name) { setConfigStatus('select a server first', 'err'); return; }
  if (loadedConfigServerName !== name) { setConfigStatus('load this server\'s config file first', 'err'); return; }
  const content = configEditor.value;
  if (!content.trim()) { setConfigStatus('empty file — refusing to write', 'err'); return; }
  const label = restart ? 'Save + Restart' : 'Save only';
  if (!confirm(`${label} — will write anonrc for "${name}".${restart ? '\nVerify + restart will run.' : '\nWill NOT restart, only write.'}\nContinue?`)) return;
  const requestId = ++configRequestSeq;
  setConfigBusy(true, label + ' … ' + name);
  if (configOut) configOut.textContent = '';
  try {
    const r = await withUiTimeout(window.api.writeAnonrc(name, content, { restart, verify: true }), restart ? 30000 : 20000, 'saving config');
    if (requestId !== configRequestSeq) return;
    if (configOut) configOut.textContent = r.output || (r.error || JSON.stringify(r, null, 2));
    if (!r.ok) { setConfigStatus('✗ ' + (r.error || 'error'), 'err'); return; }
    const bits = [];
    if (r.verify) bits.push('verify=' + r.verify);
    if (r.restarted && r.restarted !== 'none') bits.push('restart=' + r.restarted);
    if (r.active) bits.push('active=' + r.active);
    setConfigStatus('✓ ' + name + ' ' + bits.join(' '), 'ok');
  } catch (e) {
    if (requestId !== configRequestSeq) return;
    setConfigStatus('✗ ' + (e.message || String(e) || 'error'), 'err');
  } finally {
    if (requestId === configRequestSeq) setConfigBusy(false);
  }
}

const configSaveBtn = $('#configSave');
if (configSaveBtn) configSaveBtn.addEventListener('click', () => saveAnonrc(true));
const configSaveNoRestartBtn = $('#configSaveNoRestart');
if (configSaveNoRestartBtn) configSaveNoRestartBtn.addEventListener('click', () => saveAnonrc(false));

async function applyPreset(targetName) {
  const multi = targetName === '*ALL*';
  const msg = multi
    ? 'Bandwidth preset will be applied to ALL servers and each will be restarted. Are you sure?'
    : `Bandwidth preset will be applied to "${targetName}" and it will be restarted. Continue?`;
  if (!confirm(msg)) return;
  setConfigStatus((multi ? 'applying to all' : targetName) + ' preset applying …');
  if (configOut) configOut.textContent = '';
  const r = await window.api.applyAnonrcPreset(targetName);
  if (configOut) configOut.textContent = JSON.stringify(r, null, 2);
  if (!r.ok && !Array.isArray(r.results)) { setConfigStatus('✗ ' + (r.error || 'error'), 'err'); return; }
  const lines = (r.results || []).map(x => {
    if (!x.ok) return '✗ ' + x.name + ': ' + (x.error || 'fail');
    const bits = [];
    if (x.verify) bits.push('verify=' + x.verify);
    if (x.restarted && x.restarted !== 'none') bits.push('restart=' + x.restarted);
    if (x.active) bits.push('active=' + x.active);
    return '✓ ' + x.name + ' ' + bits.join(' ');
  }).join('\n');
  if (configOut) configOut.textContent = lines + '\n\n---\nraw:\n' + JSON.stringify(r, null, 2);
  setConfigStatus((r.okCount || 0) + '/' + (r.count || 0) + ' OK', r.ok ? 'ok' : 'err');
  // Reload the editor for the currently selected server so user sees the new content.
  if (!multi && configSel && configSel.value === targetName) loadAnonrcForSelected();
}

const configApplyPresetBtn = $('#configApplyPreset');
if (configApplyPresetBtn) configApplyPresetBtn.addEventListener('click', () => {
  if (!configSel || !configSel.value) { setConfigStatus('select a server first', 'err'); return; }
  applyPreset(configSel.value);
});
const configApplyAllBtn = $('#configApplyAll');
if (configApplyAllBtn) configApplyAllBtn.addEventListener('click', () => applyPreset('*ALL*'));

// Toplu exit-port islemlerinden haric tutulacak sunucular. Eskiden gelistiricinin
// kendi sunucu adi koda gomuluydu; artik ayarlardan okunuyor ve varsayilan bos.
function exitPortsExclude() {
  const v = settings && settings.exitPortsExclude;
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === 'string') return v.split(',').map(x => x.trim()).filter(Boolean);
  return [];
}

const configFirewallExitPortsBtn = $('#configFirewallExitPorts');
if (configFirewallExitPortsBtn) configFirewallExitPortsBtn.addEventListener('click', async () => {
  const EXCLUDE = exitPortsExclude();
  const scope = EXCLUDE.length ? `ALL servers (except ${EXCLUDE.join(', ')})` : 'ALL servers';
  if (!confirm(`Firewall outbound ports will be opened and connection-tested on ${scope}.\n\nPorts: 110, 143, 993, 995, 8080, 8443, 5222, 9418, 6697\n\nContinue?`)) return;
  setConfigStatus('Opening and testing firewall ports…');
  if (configOut) configOut.textContent = '';
  const r = await window.api.firewallApplyExitPorts(EXCLUDE);
  if (!r.ok && !Array.isArray(r.results)) { setConfigStatus('✗ ' + (r.error || 'error'), 'err'); return; }
  const lines = (r.results || []).map(x => {
    if (!x.ok) return '✗ ' + x.name + ': ' + (x.error || 'fail');
    const portLines = Object.entries(x.ports || {}).map(([p, s]) => `  port ${p}: ${s === 'open' ? '✓ open' : '✗ closed'}`).join('\n');
    return `${x.allOpen ? '✓' : '⚠'} ${x.name} [fw:${x.fwMethod}]\n${portLines}`;
  }).join('\n\n');
  if (configOut) configOut.textContent = lines + '\n\n---\nraw:\n' + JSON.stringify(r, null, 2);
  const allOpen = (r.results || []).every(x => x.ok && x.allOpen);
  setConfigStatus((r.okCount || 0) + '/' + (r.count || 0) + ' servers OK' + (allOpen ? ' — all ports open' : ' — some ports closed'), allOpen ? 'ok' : 'err');
});

const configApplyExitPortsBtn = $('#configApplyExitPorts');
if (configApplyExitPortsBtn) configApplyExitPortsBtn.addEventListener('click', async () => {
  const EXCLUDE = exitPortsExclude();
  const scope = EXCLUDE.length ? `ALL servers (except ${EXCLUDE.join(', ')})` : 'ALL servers';
  if (!confirm(`New exit policy ports will be added and restarted on ${scope}.\n\nAdded: 110, 143, 993, 995, 8080, 8443, 5222, 9418, 6697\n\nContinue?`)) return;
  setConfigStatus('Applying exit policy ports…');
  if (configOut) configOut.textContent = '';
  const r = await window.api.applyExitPorts(EXCLUDE);
  if (!r.ok && !Array.isArray(r.results)) { setConfigStatus('✗ ' + (r.error || 'error'), 'err'); return; }
  const lines = (r.results || []).map(x => {
    if (!x.ok) return '✗ ' + x.name + ': ' + (x.error || 'fail');
    const bits = [];
    if (x.verify) bits.push('verify=' + x.verify);
    if (x.restarted && x.restarted !== 'none') bits.push('restart=' + x.restarted);
    if (x.active) bits.push('active=' + x.active);
    return '✓ ' + x.name + ' ' + bits.join(' ');
  }).join('\n');
  if (configOut) configOut.textContent = lines + '\n\n---\nraw:\n' + JSON.stringify(r, null, 2);
  setConfigStatus((r.okCount || 0) + '/' + (r.count || 0) + ' OK', r.ok ? 'ok' : 'err');
});

async function whitelistMyIp(targetName) {
  const multi = targetName === '*ALL*';
  setConfigStatus('detecting public IP…');
  const ipRes = await window.api.getPublicIp();
  if (!ipRes.ok || !ipRes.ip) { setConfigStatus('could not detect IP', 'err'); return; }
  const msg = multi
    ? `Mac IP whitelist (${ipRes.ip}) will be written to ALL servers and fail2ban restarted. Continue?`
    : `Mac IP whitelist (${ipRes.ip}) will be written to "${targetName}". Continue?`;
  if (!confirm(msg)) { setConfigStatus(''); return; }
  setConfigStatus((multi ? 'applying to all' : targetName) + ' whitelist writing (IP=' + ipRes.ip + ') …');
  if (configOut) configOut.textContent = '';
  const r = await window.api.whitelistFail2ban(targetName, ipRes.ip);
  if (configOut) {
    const lines = (r.results || []).map(x => {
      if (!x.ok) return '✗ ' + x.name + ': ' + (x.error || 'fail');
      const bits = [];
      if (x.fail2ban) bits.push('fail2ban=' + x.fail2ban);
      if (x.sshd) bits.push('ssh=' + x.sshd);
      return '✓ ' + x.name + ' ' + bits.join(' ');
    }).join('\n');
    configOut.textContent = 'Mac IP: ' + (r.ip || '') + '\n\n' + lines + '\n\n---\nraw:\n' + JSON.stringify(r, null, 2);
  }
  setConfigStatus((r.okCount || 0) + '/' + (r.count || 0) + ' OK (IP=' + (r.ip || '') + ')', r.ok ? 'ok' : 'err');
}

const configWhitelistOneBtn = $('#configWhitelistOne');
if (configWhitelistOneBtn) configWhitelistOneBtn.addEventListener('click', () => {
  if (!configSel || !configSel.value) { setConfigStatus('select a server first', 'err'); return; }
  whitelistMyIp(configSel.value);
});
const configWhitelistAllBtn = $('#configWhitelistAll');
if (configWhitelistAllBtn) configWhitelistAllBtn.addEventListener('click', () => whitelistMyIp('*ALL*'));
updateConfigActionState();

// --- AI Auto-Fix ---
function renderAutoFix() {
  const enabledEl = $('#autoFixEnabled');
  const dryRunEl = $('#autoFixDryRun');
  const providerEl = $('#aiProvider');
  const claudeKeyEl = $('#claudeApiKey');
  const openaiKeyEl = $('#openaiApiKey');
  if (enabledEl) enabledEl.checked = !!autoFixSettings.autoFixEnabled;
  if (dryRunEl) dryRunEl.checked = !!autoFixSettings.autoFixDryRun;
  // Incident Policy dropdown = gizli enabled+dryRun kutularinin tek yuzu.
  const policyEl = $('#incidentPolicy');
  if (policyEl) {
    policyEl.value = !autoFixSettings.autoFixEnabled ? 'off'
      : autoFixSettings.autoFixDryRun ? 'dryrun' : 'auto';
    const en = settings.languageMode === 'en';
    const opts = policyEl.options;
    if (opts.length === 3) {
      opts[0].textContent = 'Fix issues automatically';
      opts[1].textContent = 'Diagnose only (dry-run)';
      opts[2].textContent = 'Disabled';
    }
    setText('#incidentPolicyLabel', 'Incident Policy');
    setText('#incidentPolicyHint', 'Choose when AI Auto-Fix acts. "Fix automatically" runs the chosen command on the relay. "Diagnose only" picks a command and logs it but never touches the server. "Disabled" turns the feature off.');
  }
  const currentProvider = autoFixSettings.aiProvider || 'openai';
  if (providerEl) providerEl.value = currentProvider;
  if (claudeKeyEl) {
    claudeKeyEl.value = autoFixSettings.claudeApiKey || '';
    claudeKeyEl.type = 'password';
  }
  if (openaiKeyEl) {
    openaiKeyEl.value = autoFixSettings.openaiApiKey || autoFixSettings.aiApiKey || '';
    openaiKeyEl.type = 'password';
  }
  const tbody = $('#autoFixCmdsTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const c of (autoFixSettings.autoFixCommands || [])) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input data-f="id" type="number" value="${escAttr(String(c.id || ''))}" style="width:36px"></td>
      <td><input data-f="name" value="${escAttr(c.name || '')}" placeholder="name" style="width:130px"></td>
      <td><input data-f="command" value="${escAttr(c.command || '')}" placeholder="bash command"></td>
      <td><button class="del" style="padding:2px 6px">✕</button></td>
    `;
    tr.querySelector('.del').addEventListener('click', () => tr.remove());
    tbody.appendChild(tr);
  }
  setText('#autoFixRecentTitle', 'Recent AI Fix Log');
  renderAutoFixLogList($('#autoFixLog'));
  updateAutoFixDashboard();
  refreshHeaderBadges();
}

// Sir alanini kaydetmek icin oku. Bos kutu ile "sil" niyetini ayirir:
//   undefined -> main tarafi bu alana dokunmaz (kasadaki anahtar korunur)
//   ''        -> kullanici Clear'a basti, gercekten silinsin
function readSecretField(id) {
  const el = $(`#${id}`);
  if (!el) return undefined;
  const v = (el.value || '').trim();
  if (!v && el.dataset.cleared !== '1') return undefined;
  return v;
}

let autoFixControlsBound = false;
function bindAutoFixControls() {
  if (autoFixControlsBound) return;
  autoFixControlsBound = true;
  const enabledEl = $('#autoFixEnabled');
  if (enabledEl) enabledEl.addEventListener('change', () => {
    autoFixSettings.autoFixEnabled = !!enabledEl.checked;
    refreshHeaderBadges();
  });
  const dryRunEl = $('#autoFixDryRun');
  if (dryRunEl) dryRunEl.addEventListener('change', () => {
    autoFixSettings.autoFixDryRun = !!dryRunEl.checked;
    refreshHeaderBadges();
  });
  const policyEl = $('#incidentPolicy');
  if (policyEl) policyEl.addEventListener('change', () => {
    const v = policyEl.value;
    const en = $('#autoFixEnabled'), dr = $('#autoFixDryRun');
    if (en) en.checked = v !== 'off';
    if (dr) dr.checked = v === 'dryrun';
    autoFixSettings.autoFixEnabled = v !== 'off';
    autoFixSettings.autoFixDryRun = v === 'dryrun';
    refreshHeaderBadges();
  });
  const providerEl = $('#aiProvider');
  // provider dropdown visible, no hiding of key fields
  bindSecretField('openaiApiKey', {
    toggleId: 'openaiApiKeyToggle',
    copyId: 'openaiApiKeyCopy',
    clearId: 'openaiApiKeyClear',
  });
  bindSecretField('claudeApiKey', {
    toggleId: 'claudeApiKeyToggle',
    copyId: 'claudeApiKeyCopy',
    clearId: 'claudeApiKeyClear',
  });
}

const addAutoFixCmdBtn = $('#addAutoFixCmd');
if (addAutoFixCmdBtn) addAutoFixCmdBtn.addEventListener('click', () => {
  const cmds = autoFixSettings.autoFixCommands || [];
  const maxId = cmds.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
  autoFixSettings.autoFixCommands = [...cmds, { id: maxId + 1, name: '', command: '' }];
  renderAutoFix();
});

const saveAutoFixBtn = $('#saveAutoFix');
if (saveAutoFixBtn) saveAutoFixBtn.addEventListener('click', async () => {
  const rows = $$('#autoFixCmdsTable tbody tr');
  const commands = rows.map(tr => {
    const obj = {};
    $$('input', tr).forEach(i => {
      obj[i.dataset.f] = i.dataset.f === 'id' ? Number(i.value) : i.value.trim();
    });
    return obj;
  }).filter(c => c.name && c.command);
  const selectedProvider = ($('#aiProvider') && $('#aiProvider').value) || 'openai';
  autoFixSettings = {
    autoFixEnabled: !!$('#autoFixEnabled').checked,
    autoFixDryRun: !!$('#autoFixDryRun').checked,
    aiProvider: selectedProvider,
    openaiApiKey: readSecretField('openaiApiKey'),
    claudeApiKey: readSecretField('claudeApiKey'),
    autoFixCommands: commands,
  };
  await window.api.saveAutoFixSettings(autoFixSettings);
  // Kaydettikten sonra kasadaki gercek degerleri geri oku; aksi halde bellekteki
  // autoFixSettings'te anahtar undefined kalir ve sonraki render kutuyu bosaltir.
  autoFixSettings = await window.api.getAutoFixSettings();
  renderQuickControls();
  updateAutoFixDashboard();
  refreshHeaderBadges();
  pushOpsEvent(`AI auto-fix ${autoFixSettings.autoFixEnabled ? 'enabled' : 'disabled'} (${selectedProvider === 'claude' ? 'Claude' : 'OpenAI'})`);
  flash(saveAutoFixBtn, 'Saved');
});

const testAutoFixBtn = $('#testAutoFixBtn');
if (testAutoFixBtn) testAutoFixBtn.addEventListener('click', async () => {
  const rows = $$('#autoFixCmdsTable tbody tr');
  const commands = rows.map(tr => {
    const obj = {};
    $$('input', tr).forEach(i => {
      obj[i.dataset.f] = i.dataset.f === 'id' ? Number(i.value) : i.value.trim();
    });
    return obj;
  }).filter(c => c.name && c.command);
  const draft = {
    autoFixEnabled: !!$('#autoFixEnabled').checked,
    autoFixDryRun: !!$('#autoFixDryRun').checked,
    aiProvider: ($('#aiProvider') && $('#aiProvider').value) || 'openai',
    openaiApiKey: readSecretField('openaiApiKey'),
    claudeApiKey: readSecretField('claudeApiKey'),
    autoFixCommands: commands,
  };
  const out = $('#autoFixTestOut');
  if (out) out.textContent = 'Running AI test…';
  let msg = 'Could not get AI test result';
  try {
    const r = await window.api.testAutoFix(draft);
    const result = r && r.result ? r.result : null;
    if (result) {
      if (!result.ok) msg = `Test error: ${result.error || 'unknown error'}`;
      else if (result.action === 'none') msg = `AI connected, chose not to intervene: ${result.reason || 'no reason given'}`;
      else msg = `AI connected, would run: ${result.commandName || 'unknown'} (${result.reason || 'no reason given'}) [dry-run]`;
    }
  } catch (e) {
    msg = `Test error: ${(e && e.message) || e}`;
  }
  if (out) out.textContent = msg;
  pushOpsEvent(msg);
});

if (window.api.onAutoFixLog) {
  window.api.onAutoFixLog((data) => {
    const raw = data && data.line ? String(data.line) : '';
    const line = raw.replace(/^\[AUTOFIX\s+([^\]]+)\]\s*/, (_, ts) => {
      const d = new Date(ts);
      return '[' + (Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString()) + '] ';
    });
    appendAutoFixLog(line || raw);
  });
}

window.api.onAutoFixResult((data) => {
  const time = new Date().toLocaleTimeString();
  const r = data.result;
  let line;
  if (!r.ok) line = `[${time}] ${data.name}: HATA — ${r.error}`;
  else if (r.action === 'none') line = `[${time}] ${data.name}: AI mudahale etmedi — ${r.reason}`;
  else line = `[${time}] ${data.name}: ${r.commandName} OK — ${r.reason}`;
  appendAutoFixLog(line);
  pushOpsEvent(line.replace(/^\[[^\]]+\]\s*/, ''));
});

// Global Control Room raili "Reports / AI Hub / Settings"e basinca ana pencere
// one gelir ve ilgili ekran acilir.
if (window.api.onFocusTab) {
  window.api.onFocusTab((target) => {
    if (target === 'settings') {
      openTab('settings');
      document.querySelector('.settings-subtab[data-pane="pane-general"]')?.click();
    } else if (target === 'ai') {
      openTab('settings');
      document.querySelector('.settings-subtab[data-pane="pane-aifix"]')?.click();
    }
  });
}

window.api.onFocusRelay((name) => {
  // Relay sekmesine geç. Sekmenin adi "dashboard"; onceden "relays" ve ".tab-btn"
  // araniyordu — ikisi de HTML'de yok, bu yuzden relayTab hep null kaliyor ve
  // bildirimden relay'e odaklanma hic calismiyordu.
  const relayTab = document.querySelector('.tabs button[data-tab="dashboard"]');
  if (relayTab) relayTab.click();
  // Filtrele: tüm göster
  currentFilter = 'all';
  renderCards();
  // Karta scroll et
  setTimeout(() => {
    const card = document.querySelector(`.card[data-name="${cssEscape(name)}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.outline = '3px solid #f59e0b';
      setTimeout(() => { card.style.outline = ''; }, 2500);
    }
  }, 300);
});

window.api.onAutoFixToggle((data) => {
  if (data.autoFixEnabled !== undefined) {
    autoFixSettings.autoFixEnabled = data.autoFixEnabled;
    const el = $('#autoFixEnabled');
    if (el) el.checked = data.autoFixEnabled;
  }
  if (data.autoFixDryRun !== undefined) {
    autoFixSettings.autoFixDryRun = data.autoFixDryRun;
    const el = $('#autoFixDryRun');
    if (el) el.checked = data.autoFixDryRun;
  }
  if (data.aiProvider !== undefined) {
    autoFixSettings.aiProvider = data.aiProvider;
    const el = $('#aiProvider');
    if (el) el.value = data.aiProvider;
  }
  updateAutoFixDashboard();
  renderQuickControls();
  refreshHeaderBadges();
});

// --- utils ---
function flash(btn, text) {
  const old = btn.textContent; btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 900);
}

// ── Kurulum Sağlık Kontrolü Modal ──────────────────────────────────────────
(function initSetupCheckModal() {
  const overlay = document.createElement('div');
  overlay.id = 'setupCheckModal';
  overlay.className = 'setup-check-overlay hidden';
  overlay.innerHTML = `
    <div class="setup-check-panel">
      <div class="setup-check-header">
        <h3>🔍 Setup Health Check</h3>
        <span class="setup-check-name"></span>
        <button class="setup-check-close">✕</button>
      </div>
      <div class="setup-check-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.setup-check-close').addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
})();

function showSetupCheckModal(name, result) {
  const overlay = document.getElementById('setupCheckModal');
  if (!overlay) return;
  overlay.querySelector('.setup-check-name').textContent = name;
  const body = overlay.querySelector('.setup-check-body');
  overlay.classList.remove('hidden');

  if (!result) {
    // spinner
    body.innerHTML = `<div class="setup-check-spinner">⏳ Checking…</div>`;
    return;
  }
  if (!result.ok) {
    body.innerHTML = `<div class="setup-check-spinner" style="color:#f87171">❌ ${escapeHtml(result.error || 'Error')}</div>`;
    return;
  }

  const icons = { ok: '✅', warn: '⚠️', err: '❌' };
  const checksHtml = (result.checks || []).map(c => `
    <li class="setup-check-item ${c.status}">
      <span class="setup-check-icon">${icons[c.status] || '•'}</span>
      <div class="setup-check-content">
        <div class="setup-check-label">${escapeHtml(c.label)}</div>
        <div class="setup-check-detail">${escapeHtml(c.detail)}</div>
      </div>
    </li>`).join('');

  const warns = result.recentWarns || [];
  const warnsHtml = warns.length ? `
    <div class="setup-check-warns">
      <div class="setup-check-warns-title">⚠ Recent WARN logs (${warns.length})</div>
      ${warns.map(l => `<div class="setup-check-warn-line">${escapeHtml(l)}</div>`).join('')}
    </div>` : '';

  body.innerHTML = `<ul class="setup-check-list">${checksHtml}</ul>${warnsHtml}`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escAttr(s) { return escapeHtml(s); }
function cssEscape(s) { return String(s).replace(/"/g, '\\"'); }

/* PERF FIX: disabled experimental DOM-scanning hotfix blocks.
   They installed multiple MutationObservers and short intervals that scanned every node,
   which made the dashboard stutter with many relay cards. */

(function() {
  // Ag verisi kendi dongusunde: fingerprint'ler SSH ile gec doldugu icin sik denenir
  setInterval(loadRelayNetworkStats, 5 * 60 * 1000);
  setTimeout(loadRelayNetworkStats, 30 * 1000);
})();
