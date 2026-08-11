// Renderer: render server cards, sparkline charts, logs, settings.
// No framework — small enough to stay plain.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const HISTORY = 40; // points per sparkline (~6 min @ 10s poll)
const snaps = new Map(); // name -> { last, lastOk, rxHist, txHist }
let servers = [];
let settings = { pollMs: 10000, logLines: 200, themeMode: 'light', languageMode: 'en', alarmEnabled: true, alarmSound: 'Hero', alarmRepeatMinutes: 5, ramWarnPct: 90, dashboardTiles: { uptime: true, pubip: true, anon: true, nic: true, load: true }, dashboardTileStyle: 'vivid' };
let autoFixSettings = { autoFixEnabled: false, aiProvider: 'openai', openaiApiKey: '', autoFixCommands: [] };
let rewardRefreshTimer = null;
const rewardHistory = new Map();
let newsLoaded = false;
let tokenPriceTimer = null;
let networkStatsTimer = null;
let autoFixLogLines = [];
const relayFingerprintCache = new Map(); // server name -> fingerprint
const relayHealthCache = new Map(); // server name -> health/reward data
const relayStateEvents = []; // recent snapshot transitions for the 1h summary
let networkStatsData = null;
let myTotalBwMbps = 0;
let windowVisible = !document.hidden;
let pendingCardUpdates = new Set();
let aggregateDirty = false;
let dashboardFilters = { query: '', state: 'all', anon: 'all' };
const I18N = {
  tr: {
    app_name: 'RelayPulse',
    nav_dashboard: 'Röleler',
    nav_news: 'Genel Bakış',
    nav_rewards: 'Cüzdanlar',
    nav_config: 'Araçlar',
    nav_settings: 'Ayarlar',
    system_online: 'Sistem: Çevrimiçi',
    refresh_now: 'Şimdi Yenile',
    open_config: 'Config Dosyası',
    search_placeholder: 'Röle ara...',
    filter_all: 'Tümü',
    filter_online: 'Çevrimiçi',
    filter_warn: 'Uyarı',
    filter_offline: 'Çevrimdışı',
    anon_all: 'Anon: Tümü',
    anon_ok: 'Anon: OK',
    anon_down: 'Anon: Down',
    summary_total: 'Toplam',
    summary_online: 'Çevrimiçi',
    summary_warn: 'Uyarı',
    summary_offline: 'Çevrimdışı',
    ai_log_empty: 'AI log: henuz yok',
    head_status: 'Durum',
    head_relay: 'Röle Adı',
    head_band: 'Band (RX / TX)',
    head_fingerprint: 'Fingerprint',
    wallet_binding: 'Wallet Binding',
    server: 'Server',
    wallet: 'Wallet',
    reward_relay: 'Relay',
    reward_wallet: 'Wallet',
    reward_fingerprint: 'Fingerprint',
    reward_running: 'Running',
    reward_consensus: 'Consensus',
    reward_latest: 'Latest Reward',
    reward_date: 'Reward Date',
    reward_claim: 'Claim',
    fleet_fingerprints: 'Fleet Fingerprints',
    defaults: 'Defaults',
    language: 'Language',
    polling: 'Polling',
    alarm: 'Alarm',
    subtab_servers: 'Sunucular',
    subtab_general: 'Ayarlar',
    zoom_title: 'Görünüm / Zoom',
    zoom_reset: 'Sıfırla',
    test_title: 'Bağlantı Testi',
    ai_title: 'AI Auto-Fix',
    ai_enabled: 'Auto-Fix aktif',
    ai_dryrun: 'Dry-run modu',
    ai_provider: 'AI Sağlayıcı',
    ai_cmds_title: 'Komutlar (düzenlenebilir)',
    theme_light: '☀︎ Işık',
    theme_dark: '☾ Karanlık',
    theme_title_light: 'Tema: Işık',
    theme_title_dark: 'Tema: Karanlık',
    network_label: 'Network',
    mode_anyone: 'Anyone',
    mode_direct: 'Direct',
    autofix_label: 'Auto-Fix',
    autofix_on: 'On',
    autofix_off: 'Off',
    dry_run: 'Dry-run',
    dry_run_title: 'Auto-fix komutlari calistirilmaz, sadece onizleme yapilir.',
    autofix_title: 'Auto-fix gercek komut calistirir.',
    last_hour: 'Last 1h',
    last_hour_empty: 'Last 1h: no state changes',
    chip_ok: 'OK',
    chip_offline: 'Offline',
    chip_stale: 'Stale',
    chip_low_bw: 'Low BW',
    chip_api_red: 'API red',
    chip_dashboard_red: 'Dash red',
    chip_ssh: 'SSH',
    chip_anon: 'Anon',
    chip_dashboard_down: 'Dashboard ↓',
    chip_offline_title: 'SSH/relay offline',
    chip_stale_title: 'Transient failure, last good data shown',
    chip_lowram: 'Düşük RAM',
    state_online: 'Çevrimiçi',
    state_stale: 'Uyarı',
    state_offline: 'Çevrimdışı',
    last_seen: 'Son görülme',
    claim_unknown: 'unknown',
    claim_yes: 'claimed',
    claim_no: 'unclaimed',
  },
  en: {
    app_name: 'RelayPulse',
    nav_dashboard: 'Relays',
    nav_news: 'Overview',
    nav_rewards: 'Wallets',
    nav_config: 'Tools',
    nav_settings: 'Settings',
    system_online: 'System: Online',
    refresh_now: 'Refresh Now',
    open_config: 'Config File',
    search_placeholder: 'Search relays...',
    filter_all: 'All',
    filter_online: 'Online',
    filter_warn: 'Warning',
    filter_offline: 'Offline',
    anon_all: 'Anon: All',
    anon_ok: 'Anon: OK',
    anon_down: 'Anon: Down',
    summary_total: 'Total',
    summary_online: 'Online',
    summary_warn: 'Warning',
    summary_offline: 'Offline',
    ai_log_empty: 'AI log: none yet',
    head_status: 'Status',
    head_relay: 'Relay Name',
    head_band: 'Bandwidth (RX / TX)',
    head_fingerprint: 'Fingerprint',
    wallet_binding: 'Wallet Binding',
    server: 'Server',
    wallet: 'Wallet',
    reward_relay: 'Relay',
    reward_wallet: 'Wallet',
    reward_fingerprint: 'Fingerprint',
    reward_running: 'Running',
    reward_consensus: 'Consensus',
    reward_latest: 'Latest Reward',
    reward_date: 'Reward Date',
    reward_claim: 'Claim',
    fleet_fingerprints: 'Fleet Fingerprints',
    defaults: 'Defaults',
    language: 'Language',
    polling: 'Polling',
    alarm: 'Alarm',
    subtab_servers: 'Servers',
    subtab_general: 'Settings',
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
    chip_anon: 'Anon',
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
  const lang = settings.languageMode === 'en' ? 'en' : 'tr';
  return (I18N[lang] && I18N[lang][key]) || I18N.tr[key] || key;
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
    languageBadge.textContent = settings.languageMode === 'en' ? 'EN' : 'TR';
    languageBadge.title = settings.languageMode === 'en' ? 'English' : 'Türkçe';
  }
  const autoFixBadge = $('#autoFixModeBadge');
  if (autoFixBadge) {
    const mode = autoFixSettings.autoFixEnabled ? t('autofix_on') : t('autofix_off');
    autoFixBadge.textContent = `${t('autofix_label')}: ${mode}${autoFixSettings.autoFixDryRun ? ` · ${t('dry_run')}` : ''}`;
    autoFixBadge.title = autoFixSettings.autoFixDryRun ? t('dry_run_title') : t('autofix_title');
  }
}

function applyLanguage(lang) {
  settings.languageMode = lang === 'en' ? 'en' : 'tr';
  document.documentElement.lang = settings.languageMode;
  const setText = (sel, value) => {
    const el = $(sel);
    if (el) el.textContent = value;
  };
  setText('#brandTitle', t('app_name'));
  setText('#sidebarBrandTitle', t('app_name'));
  setText('#navDashboard', t('nav_dashboard'));
  setText('#navNews', t('nav_news'));
  setText('#navRewards', t('nav_rewards'));
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
  setText('#rewardBindingTitle', t('wallet_binding'));
  setText('#rewardServerLabel', `${t('server')}:`);
  setText('#rewardWalletLabel', `${t('wallet')}:`);
  setText('#rewardHeadRelay', t('reward_relay'));
  setText('#rewardHeadWallet', t('reward_wallet'));
  setText('#rewardHeadFingerprint', t('reward_fingerprint'));
  setText('#rewardHeadRunning', t('reward_running'));
  setText('#rewardHeadConsensus', t('reward_consensus'));
  setText('#rewardHeadLatestReward', t('reward_latest'));
  setText('#rewardHeadRewardDate', t('reward_date'));
  setText('#rewardHeadClaim', t('reward_claim'));
  setText('#fleetFingerprintsTitle', t('fleet_fingerprints'));
  setText('#settingsDefaultsTitle', t('defaults'));
  setText('#languageModeLabel', t('language'));
  setText('#settingsPollingTitle', t('polling'));
  setText('#settingsAlarmTitle', t('alarm'));
  setText('#settingsZoomTitle', t('zoom_title'));
  setText('#settingsTestTitle', t('test_title'));
  setText('#settingsAiTitle', t('ai_title'));
  setText('#autoFixEnabledLabel', t('ai_enabled'));
  setText('#autoFixDryRunLabel', t('ai_dryrun'));
  setText('#autoFixCmdsTitle', t('ai_cmds_title'));
  setText('#subtabGeneral', t('subtab_general'));
  setText('#zoomReset', t('zoom_reset'));
  setText('#saveSettings', settings.languageMode === 'en' ? 'Save settings' : 'Save settings');
  setText('#saveServers', settings.languageMode === 'en' ? 'Save' : 'Save');
  setText('#addServer', settings.languageMode === 'en' ? '+ Add server' : '+ Add server');
  setText('#rewardAudit', settings.languageMode === 'en' ? 'Audit relay' : 'Audit relay');
  setText('#rewardFetch', settings.languageMode === 'en' ? 'Refresh rewards' : 'Refresh rewards');
  setText('#rewardBind', settings.languageMode === 'en' ? 'Bind wallet' : 'Bind wallet');
  setText('#rewardDashboard', settings.languageMode === 'en' ? 'Open Anyone Dashboard' : 'Open Anyone Dashboard');
  setText('#fleetFingerprintRefresh', settings.languageMode === 'en' ? 'Refresh All' : 'Refresh All');
  setText('#fleetFingerprintCopy', settings.languageMode === 'en' ? 'Copy All' : 'Copy All');
  setText('#fleetMyFamilyCopy', settings.languageMode === 'en' ? 'Copy MyFamily' : 'Copy MyFamily');
  setText('#fleetMyFamilyPreview', settings.languageMode === 'en' ? 'Preview Family' : 'Preview Family');
  setText('#fleetMyFamilyApply', settings.languageMode === 'en' ? 'Apply Family All' : 'Apply Family All');
  setText('#testAlarmBtn', settings.languageMode === 'en' ? 'Test alarm' : 'Test alarm');
  setText('#testBtn', settings.languageMode === 'en' ? 'Run test' : 'Run test');
  setText('#addAutoFixCmd', settings.languageMode === 'en' ? '+ Add Command' : '+ Komut Ekle');
  setText('#saveAutoFix', settings.languageMode === 'en' ? 'Save' : 'Kaydet');
  setText('#testAutoFixBtn', settings.languageMode === 'en' ? 'Test AI' : 'Test AI');
  setText('#quitBtn', settings.languageMode === 'en' ? 'Quit app' : 'Quit app');
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
    card.style.display = (matchesQuery && matchesState && matchesAnon) ? '' : 'none';
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

function appendAutoFixLog(line) {
  if (!line) return;
  autoFixLogLines = [line, ...autoFixLogLines].slice(0, 40);
  const text = autoFixLogLines.join('\n');
  const settingsEl = $('#autoFixLog');
  const dashboardEl = $('#dashboardAutoFixLog');
  const indicatorEl = $('#dashboardAutoFixLastLog');
  if (settingsEl) settingsEl.textContent = text;
  if (dashboardEl) dashboardEl.textContent = text;
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
    await Promise.allSettled([refreshNetworkStats(), refreshFleetHealthRewards()]);
  });
  const openConfigBtn = $('#openConfigBtn');
  if (openConfigBtn) openConfigBtn.addEventListener('click', () => window.api.revealConfigFile());
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
  // Webview RAM yönetimi: anyon-dash'tan çıkınca about:blank'e git (process'i koru ama sayfayı boşalt)
  if (_prevTab === 'anyon-dash' && nextTab !== 'anyon-dash') {
    const wv = document.getElementById('anyonDashWebview');
    if (wv && wv.src && wv.src !== 'about:blank') {
      try { wv.loadURL('about:blank'); } catch (e) { try { wv.src = 'about:blank'; } catch {} }
    }
  }
  _prevTab = nextTab;
  $$('.tabs button').forEach(b => b.classList.remove('active'));
  $$('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  $('#tab-' + btn.dataset.tab).classList.add('active');
  if (btn.dataset.tab === 'rewards') ensureRewardAutoRefresh();
  if (btn.dataset.tab === 'news') ensureNewsLoaded();
  if (btn.dataset.tab === 'anyon-dash') {
    initAnyonDashWebview();
    if (typeof loadAoRewardEstimates === 'function') loadAoRewardEstimates();
  }
  if (btn.dataset.tab === 'config') {
    // Auto-pick the first server, but do not auto-load over SSH on tab open.
    // Network-bound loads here make the UI feel frozen when a host is slow.
    const cSel = $('#configServer');
    if (cSel && !cSel.value && servers && servers[0]) cSel.value = servers[0].name;
    if (cSel && cSel.value && typeof setConfigStatus === 'function') setConfigStatus('server secildi. Yuklemek icin "Load anonrc" tikla.');
    renderLowEarnList();
    renderRewardTrendPanel();
  }
}));

$('#hideBtn').addEventListener('click', () => window.api.hideWindow());

(function bindLowEarnRefresh() {
  const b = document.getElementById('lowEarnRefresh');
  if (b) b.addEventListener('click', () => { if (typeof loadPerRelayRewards === 'function') loadPerRelayRewards(); renderLowEarnList(); });
})();

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
  loadPerRelayRewards(); // AO verisi hemen çekilsin, fingerprint gelmeden önce eşit dağılım göster
  refreshTokenPrice();
  tokenPriceTimer = setInterval(refreshTokenPrice, 60000);
  refreshNetworkStats();
  networkStatsTimer = setInterval(refreshNetworkStats, 60000);
  refreshFleetHealthRewards();

  // Önce kullanıcı bağlantı modunu seçsin, sonra monitoring başlasın.
  const chosenMode = await showConnectionModeDialog(settings.connectionMode || 'https');
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
      <h2 style="margin:0 0 8px;font-size:18px;color:#e8e8f0">${isEn ? 'Connection Mode' : 'Bağlantı Modu'}</h2>
      <p style="margin:0 0 20px;font-size:13px;color:#aaa">${isEn ? 'How should this device connect to relays?' : 'Bu cihazda rölelere nasıl bağlanılsın?'}</p>
      <label style="display:flex;align-items:flex-start;gap:10px;padding:12px;border:2px solid transparent;border-radius:8px;cursor:pointer;margin-bottom:10px;color:#e8e8f0" id="lbl-https">
        <input type="radio" name="connMode" value="https" style="margin-top:2px" ${currentMode !== 'ssh' ? 'checked' : ''}>
        <span>
          <strong style="color:#e8e8f0">HTTPS Agent</strong><br>
          <span style="font-size:12px;color:#999">${isEn ? 'Connects via HTTPS if an agent is installed on the server. Fast. Requires a token.' : 'Sunucuda agent kuruluysa HTTPS ile bağlanır. Hızlıdır. Token gerektirir.'}</span>
        </span>
      </label>
      <label style="display:flex;align-items:flex-start;gap:10px;padding:12px;border:2px solid transparent;border-radius:8px;cursor:pointer;margin-bottom:24px;color:#e8e8f0" id="lbl-ssh">
        <input type="radio" name="connMode" value="ssh" style="margin-top:2px" ${currentMode === 'ssh' ? 'checked' : ''}>
        <span>
          <strong style="color:#e8e8f0">SSH</strong><br>
          <span style="font-size:12px;color:#999">${isEn ? 'No token required. Recommended for MacBooks or new devices.' : 'Token gerektirmez. MacBook veya yeni cihazlar için önerilir.'}</span>
        </span>
      </label>
      <button id="connModeOk" style="width:100%;padding:10px;font-size:14px;font-weight:600;border-radius:8px;border:none;cursor:pointer;background:#7c6af7;color:#fff">${isEn ? 'Connect' : 'Bağlan'}</button>
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
  aggregateDirty = true;
  flushDeferredUiUpdates();
});


// --- per-relay reward display ---
function fmtReward(v) {
  if (!v || v <= 0) return '—';
  return Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function fmtR(v) {
  if (!v || v <= 0) return '—';
  // 4 ondalık — küçük değerlerde 0,00 gözükmesin
  return Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function _uptimeDaysForReward(name) {
  const st = snaps.get(name);
  if (!st || !st.last) return 0;
  const upRaw = String(st.last.uptime || '').replace(/^up\s+/i, '').trim();
  const days  = Number((upRaw.match(/(\d+)\s*day/i)    || [])[1] || 0);
  const hours = Number((upRaw.match(/(\d+)\s*hour/i)   || [])[1] || 0);
  const mins  = Number((upRaw.match(/(\d+)\s*minute/i) || [])[1] || 0);
  return days + hours / 24 + mins / 1440;
}

function _uptimeTierMult(days) {
  if (days >= 45) return 5;
  if (days >= 14) return 3;
  if (days >= 3)  return 2;
  return 1;
}

function updateCardReward(name) {
  // tps yoksa bile gercek odul verisi (fpRewards) varsa devam et
  if ((!window._aoTps || !window._aoTotalRelays) && !window._aoFpRewards) return;
  const card = document.querySelector(`.cockpit-card[data-name="${cssEscape(name)}"]`);
  if (!card) return;

  // Fleet toplam tahmini: tps × period × N / totalNetwork
  const n = (servers || []).length || 1;
  const fleetHourly = (window._aoTps || 0) * 3600  * n / (window._aoTotalRelays || 1);
  const fleetDaily  = (window._aoTps || 0) * 86400 * n / (window._aoTotalRelays || 1);

  // Her relay'in ortalama bant genişliği (rx+tx Mb/s) — snaps'tan
  let totalBw = 0;
  const bwMap = {};
  for (const srv of (servers || [])) {
    const st = snaps.get(srv.name);
    const rx = (st && st.rxHist.length) ? st.rxHist.reduce((a, b) => a + b, 0) / st.rxHist.length : 0;
    const tx = (st && st.txHist.length) ? st.txHist.reduce((a, b) => a + b, 0) / st.txHist.length : 0;
    bwMap[srv.name] = rx + tx;
    totalBw += rx + tx;
  }

  let hourly, daily;
  const myBw = bwMap[name] || 0;
  if (totalBw > 0) {
    // Bant genişliğine orantılı dağıtım
    hourly = fleetHourly * myBw / totalBw;
    daily  = fleetDaily  * myBw / totalBw;
  } else {
    // Veri yok: eşit bölüştür
    hourly = fleetHourly / n;
    daily  = fleetDaily  / n;
  }

  const h = card.querySelector('.rw-hourly');
  const d = card.querySelector('.rw-daily');
  const rr = card.querySelector('.relay-reward-row');
  const lbl = card.querySelector('.rw-label');
  const totEl = card.querySelector('.rw-total');

  // KESIN VERI: bu relay'in fingerprint'i AO gercek odul tablosunda var mi?
  const fp = (relayFingerprintCache.get(name) || ((snaps.get(name) || {}).last || {}).fingerprint || '').toUpperCase();
  const real = (fp && window._aoFpRewards) ? window._aoFpRewards[fp] : null;

  // Gercek birikmis toplam — her zaman goster (varsa)
  if (totEl) {
    if (real && real.total > 0) {
      totEl.textContent = `Σ ${fmtR(real.total)}`;
      totEl.title = settings.languageMode === 'en'
        ? `Real earned total (on-chain): ${real.total.toFixed(4)} ANYONE`
        : `Gerçek kazanılan toplam (zincir): ${real.total.toFixed(4)} ANYONE`;
    } else {
      totEl.textContent = '';
      totEl.title = '';
    }
  }

  if (real && real.ready && real.hourly != null) {
    // GERCEK saatlik/gunluk hiz (delta-tabanli, tum carpanlar dahil)
    if (h) h.textContent = fmtR(real.hourly);
    if (d) d.textContent = fmtR(real.daily);
    const isEnReal = settings.languageMode === 'en';
    if (lbl) { lbl.textContent = isEnReal ? 'Real' : 'Ger.'; lbl.title = isEnReal ? `Real measured rate (from ${(real.windowH || 0).toFixed(1)}h of data)` : `Gerçek ölçülen hız (${(real.windowH || 0).toFixed(1)} saatlik veriden)`; }
    if (rr) rr.title = isEnReal ? `REAL: total ${real.total.toFixed(4)} ANYONE · real rate from ${(real.windowH || 0).toFixed(1)}h of measurement` : `GERÇEK: toplam ${real.total.toFixed(4)} ANYONE · ${(real.windowH || 0).toFixed(1)}h ölçümden gerçek hız`;
    return;
  }

  // Gercek hiz henuz hazir degil (1 tur/1 saat veri birikmeli) → tahmine dus
  if (h) h.textContent = fmtR(hourly);
  if (d) d.textContent = fmtR(daily);
  const isEnEst = settings.languageMode === 'en';
  if (lbl) { lbl.textContent = 'Est.'; lbl.title = isEnEst ? 'Estimated (bandwidth) — while the real rate is being measured' : 'Tahmini (bant genişliği) — gerçek hız ölçülürken'; }
  if (rr) {
    const bwStr = myBw > 0 ? `BW: ${myBw.toFixed(1)} Mb/s` : (isEnEst ? 'BW: awaiting data' : 'BW: veri bekleniyor');
    const realStr = real && real.total > 0 ? (isEnEst ? ` · Real total: ${real.total.toFixed(4)} ANYONE (measuring rate…)` : ` · Gerçek toplam: ${real.total.toFixed(4)} ANYONE (hız ölçülüyor…)`) : '';
    rr.title = isEnEst
      ? `Estimate · ${bwStr} · Fleet pay: ${totalBw > 0 ? (myBw / totalBw * 100).toFixed(2) : '—'}%${realStr}`
      : `Tahmin · ${bwStr} · Fleet pay: ${totalBw > 0 ? (myBw / totalBw * 100).toFixed(2) : '—'}%${realStr}`;
  }
}

function updateAllCardRewards() {
  if ((!window._aoTps || !window._aoTotalRelays) && !window._aoFpRewards) return;
  for (const srv of (servers || [])) updateCardReward(srv.name);
  applyRewardFlags();
}

// --- akran-altı kazanç bayrağı (peer-relative reward outlier) ---
// Bir relay, bant genişliği normal ve uptime olgun olmasına rağmen filo
// medyanının belirgin altında kazanıyorsa işaretlenir → muhtemel uptime-streak
// / consensus sorunu. SADECE gerçek zincir verisi (real.ready) olanlar kıyaslanır;
// tahmini değerler bant genişliğiyle orantılı olduğu için outlier üretemez.
const REWARD_OUTLIER_FRACTION = 0.6;        // günlük < medyanın %60'ı → düşük
const REWARD_OUTLIER_MIN_BW_FRACTION = 0.7; // bw >= medyanın %70'i → düşük bw sebep değil
const REWARD_OUTLIER_MIN_DAYS = 3;          // olgun (ilk rampa gürültüsü dışı)

function _median(arr) {
  const s = arr.filter(x => x > 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _relayBwAvg(name) {
  const st = snaps.get(name);
  const rx = (st && st.rxHist.length) ? st.rxHist.reduce((a, b) => a + b, 0) / st.rxHist.length : 0;
  const tx = (st && st.txHist.length) ? st.txHist.reduce((a, b) => a + b, 0) / st.txHist.length : 0;
  return rx + tx;
}

function _relayDailyReal(name) {
  const fp = (relayFingerprintCache.get(name) || ((snaps.get(name) || {}).last || {}).fingerprint || '').toUpperCase();
  const real = (fp && window._aoFpRewards) ? window._aoFpRewards[fp] : null;
  if (real && real.ready && real.daily != null && Number(real.daily) > 0) return Number(real.daily);
  return null;
}

function computeRewardOutliers() {
  const rows = [];
  for (const srv of (servers || [])) {
    const daily = _relayDailyReal(srv.name);
    if (daily == null) continue;
    rows.push({ name: srv.name, daily, bw: _relayBwAvg(srv.name), days: _uptimeDaysForReward(srv.name) });
  }
  const flags = {};
  if (rows.length < 4) return flags; // kıyas için anlamlı bir akran grubu gerekli
  const medDaily = _median(rows.map(r => r.daily));
  const medBw = _median(rows.map(r => r.bw));
  for (const r of rows) {
    const lowReward = medDaily > 0 && r.daily < medDaily * REWARD_OUTLIER_FRACTION;
    const bwOk = medBw <= 0 || r.bw >= medBw * REWARD_OUTLIER_MIN_BW_FRACTION;
    const mature = r.days >= REWARD_OUTLIER_MIN_DAYS;
    if (lowReward && bwOk && mature) {
      flags[r.name] = { pct: Math.round((1 - r.daily / medDaily) * 100), daily: r.daily, med: medDaily, days: r.days, bw: r.bw };
    }
  }
  return flags;
}

function applyRewardFlags() {
  const flags = computeRewardOutliers();
  for (const srv of (servers || [])) {
    const card = document.querySelector(`.cockpit-card[data-name="${cssEscape(srv.name)}"]`);
    if (!card) continue;
    const el = card.querySelector('.rw-flag');
    if (!el) continue;
    const f = flags[srv.name];
    if (f) {
      el.textContent = `⚠ %${f.pct}↓`;
      el.classList.add('show');
      el.title = settings.languageMode === 'en'
        ? `Below-peer earnings: ~${f.pct}% under the fleet's daily reward median `
          + `(median ${f.med.toFixed(4)} · this relay ${f.daily.toFixed(4)} ANYONE). `
          + `Bandwidth is normal (${f.bw.toFixed(1)} Mb/s), uptime ${f.days.toFixed(1)} days → `
          + `the drop is NOT from bandwidth. Likely uptime-streak/consensus issue, check it.`
        : `Akran-altı kazanç: günlük ödül filo medyanının ~%${f.pct} altında `
          + `(medyan ${f.med.toFixed(4)} · bu relay ${f.daily.toFixed(4)} ANYONE). `
          + `Bant genişliği normal (${f.bw.toFixed(1)} Mb/s), uptime ${f.days.toFixed(1)} gün → `
          + `düşüş bandwidth'ten DEĞİL. Muhtemel uptime-streak/consensus sorunu, kontrol et.`;
      card.classList.add('reward-outlier');
    } else {
      el.textContent = '';
      el.classList.remove('show');
      el.title = '';
      card.classList.remove('reward-outlier');
    }
  }
  renderLowEarnList(flags);
}

// Araçlar sekmesindeki "Düşük Kazanan Relay'ler" özet listesi
function renderLowEarnList(flags) {
  const listEl = document.getElementById('lowEarnList');
  const sumEl = document.getElementById('lowEarnSummary');
  if (!listEl) return;
  if (!flags) flags = computeRewardOutliers();
  const items = Object.keys(flags)
    .map(name => ({ name, ...flags[name] }))
    .sort((a, b) => b.pct - a.pct); // en kötü en üstte

  const hasRealData = (servers || []).some(s => _relayDailyReal(s.name) != null);
  const isEnLow = settings.languageMode === 'en';
  if (sumEl) {
    if (!hasRealData) sumEl.textContent = isEnLow ? 'awaiting real reward data…' : 'gerçek ödül verisi bekleniyor…';
    else sumEl.textContent = items.length
      ? (isEnLow ? `${items.length} relays flagged` : `${items.length} relay işaretlendi`)
      : (isEnLow ? 'clean — no relays flagged' : 'temiz — işaretli relay yok');
    sumEl.className = 'low-earn-sum' + (items.length ? ' warn' : (hasRealData ? ' ok' : ''));
  }

  if (!hasRealData) {
    listEl.innerHTML = isEnLow
      ? `<div class="low-earn-empty">No real on-chain reward data yet. Keep the Relays tab open for ~1 round (1 hour); the list fills in once the rate is measured.</div>`
      : `<div class="low-earn-empty">Henüz gerçek zincir ödül verisi yok. Röleler sekmesini ~1 tur (1 saat) açık tut, hız ölçülünce liste dolacak.</div>`;
    return;
  }
  if (!items.length) {
    listEl.innerHTML = isEnLow
      ? `<div class="low-earn-empty ok">✓ All mature relays in the fleet are earning close to their peer median.</div>`
      : `<div class="low-earn-empty ok">✓ Filodaki olgun relay'lerin hepsi akran medyanına yakın kazanıyor.</div>`;
    return;
  }
  listEl.innerHTML = items.map(it => `
    <div class="low-earn-item" data-name="${escapeHtml(it.name)}">
      <span class="le-name">${escapeHtml(it.name)}</span>
      <span class="le-pct">%${it.pct}↓</span>
      <span class="le-detail">${it.daily.toFixed(4)} / medyan ${it.med.toFixed(4)} ANYONE</span>
      <span class="le-detail">BW ${it.bw.toFixed(1)} Mb/s · up ${it.days.toFixed(1)}g</span>
    </div>`).join('');
  listEl.querySelectorAll('.low-earn-item').forEach(row => {
    row.addEventListener('click', () => {
      const nm = row.dataset.name;
      const btn = [...document.querySelectorAll('.tabs button')].find(b => b.dataset.tab === 'dashboard');
      if (btn) btn.click();
      const card = document.querySelector(`.cockpit-card[data-name="${cssEscape(nm)}"]`);
      if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.classList.add('flash-highlight'); setTimeout(() => card.classList.remove('flash-highlight'), 1600); }
    });
  });
}

async function loadPerRelayRewards() {
  if (!window.api.fetchAoFingerprintRewards) return;
  try {
    // Kullanicinin fingerprint'leri ve cuzdanlari — KESIN hesaplama icin gonder
    const fps = [];
    for (const srv of (servers || [])) {
      const st = snaps.get(srv.name);
      const fp = relayFingerprintCache.get(srv.name) || (st && st.last && st.last.fingerprint) || '';
      if (fp) fps.push(fp);
    }
    const wallets = [...new Set((servers || []).map(s => s.wallet).filter(w => w && w.startsWith('0x')))];
    const res = await window.api.fetchAoFingerprintRewards(fps, wallets);
    if (!res || !res.ok) return;
    window._aoTps = res.tps;
    window._aoTotalRelays = res.totalActiveRelays;
    window._aoFpShares = res.fpShares || {};
    window._aoFpRewards = res.fpRewards || {};      // KESIN: fp -> {total, hourly, daily, ready}
    window._aoWalletTotals = res.walletTotals || {}; // KESIN: wallet -> {accumulated, claimed, unclaimed}
    updateAllCardRewards();
    updateRealFleetTotals();
    persistTodayReward();
  } catch(e) { /* silent */ }
}

// --- Kalıcı günlük gelir trendi ---
function _todayKey() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Bugünün ölçülen günlük ödül HIZINI kaydet (gün-içi birikim değil → snapshot saati yanılgısı olmaz)
async function persistTodayReward() {
  if (!window.api.appendRewardHistory || !window._aoFpRewards) return;
  const fr = window._aoFpRewards;
  // Projeksiyon hızı (referans) + GERÇEK on-chain birikmiş toplam (asıl ölçüt)
  let fleetDaily = 0; const perRelay = {}; let accFromFps = 0;
  for (const fp in fr) {
    accFromFps += Number(fr[fp].total) || 0;
    if (fr[fp].ready && fr[fp].daily != null) {
      const v = Number(fr[fp].daily) || 0;
      if (v > 0) { fleetDaily += v; perRelay[fp] = v; }
    }
  }
  // Cüzdan birikmiş toplamı varsa onu kullan (en güvenilir), yoksa fp toplamları
  const wt = window._aoWalletTotals || {};
  let wAcc = 0, hasWallet = false;
  for (const w in wt) { hasWallet = true; wAcc += Number(wt[w].accumulated) || 0; }
  const fleetAccum = hasWallet ? wAcc : accFromFps;
  if (fleetAccum <= 0 && fleetDaily <= 0) return; // gerçek veri henüz yok
  try { await window.api.appendRewardHistory({ day: _todayKey(), fleetDaily, fleetAccum, perRelay, ts: Date.now() }); } catch {}
  renderRewardTrendPanel();
}

function _drawHistSpark(cvs, vals) {
  const ctx = cvs.getContext('2d');
  const w = cvs.width, h = cvs.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();
  if (!vals.length) return;
  const max = Math.max(...vals) * 1.1 || 1;
  const min = Math.min(...vals) * 0.9;
  const span = Math.max(1e-9, max - min);
  const step = vals.length > 1 ? w / (vals.length - 1) : w;
  ctx.strokeStyle = '#34d399';
  ctx.fillStyle = 'rgba(52,211,153,0.14)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / span) * (h - 12) - 6;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.lineTo((vals.length - 1) * step, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fill();
  // son nokta vurgusu
  const lastX = (vals.length - 1) * step;
  const lastY = h - ((vals[vals.length - 1] - min) / span) * (h - 12) - 6;
  ctx.fillStyle = '#34d399';
  ctx.beginPath(); ctx.arc(lastX, lastY, 2.6, 0, Math.PI * 2); ctx.fill();
}

async function renderRewardTrendPanel() {
  const cvs = document.getElementById('rewardHistCanvas');
  const sumEl = document.getElementById('rewardHistSummary');
  if (!cvs && !sumEl) return;
  let res = {};
  try { res = (await window.api.getRewardHistory()) || {}; } catch {}
  const days = res.days || {};
  const samples = (Array.isArray(res.samples) ? res.samples.slice() : []).filter(s => s && s.ts && s.accum > 0).sort((a, b) => a.ts - b.ts);
  const keys = Object.keys(days).sort();
  const rows = keys.map(k => ({ day: k, accum: Number(days[k].fleetAccum) || 0 }));
  const todayKey = _todayKey();

  // Günlük GERÇEK kazanç = birikmiş Σ toplamın gün-gün farkı
  const deltas = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].accum > 0 && rows[i - 1].accum > 0) deltas.push({ day: rows[i].day, v: Math.max(0, rows[i].accum - rows[i - 1].accum) });
  }

  // Saatlik GERÇEK kazanç = ardışık Σ örneklerinin farkı / geçen saat
  let hourlyRate = null, hourlyWindowH = 0;
  if (samples.length >= 2) {
    const L = samples[samples.length - 1];
    let O = null;
    for (let i = samples.length - 2; i >= 0; i--) { if ((L.ts - samples[i].ts) >= 30 * 60000) { O = samples[i]; break; } }
    if (!O) O = samples[0];
    const hrs = (L.ts - O.ts) / 3600000;
    if (hrs >= 0.4 && L.accum >= O.accum) { hourlyRate = (L.accum - O.accum) / hrs; hourlyWindowH = hrs; }
  }

  // --- Saatlik kutusu ---
  const isEnHist = settings.languageMode === 'en';
  const hEl = $('#rhHourly'), hSub = $('#rhHourlySub');
  if (hEl) {
    if (hourlyRate != null) {
      hEl.textContent = isEnHist ? `${hourlyRate.toFixed(3)} ANYONE/hour` : `${hourlyRate.toFixed(3)} ANYONE/saat`;
      if (hSub) hSub.textContent = isEnHist ? `from last ${hourlyWindowH.toFixed(1)}h Σ difference` : `son ${hourlyWindowH.toFixed(1)}h Σ farkından`;
    } else {
      hEl.textContent = isEnHist ? 'measuring…' : 'ölçülüyor…';
      if (hSub) hSub.textContent = isEnHist
        ? (samples.length ? 'awaiting 2nd sample (~1 hour)' : 'awaiting data')
        : (samples.length ? '2. örnek bekleniyor (~1 saat)' : 'veri bekleniyor');
    }
  }

  // --- Günlük kutusu ---
  const dEl = $('#rhDaily'), dSub = $('#rhDailySub');
  if (dEl) {
    const completeDeltas = deltas.filter(d => d.day < todayKey); // tamamlanmış günler
    const todayDelta = deltas.find(d => d.day === todayKey);
    if (completeDeltas.length) {
      // MOST RELIABLE: real 24h Σ difference of a completed day (24-epoch aligned)
      const last = completeDeltas[completeDeltas.length - 1];
      dEl.textContent = isEnHist ? `${last.v.toFixed(3)} ANYONE/day` : `${last.v.toFixed(3)} ANYONE/gün`;
      let sub = isEnHist ? `last full day (${last.day})` : `son tam gün (${last.day})`;
      if (todayDelta) sub += isEnHist ? ` · today so far ${todayDelta.v.toFixed(3)}` : ` · bugün şu ana dek ${todayDelta.v.toFixed(3)}`;
      if (dSub) dSub.textContent = sub;
    } else if (samples.length >= 2) {
      // No full day yet → NOT a single hour, average over the window of all current samples
      const span = (samples[samples.length - 1].ts - samples[0].ts) / 3600000;
      const grow = samples[samples.length - 1].accum - samples[0].accum;
      if (span >= 3 && grow >= 0) {
        dEl.textContent = isEnHist ? `~${(grow / span * 24).toFixed(2)} ANYONE/day` : `~${(grow / span * 24).toFixed(2)} ANYONE/gün`;
        if (dSub) dSub.textContent = isEnHist ? `estimated from ${span.toFixed(1)}h of measurement · locks in tomorrow as a full day` : `${span.toFixed(1)}h ölçüm ortalamasından tahmin · tam gün yarın kesinleşir`;
      } else {
        dEl.textContent = isEnHist ? 'measuring…' : 'ölçülüyor…';
        if (dSub) dSub.textContent = isEnHist
          ? `a single hour isn't reliable (epoch jumps) — need a few hours · currently ${span.toFixed(1)}h, +${grow.toFixed(3)} Σ`
          : `tek saat güvenilmez (epoch sıçramalı) — birkaç saat gerekli · şu an ${span.toFixed(1)}h, +${grow.toFixed(3)} Σ`;
      }
    } else {
      dEl.textContent = isEnHist ? 'day 2 needed' : '2. gün gerekli';
      if (dSub) dSub.textContent = isEnHist ? 'the first real daily value appears tomorrow' : 'yarın ilk gerçek günlük değer çıkar';
    }
  }

  // --- Özet satırı + sparkline ---
  const accNow = rows.length ? rows[rows.length - 1].accum : 0;
  if (sumEl) {
    sumEl.textContent = accNow > 0
      ? (isEnHist ? `Σ accumulated ${accNow.toFixed(2)} ANYONE · ${samples.length} samples · ${rows.length} days of history` : `Σ birikmiş ${accNow.toFixed(2)} ANYONE · ${samples.length} örnek · ${rows.length} gün geçmiş`)
      : (isEnHist ? 'Awaiting real on-chain data — keep the Relays tab open for ~1 round.' : 'Gerçek zincir verisi bekleniyor — Röleler sekmesini ~1 tur açık tut.');
    sumEl.className = 'rh-sum';
  }
  if (cvs) _drawHistSpark(cvs, deltas.map(s => s.v));
}

// Fleet ozetini GERCEK zincir verisiyle gunceller (hazir oldugunda tahmini ezer).
function updateRealFleetTotals() {
  const fr = window._aoFpRewards || {};
  const wt = window._aoWalletTotals || {};
  let realHourly = 0, readyCount = 0, totalFps = 0, accFromFps = 0;
  for (const fp in fr) {
    totalFps++;
    accFromFps += Number(fr[fp].total) || 0;
    if (fr[fp].ready && fr[fp].hourly != null) { realHourly += Number(fr[fp].hourly) || 0; readyCount++; }
  }
  let wAcc = 0, wClaimed = 0, wUnclaimed = 0, hasWallet = false;
  for (const w in wt) { hasWallet = true; wAcc += Number(wt[w].accumulated) || 0; wClaimed += Number(wt[w].claimed) || 0; wUnclaimed += Number(wt[w].unclaimed) || 0; }
  // Cogu relay (>=%50) gercek hiz uretmisse fleet hizini gercekle goster
  const rateReady = totalFps > 0 && readyCount >= Math.max(1, Math.floor(totalFps * 0.5));
  window._aoRealFleet = { hourly: realHourly, rateReady, accumulated: hasWallet ? wAcc : accFromFps, claimed: wClaimed, unclaimed: wUnclaimed, hasWallet };

  const fmt = (typeof fmtAnyoneAmount === 'function') ? fmtAnyoneAmount : (x) => Number(x || 0).toFixed(4);
  const setTxt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  if (rateReady) {
    setTxt('#fleetTotalHourly', fmt(realHourly) + ' ANYONE');
    setTxt('#fleetTotalDaily', fmt(realHourly * 24) + ' ANYONE');
    setTxt('#fleetTotalMonthly', fmt(realHourly * 24 * 30) + ' ANYONE');
    setTxt('#adSumHourly', fmt(realHourly) + ' ANYONE');
    setTxt('#adSumDaily', fmt(realHourly * 24) + ' ANYONE');
    setTxt('#adSumMonthly', fmt(realHourly * 24 * 30) + ' ANYONE');
  }
  if (hasWallet) {
    // Gercek birikmis / talep edilmemis — varsa ilgili alanlara yaz (yoksa no-op)
    setTxt('#fleetRealAccumulated', fmt(wAcc) + ' ANYONE');
    setTxt('#fleetRealUnclaimed', fmt(wUnclaimed) + ' ANYONE');
    setTxt('#fleetRealClaimed', fmt(wClaimed) + ' ANYONE');
  }
}

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
      <div class="relay-reward-row">
        <span class="rw-streak" title=""></span>
        <span class="rw-label">Est.</span>
        <span class="rw-hourly">—</span><span class="rw-unit">/h</span>
        <span class="rw-sep">·</span>
        <span class="rw-daily">—</span><span class="rw-unit">/day</span>
        <span class="rw-token">ANYONE</span>
        <span class="rw-flag" title=""></span>
        <span class="rw-total" title="Real earned total"></span>
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
            if (!install || !install.ok) throw new Error((install && install.error) || (settings.languageMode === 'en' ? 'Could not install HTTPS agent' : 'HTTPS agent kurulamadı'));
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
  const health = relayHealthCache.get(name);
  const hourlyEl = card.querySelector('.hourly');
  if (hourlyEl) {
    const avgTotal = avgRx + avgTx;
    hourlyEl.textContent = `${avgTotal.toFixed(2)} Mb/s`;
    hourlyEl.className = 'mini-value hourly ' + (avgTotal > 0 ? 'ok' : (state === 'offline' ? 'err' : 'warn'));
    hourlyEl.title = health ? ([health.zeroReason, health.rewardWarning, health.error].filter(Boolean).join(' · ') || 'Average traffic') : 'Average traffic';
  }

  const anonOkNow = isAnonActive(current);
  if (current.anon && anonState) anonState.textContent = anonOkNow ? 'ok' : 'down';
  setService('.https-main', state === 'offline' ? '—' : 'OK', state === 'offline' ? 'warn' : 'ok');
  setService('.anon-main', anonOkNow ? 'Active' : 'Inactive', anonOkNow ? 'ok' : 'err');
  const hasPort9001 = current.anon && Array.isArray(current.anon.ports) && current.anon.ports.some((p) => String(p).includes('9001'));
  setService('.port-main', hasPort9001 || anonOkNow ? 'Open' : '—', hasPort9001 || anonOkNow ? 'ok' : 'warn');
  setService('.family-main', state === 'offline' ? 'Unknown' : 'OK', state === 'offline' ? 'warn' : 'ok');
  updateCardFlags(name);
  updateCardTiles(card, current, state);
  updateCardReward(name);
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
  setTile('tile-anon', anonOk ? `Active${ports ? ' · ' + ports + 'p' : ''}` : 'Inactive', JSON.stringify(snap.anon || {}));
  const anonTile = card.querySelector('.tile-anon');
  if (anonTile) anonTile.classList.toggle('bad', !anonOk);
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
        : `Kesintisiz online: ~${days.toFixed(1)} gün · tahmini çarpan ~${mult}`
          + (next ? ` · sonraki tier ${next}g'de (${Math.max(0, next - days).toFixed(1)}g kaldı). Bir kesinti streak'i SIFIRLAR.`
                  : ' · en üst tier 🎉')
          + `\n⚠ Bu değer BU MONİTÖRÜN gözlemine dayanır (monitör kapalıyken olan kesintileri göremez) — Anyone'ın resmi tier'ı değildir. Resmi uptime score için Anyone dashboard.`;
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
        : `${srv.name} — ${d.toFixed(1)}g → ${nt}g tier'ına ${(nt - d).toFixed(1)}g kaldı`);
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
      : `Ortalama kesintisiz uptime streak (online relay'ler): ${avgStreak.toFixed(1)} gün\n`
        + `Ödül tier dağılımı → 5x: ${tierCount['5x']} · 3x: ${tierCount['3x']} · 2x: ${tierCount['2x']} · 1x: ${tierCount['1x']}\n`
        + `Streak = kesintisiz online gün; bir kesinti SIFIRLAR. (Bu monitörün gözlemine dayanır — resmi tier için Anyone dashboard.)`;
  }
  if (summaryLevelup) summaryLevelup.textContent = String(levelupNames.length);
  if (summaryLevelupNames) {
    summaryLevelupNames.textContent = levelupNames.length
      ? (isEnLang
        ? '⚡ Relays less than 3 days from their next reward tier — do NOT let these go offline:\n\n' + levelupNames.join('\n')
        : '⚡ Bir üst ödül çarpanına 3 günden az kalan relay\'ler — bunları KESİNTİYE UĞRATMA:\n\n' + levelupNames.join('\n'))
      : (isEnLang ? 'No relays close to leveling up a tier.' : 'Yakın tier atlayacak relay yok.');
  }
  updateSidebarCounts(servers.length, online, warn, offline);
  updateMyShareStat();
}

function updateMyShareStat() {
  const el = $('#statMyShare');
  if (!el) return;
  if (!networkStatsData || !networkStatsData.ok || !networkStatsData.totalBwGbps) {
    el.textContent = '—';
    el.title = networkStatsData && networkStatsData.error ? networkStatsData.error : 'Network bandwidth verisi bekleniyor';
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
    // Fingerprint'ler doldu — per-relay rewards'ı ve ağ verisini güncelle
    loadPerRelayRewards();
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

async function refreshTokenPrice() {
  const el = $('#tokenPriceBadge');
  if (!el) return;
  if (!windowVisible) return;
  const r = await window.api.fetchAnyoneTokenPrice();
  if (!r.ok) {
    el.textContent = 'ANYONE $—';
    el.title = r.error || (settings.languageMode === 'en' ? 'Could not fetch token price' : 'Token fiyatı alinamadi');
    return;
  }
  const price = Number(r.priceUsd || 0);
  const change = r.change24h == null ? '' : ` · ${Number(r.change24h) >= 0 ? '+' : ''}${Number(r.change24h).toFixed(2)}%`;
  el.textContent = `ANYONE $${price >= 1 ? price.toFixed(3) : price.toFixed(4)}${change}`;
  el.title = `${r.source || 'source'} · ${formatWhen(r.updatedAt)}`;
}

function renderNews(items) {
  const root = $('#newsFeed');
  if (!root) return;
  if (!items.length) {
    root.innerHTML = `<div class="news-empty">No news found.</div>`;
    return;
  }
  root.innerHTML = items.map((item, idx) => `
    <article class="news-card">
      <div class="news-card-top">
        <span class="news-source">${escapeHtml(item.source || 'News')}</span>
        <span class="news-date">${escapeHtml(formatWhen(item.date))}</span>
      </div>
      <div class="news-title">${escapeHtml(item.title || 'Untitled')}</div>
      <div class="news-summary">${escapeHtml(item.summary || '')}</div>
      <div class="row">
        <button class="news-open" data-idx="${idx}">Open Post</button>
      </div>
    </article>
  `).join('');
  $$('.news-open', root).forEach((btn) => btn.addEventListener('click', async () => {
    const item = items[Number(btn.dataset.idx)];
    if (!item || !item.link) return;
    await window.api.openExternal(item.link);
  }));
}

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
      syncToggleLabel();
    });
  }
  syncToggleLabel();
}

async function ensureNewsLoaded(force = false) {
  const status = $('#newsStatus');
  if (!force && newsLoaded) return;
  if (!windowVisible && !force) return;
  if (status) status.textContent = 'Loading news…';
  const r = await window.api.fetchAnyoneNews();
  newsLoaded = true;
  if (!r.ok) {
    renderNews([]);
    if (status) status.textContent = r.error || 'Could not load news';
    return;
  }
  renderNews(r.items || []);
  if (status) {
    const warn = Array.isArray(r.warnings) && r.warnings.length ? ` · warning: ${r.warnings[0]}` : '';
    status.textContent = `Updated ${formatWhen(r.updatedAt)}${warn}`;
  }
}

// --- server select populate (logs tab removed) ---
function populateLogServerSelect() {
  const testSel = $('#testSel');
  const nyxSel = $('#nyxServer');
  const htopSel = $('#htopServer');
  const rewardSel = $('#rewardServer');
  const configSel = $('#configServer');
  if (testSel) testSel.innerHTML = '';
  if (nyxSel) nyxSel.innerHTML = '';
  if (htopSel) htopSel.innerHTML = '';
  if (rewardSel) rewardSel.innerHTML = '';
  if (configSel) configSel.innerHTML = '';
  for (const s of servers) {
    const o = document.createElement('option'); o.value = s.name; o.textContent = s.name;
    if (testSel) { const o2 = o.cloneNode(true); testSel.appendChild(o2); }
    if (nyxSel) { const o3 = o.cloneNode(true); nyxSel.appendChild(o3); }
    if (htopSel) { const o5 = o.cloneNode(true); htopSel.appendChild(o5); }
    if (rewardSel) { const o4 = o.cloneNode(true); rewardSel.appendChild(o4); }
    if (configSel) { const o6 = o.cloneNode(true); configSel.appendChild(o6); }
  }
  if (rewardSel && rewardSel.value === '' && servers[0]) rewardSel.value = servers[0].name;
  syncRewardWalletFromServer();
}

// --- settings tab ---
function renderSettings() {
  const tbody = $('#serversTable tbody');
  tbody.innerHTML = '';
  for (const s of servers) {
    const tr = document.createElement('tr');
    const isEnRow = settings.languageMode === 'en';
    const agentBtnLabel = s.agentEnabled ? '🟢 Agent' : (isEnRow ? '⚙ Install' : '⚙ Kur');
    const agentBtnTitle = s.agentEnabled
      ? (isEnRow ? 'Agent running — click to remove' : 'Agent çalışıyor — kaldırmak için tıkla')
      : (isEnRow ? 'Install agent (connects once via SSH)' : 'Agent kur (SSH ile bir kez bağlanır)');
    tr.innerHTML = `
      <td><input data-f="name" value="${escAttr(s.name)}"></td>
      <td><input data-f="sshAlias" value="${escAttr(s.sshAlias||'')}" placeholder="relay-1"></td>
      <td><input data-f="user" value="${escAttr(s.user||'')}" placeholder="root"></td>
      <td><input data-f="host" value="${escAttr(s.host||'')}" placeholder="1.2.3.4"></td>
      <td><input data-f="port" value="${escAttr(s.port||22)}" type="number"></td>
      <td><input data-f="key" value="${escAttr(s.key||'')}" placeholder="~/.ssh/id_ed25519"></td>
      <td><input data-f="password" value="${escAttr(s.password||'')}" type="password" placeholder="${isEnRow ? '(blank: key)' : '(boş: key)'}" autocomplete="off"></td>
      <td><input data-f="wallet" value="${escAttr(s.wallet||'')}" placeholder="0x..."></td>
      <td><button class="agent-btn" title="${escAttr(agentBtnTitle)}" style="font-size:11px;padding:2px 6px;white-space:nowrap">${agentBtnLabel}</button></td>
      <td><button class="del">✕</button></td>
    `;
    tr.querySelector('.del').addEventListener('click', () => { tr.remove(); });
    tr.querySelector('.agent-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const name = tr.querySelector('input[data-f="name"]').value.trim();
      const isEnClick = settings.languageMode === 'en';
      if (s.agentEnabled) {
        if (!confirm(isEnClick ? `Remove agent for ${name}?` : `${name} — agent kaldırılsın mı?`)) return;
        btn.textContent = '⏳'; btn.disabled = true;
        const r = await window.api.removeAgent(name);
        if (r.ok) { s.agentEnabled = false; s.agentPort = undefined; s.agentToken = undefined; s.agentScheme = undefined; renderSettings(); }
        else { btn.textContent = isEnClick ? '⚙ Install' : '⚙ Kur'; btn.disabled = false; alert((isEnClick ? 'Error: ' : 'Hata: ') + r.error); }
      } else {
        btn.textContent = '⏳'; btn.disabled = true;
        const r = await window.api.installAgent(name);
        if (r.ok) { s.agentEnabled = true; s.agentPort = r.port; s.agentToken = r.token; s.agentScheme = 'https'; renderSettings(); }
        else { btn.textContent = isEnClick ? '⚙ Install' : '⚙ Kur'; btn.disabled = false; alert((isEnClick ? 'Install error: ' : 'Kurulum hatası: ') + r.error); }
      }
    });
    tbody.appendChild(tr);
  }
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
  updateNetworkBadge();
  renderQuickControls();
  refreshHeaderBadges();
}
const languageModeEl = $('#languageMode');
if (languageModeEl) {
  const applySelectedLanguage = async () => {
    const next = languageModeEl.value === 'en' ? 'en' : 'tr';
    settings = { ...settings, languageMode: next };
    languageModeEl.value = next;
    applyLanguage(next);
    try { await window.api.saveSettings(settings); } catch {}
  };
  languageModeEl.addEventListener('change', applySelectedLanguage);
  languageModeEl.addEventListener('input', applySelectedLanguage);
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
  });
}
async function refreshLicenseStatus() {
  const row = $('#licenseStatusRow');
  const entryRow = $('#licenseEntryRow');
  if (!row) return;
  try {
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
$('#addServer').addEventListener('click', () => {
  servers.push({ name: 'new', sshAlias: '', user: '', host: '', port: 22, key: '', password: '', wallet: '' });
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
    const existing = servers.find(s => s.name === obj.name);
    if (existing && existing.agentEnabled) {
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
  if (!next.length) return alert(isEnAll ? 'No relays to install.' : 'Kurulacak relay yok.');
  servers = next;
  await window.api.saveServers(next);
  if (!confirm(isEnAll ? `Install HTTPS agent on all relays? (${next.length})` : `Tum relay'lere HTTPS agent kurulsun mu? (${next.length} adet)`)) return;
  const oldText = btn.textContent;
  btn.textContent = '⏳ Installing...';
  btn.disabled = true;
  const r = await window.api.installAgentAll();
  btn.textContent = oldText;
  btn.disabled = false;
  if (!r.ok) return alert((isEnAll ? 'Install error: ' : 'Kurulum hatası: ') + (r.error || (isEnAll ? 'unknown error' : 'bilinmeyen hata')));
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
  const languageMode = $('#languageMode').value === 'en' ? 'en' : 'tr';
  const alarmEnabled = !!$('#alarmEnabled').checked;
  const alarmSound = $('#alarmSound').value || 'Hero';
  const alarmRepeatMinutes = Math.max(1, Math.min(60, Number($('#alarmRepeatMinutes').value) || 5));
  const ramWarnPct = $('#ramWarnPct') ? Math.max(70, Math.min(99, Number($('#ramWarnPct').value) || 90)) : (settings.ramWarnPct || 90);
  const dashboardTiles = {
    uptime: !!$('#tileUptime').checked,
    pubip: !!$('#tilePubip').checked,
    anon: !!$('#tileAnon').checked,
    nic: !!$('#tileNic').checked,
    load: !!$('#tileLoad').checked,
  };
  const allowedStyles = ['vivid', 'neon', 'pastel', 'flat', 'glass', 'alien', 'predator', 'aurora'];
  const dashboardTileStyle = allowedStyles.includes($('#tileStyle').value) ? $('#tileStyle').value : 'vivid';
  settings = { ...settings, pollMs, logLines, defaultNetworkMode, languageMode, alarmEnabled, alarmSound, alarmRepeatMinutes, ramWarnPct, dashboardTiles, dashboardTileStyle };
  await window.api.saveSettings(settings);
  applyLanguage(languageMode);
  updateNetworkBadge();
  renderQuickControls();
  applyTileVisibility();
  applyTileStyle();
  pushOpsEvent(`Default network saved as ${defaultNetworkMode === 'direct' ? 'Direct' : 'Anyone'}`);
  flash($('#saveSettings'), 'Saved');
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

function extractWallet(text) {
  const m = String(text || '').match(/0x[a-fA-F0-9]{40}/);
  return m ? m[0] : '';
}

function pushRewardHistory(serverName, amount) {
  if (amount == null || Number.isNaN(Number(amount))) return;
  const arr = rewardHistory.get(serverName) || [];
  arr.push(Number(amount));
  while (arr.length > 24) arr.shift();
  rewardHistory.set(serverName, arr);
}

function drawRewardTrend(serverName) {
  const cvs = $('#rewardTrend');
  if (!cvs) return;
  const ctx = cvs.getContext('2d');
  const w = cvs.width, h = cvs.height;
  ctx.clearRect(0, 0, w, h);
  const data = rewardHistory.get(serverName) || [];
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();
  if (!data.length) return;
  const max = Math.max(1, ...data);
  const step = w / Math.max(data.length - 1, 1);
  ctx.strokeStyle = getCss('--accent');
  ctx.fillStyle = 'rgba(125,211,252,0.18)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = i * step;
    const y = h - (data[i] / max) * (h - 8) - 4;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.lineTo((data.length - 1) * step, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
}

function renderRewardHint(r) {
  const hint = $('#rewardHint');
  if (!hint) return;
  if (!r || !r.fingerprint) {
    hint.textContent = 'Claim status and reward data appear here after the last refresh.';
    return;
  }
  if (r.claimed === false) {
    hint.textContent = 'Relay is bound to a wallet but does not appear claimed. You may need to claim it via the dashboard.';
    return;
  }
  if (r.claimed === true) {
    hint.textContent = 'Relay appears claimed. Reward and running info updated on the last refresh.';
    return;
  }
  hint.textContent = 'Claim status is unclear. Check the API warning field and the dashboard result.';
}

function renderRewardMismatch(r) {
  const el = $('#rewardMismatch');
  if (!el) return;
  const entered = ($('#rewardWallet').value || '').trim();
  const contactWallet = extractWallet(r && r.audit && r.audit.contact);
  if (entered && contactWallet && entered.toLowerCase() !== contactWallet.toLowerCase()) {
    el.hidden = false;
    el.textContent = `Wallet mismatch: app'te ${entered}, anonrc ContactInfo'da ${contactWallet}`;
    return;
  }
  el.hidden = true;
  el.textContent = '';
}

function ensureRewardAutoRefresh() {
  if (rewardRefreshTimer) clearInterval(rewardRefreshTimer);
  const chk = $('#rewardAutoRefresh');
  if (!chk || !chk.checked) return;
  rewardRefreshTimer = setInterval(() => {
    if ($('#tab-rewards') && $('#tab-rewards').classList.contains('active') && rewardFetchBtn) {
      rewardFetchBtn.click();
    }
  }, 30000);
}

function setRewardSummaryLoading(text) {
  const rewardServer = $('#rewardServer');
  const rewardServerCell = $('#rewardServerCell');
  if (rewardServerCell) rewardServerCell.textContent = rewardServer ? (rewardServer.value || '—') : '—';
  $('#rewardFingerprint').textContent = '—';
  $('#rewardWalletBound').textContent = '—';
  $('#rewardRunning').textContent = '—';
  $('#rewardConsensus').textContent = '—';
  $('#rewardAmount').textContent = '—';
  $('#rewardDate').textContent = '—';
  const claimCell = $('#rewardClaimCell');
  if (claimCell) {
    claimCell.className = 'reward-claim-cell neutral';
    claimCell.textContent = t('claim_unknown');
  }
  const badge = $('#rewardClaimedBadge');
  badge.className = 'reward-badge neutral';
  badge.textContent = text || 'claimed: unknown';
  renderRewardHint(null);
  renderRewardMismatch(null);
  drawRewardTrend('__none__');
}

function updateRewardSummary(r) {
  const rewardServerCell = $('#rewardServerCell');
  if (rewardServerCell) rewardServerCell.textContent = $('#rewardServer').value || '—';
  $('#rewardFingerprint').textContent = r.fingerprint || '—';
  $('#rewardWalletBound').textContent = r.wallet || '—';
  const latest = Array.isArray(r.latestReward) ? r.latestReward[0] : r.latestReward;
  const cw = r.lookup && (r.lookup.consensus_weight ?? r.lookup.consensusWeight);
  const running = r.lookup && (r.lookup.running ?? r.lookup.isRunning);
  const amount = latest && (latest.amount ?? latest.value);
  const date = latest && (latest.date || latest.timestamp || latest.epochDate);
  $('#rewardRunning').textContent = running == null ? 'unknown' : String(running);
  $('#rewardConsensus').textContent = cw == null ? '—' : String(cw);
  $('#rewardAmount').textContent = amount == null ? '—' : String(amount);
  $('#rewardDate').textContent = date || '—';
  pushRewardHistory($('#rewardServer').value, amount);
  drawRewardTrend($('#rewardServer').value);
  renderRewardHint(r);
  renderRewardMismatch(r);
  const badge = $('#rewardClaimedBadge');
  const claimCell = $('#rewardClaimCell');
  if (r.claimed == null) {
    badge.className = 'reward-badge neutral';
    badge.textContent = 'claimed: unknown';
    if (claimCell) {
      claimCell.className = 'reward-claim-cell neutral';
      claimCell.textContent = t('claim_unknown');
    }
  } else if (r.claimed) {
    badge.className = 'reward-badge ok';
    badge.textContent = 'claimed: yes';
    if (claimCell) {
      claimCell.className = 'reward-claim-cell ok';
      claimCell.textContent = t('claim_yes');
    }
  } else {
    badge.className = 'reward-badge err';
    badge.textContent = 'claimed: no';
    if (claimCell) {
      claimCell.className = 'reward-claim-cell err';
      claimCell.textContent = t('claim_no');
    }
  }
}

function syncRewardWalletFromServer() {
  const sel = $('#rewardServer');
  const input = $('#rewardWallet');
  if (!sel || !input) return;
  const srv = servers.find(s => s.name === sel.value);
  input.value = (srv && srv.wallet) || '';
}

async function persistRewardWallet() {
  const sel = $('#rewardServer');
  const input = $('#rewardWallet');
  if (!sel || !input) return null;
  const srv = servers.find(s => s.name === sel.value);
  if (!srv) return null;
  srv.wallet = input.value.trim();
  await window.api.saveServers(servers);
  renderSettings();
  populateLogServerSelect();
  return srv;
}

const rewardServerSel = $('#rewardServer');
if (rewardServerSel) rewardServerSel.addEventListener('change', () => { syncRewardWalletFromServer(); drawRewardTrend($('#rewardServer').value); });
const rewardAutoRefreshChk = $('#rewardAutoRefresh');
if (rewardAutoRefreshChk) rewardAutoRefreshChk.addEventListener('change', ensureRewardAutoRefresh);
const rewardAuditBtn = $('#rewardAudit');
if (rewardAuditBtn) {
  rewardAuditBtn.addEventListener('click', async () => {
    const name = $('#rewardServer').value;
    $('#rewardOut').textContent = 'audit calisiyor: ' + name + ' …';
    const r = await window.api.auditRelay(name);
    $('#rewardOut').textContent = r.ok ? ('✓ audit\n' + r.output) : ('✗ audit fail\n' + r.error);
  });
}
const rewardFetchBtn = $('#rewardFetch');
if (rewardFetchBtn) {
  rewardFetchBtn.addEventListener('click', async () => {
    const name = $('#rewardServer').value;
    const wallet = ($('#rewardWallet').value || '').trim();
    setRewardSummaryLoading('claimed: checking');
    $('#rewardApiOut').textContent = 'rewards cekiliyor: ' + name + ' …';
    const r = await window.api.fetchRelayRewards(name, wallet);
    if (!r.ok) {
      setRewardSummaryLoading('claimed: error');
      $('#rewardApiOut').textContent = '✗ rewards fail\n' + r.error;
      return;
    }
    updateRewardSummary(r);
    const lines = [];
    if (r.lookupError) lines.push(`Lookup warning: ${r.lookupError}`);
    if (r.latestRewardError) lines.push(`Reward warning: ${r.latestRewardError}`);
    if (r.minersError) lines.push(`Claim warning: ${r.minersError}`);
    $('#rewardApiOut').textContent = lines.length ? lines.join('\n') : '✓ rewards data refreshed';
  });
}

const rewardBindBtn = $('#rewardBind');
if (rewardBindBtn) {
  rewardBindBtn.addEventListener('click', async () => {
    const name = $('#rewardServer').value;
    const wallet = ($('#rewardWallet').value || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      $('#rewardOut').textContent = 'Gecersiz wallet adresi. MetaMask adresini 0x... olarak gir.';
      return;
    }
    await persistRewardWallet();
    $('#rewardOut').textContent = 'wallet bind calisiyor: ' + name + ' …';
    const r = await window.api.bindRelayWallet(name, wallet);
    $('#rewardOut').textContent = r.ok ? ('✓ wallet bound\n' + r.output) : ('✗ bind fail\n' + r.error);
    if (r.ok && rewardFetchBtn) rewardFetchBtn.click();
  });
}
const rewardDashboardBtn = $('#rewardDashboard');
if (rewardDashboardBtn) rewardDashboardBtn.addEventListener('click', async () => {
  await window.api.openRewardsDashboard();
});

const rewardCopyFingerprintBtn = $('#rewardCopyFingerprint');
if (rewardCopyFingerprintBtn) {
  rewardCopyFingerprintBtn.addEventListener('click', async () => {
    const fp = ($('#rewardFingerprint').textContent || '').trim();
    if (!fp || fp === '—') return;
    try {
      await window.api.clipboardWriteText(fp);
      flash(rewardCopyFingerprintBtn, 'Copied');
    } catch {}
  });
}

async function refreshFleetFingerprints() {
  const out = $('#fleetFingerprintOut');
  const status = $('#fleetFamilyStatus');
  if (!out) return;
  out.textContent = 'Collecting fingerprints…';
  if (status) {
    status.className = 'fleet-status';
    status.textContent = 'Checking family status…';
  }
  const r = await window.api.fetchRelayFingerprints();
  if (!r.ok) {
    out.textContent = '✗ ' + (r.error || 'error');
    if (status) {
      status.className = 'fleet-status warn';
      status.textContent = r.error || 'Could not check family status.';
    }
    return;
  }
  for (const row of (r.rows || [])) {
    if (row && row.ok && row.fingerprint) relayFingerprintCache.set(row.name, row.fingerprint);
  }
  out.textContent = (r.rows || []).map((row) => {
    if (!row.ok) return `${row.name}\tFAIL\t${row.error || 'audit fail'}`;
    const bits = [row.name, row.fingerprint || '-', row.wallet || '-'];
    if (row.nickname) bits.push(`nick=${row.nickname}`);
    return bits.join('\t');
  }).join('\n');
  out.dataset.copyText = r.copyText || '';
  out.dataset.myFamilyText = 'MyFamily ' + (r.rows || [])
    .filter((row) => row.ok && row.fingerprint)
    .map((row) => `$${String(row.fingerprint || '').replace(/^\$/, '')}`)
    .join(',');
  const plan = await window.api.fetchRelayFamilyPlan();
  if (status) {
    if (!plan.ok) {
      status.className = 'fleet-status warn';
      status.textContent = plan.error || 'Could not check family drift.';
    } else {
      const driftRows = (plan.rows || []).filter((row) => row.ok && !row.familyUpToDate);
      const failRows = (plan.rows || []).filter((row) => !row.ok);
      if (failRows.length) {
        status.className = 'fleet-status warn';
        status.textContent = `${failRows.length} relays failed the fingerprint/SSH check. Fix those first, then run Preview Family.`;
      } else if (driftRows.length) {
        status.className = 'fleet-status warn';
        status.textContent = `${driftRows.length} relays are missing/outdated MyFamily. Run Preview Family then Apply Family All.`;
      } else {
        status.className = 'fleet-status ok';
        status.textContent = 'MyFamily looks up to date on all relays.';
      }
    }
  }
  for (const srv of servers) updateCardFlags(srv.name);
}

async function previewFleetMyFamily() {
  const out = $('#fleetFingerprintOut');
  const status = $('#fleetFamilyStatus');
  if (!out) return;
  out.textContent = 'Preparing MyFamily plan…';
  const r = await window.api.fetchRelayFamilyPlan();
  if (!r.ok) {
    out.textContent = '✗ ' + (r.error || 'family plan error');
    if (status) {
      status.className = 'fleet-status warn';
      status.textContent = r.error || 'Could not prepare family preview.';
    }
    return;
  }
  out.textContent = (r.rows || []).map((row) => {
    if (!row.ok) return `${row.name}\tFAIL\t${row.error || 'family plan fail'}`;
    const drift = row.familyUpToDate ? 'OK' : 'OUTDATED';
    return `${row.name}\t${drift}\tself=${row.fingerprint}\tfamily=${row.familyCount}\tcurrent=${row.currentFamilyLine || 'MyFamily -'}\texpected=${row.familyLine || 'MyFamily -'}`;
  }).join('\n');
  if (status) {
    const driftRows = (r.rows || []).filter((row) => row.ok && !row.familyUpToDate);
    const failRows = (r.rows || []).filter((row) => !row.ok);
    if (failRows.length) {
      status.className = 'fleet-status warn';
      status.textContent = `${failRows.length} relays didn't return a fingerprint. Fix SSH/fingerprint errors before applying.`;
    } else if (driftRows.length) {
      status.className = 'fleet-status warn';
      status.textContent = `${driftRows.length} relays are missing/outdated MyFamily. The old MyFamily line will be replaced with a fresh one.`;
    } else {
      status.className = 'fleet-status ok';
      status.textContent = 'MyFamily is up to date on all relays.';
    }
  }
}

async function applyFleetMyFamily() {
  const out = $('#fleetFingerprintOut');
  const status = $('#fleetFamilyStatus');
  if (!out) return;
  const plan = await window.api.fetchRelayFamilyPlan();
  const failed = (plan.rows || []).filter((row) => !row.ok);
  if (failed.length) {
    out.textContent = failed.map((row) => `${row.name}\tFAIL\t${row.error || 'no fingerprint'}`).join('\n');
    if (status) {
      status.className = 'fleet-status warn';
      status.textContent = `${failed.length} relays didn't return a fingerprint. Apply stopped; fix these relays first.`;
    }
    return;
  }
  const driftRows = (plan.rows || []).filter((row) => row.ok && !row.familyUpToDate);
  const msg = `MyFamily will be written for ${plan.rows.length} relays.\n\nOld MyFamily lines will be removed and one clean new line added.\nEach relay's own fingerprint is left out of its own list.\nVerify + restart will run.\n\nOut of date relays: ${driftRows.length}\nContinue?`;
  if (!confirm(msg)) return;
  out.textContent = 'Applying MyFamily…';
  const r = await window.api.applyRelayFamilyAll();
  if (!r.ok && !Array.isArray(r.results)) {
    out.textContent = '✗ ' + (r.error || 'family apply failed');
    if (status) {
      status.className = 'fleet-status warn';
      status.textContent = r.error || 'Family apply failed.';
    }
    return;
  }
  out.textContent = (r.results || []).map((row) => {
    if (!row.ok) return `✗ ${row.name}\t${row.error || 'fail'}`;
    const bits = [];
    if (row.familyCount != null) bits.push(`family=${row.familyCount}`);
    if (row.verify) bits.push(`verify=${row.verify}`);
    if (row.restarted) bits.push(`restart=${row.restarted}`);
    if (row.active) bits.push(`active=${row.active}`);
    return `✓ ${row.name}\t${bits.join('\t')}`;
  }).join('\n');
  if (status) {
    status.className = r.ok ? 'fleet-status ok' : 'fleet-status warn';
    status.textContent = r.dryRunStopped
      ? `${r.blockedCount || 0} relays failed the SSH/config precheck. No relay was changed.`
      : `MyFamily applied for ${r.okCount || 0}/${r.count || 0} relays.`;
  }
  if (r.ok) {
    const verifyPlan = await window.api.fetchRelayFamilyPlan();
    if (status && verifyPlan.ok) {
      const verifyDrift = (verifyPlan.rows || []).filter((row) => row.ok && !row.familyUpToDate);
      status.className = verifyDrift.length ? 'fleet-status warn' : 'fleet-status ok';
      status.textContent = verifyDrift.length
        ? `Apply finished but ${verifyDrift.length} relays still look outdated. Check with Preview Family.`
        : 'Apply finished: MyFamily looks up to date on all relays.';
    }
  }
}

function renderFleetHealthSummary(r) {
  const totals = r && r.totals ? r.totals : {};
  const set = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };
  set('#fleetTotalHourly', fmtAnyoneAmount(totals.hourly) + ' ANYONE');
  set('#fleetTotalDaily', fmtAnyoneAmount(totals.daily) + ' ANYONE');
  set('#fleetTotalMonthly', fmtAnyoneAmount(totals.monthly) + ' ANYONE');
  set('#fleetClaimedSummary', `${totals.claimed || 0} / ${totals.unclaimed || 0}`);
  set('#fleetLockedSummary', `${totals.locked || 0} / ${totals.earning || 0}`);
  set('#fleetMissingContact', String(totals.missingContact || 0));
  set('#fleetFamilyHealth', `${totals.missingFamily || 0} missing / ${totals.outdatedFamily || 0} outdated`);
  // Gercek zincir verisi hazirsa tahmini ez
  if (typeof updateRealFleetTotals === 'function') updateRealFleetTotals();
}

function familyHealthBadge(row) {
  if (!row.hasMyFamily) return '<span class="health-badge err">missing</span>';
  if (row.familyUpToDate === false) return '<span class="health-badge warn">outdated</span>';
  if (row.familyUpToDate === true) return '<span class="health-badge ok">ok</span>';
  return '<span class="health-badge warn">unknown</span>';
}

function claimedBadge(row) {
  if (row.claimed === true) {
    const label = row.claimSource === 'reward' ? 'claimed*' : 'claimed';
    return `<span class="health-badge ok" title="source=${escapeHtml(row.claimSource || 'unknown')}">${label}</span>`;
  }
  if (row.claimed === false) return '<span class="health-badge err">unclaimed</span>';
  return '<span class="health-badge warn">unknown</span>';
}

function lockedBadge(row) {
  if (row.locked === true) {
    const title = row.lockAmount > 0 ? `lock=${row.lockAmount}` : 'locked';
    return `<span class="health-badge ok" title="${escapeHtml(title)}">locked</span>`;
  }
  if (row.locked === false) return '<span class="health-badge err">no</span>';
  return '<span class="health-badge warn">unknown</span>';
}

function earningBadge(row) {
  return row.earning
    ? '<span class="health-badge ok">earning</span>'
    : '<span class="health-badge err">no</span>';
}

function contactBadge(row) {
  return row.hasContactInfo
    ? '<span class="health-badge ok">ok</span>'
    : '<span class="health-badge err">missing</span>';
}

function fmtEstimateCell(value, row) {
  const blocked = row && row.rewardWarning && !row.earning && Number(value || 0) === 0;
  return blocked ? '—' : fmtAnyoneAmount(value);
}

async function refreshFleetHealthRewards() {
  const tbody = $('#fleetHealthTable tbody');
  if (!windowVisible) return;
  if (tbody) tbody.innerHTML = `<tr><td colspan="10">Fleet health / earnings cekiliyor…</td></tr>`;
  const r = await window.api.fetchFleetHealthRewards();
  if (!r.ok) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="10">✗ ${escapeHtml(r.error || 'health fail')}</td></tr>`;
    return;
  }
  relayHealthCache.clear();
  (r.rows || []).forEach((row) => relayHealthCache.set(row.name, row));
  servers.forEach((srv) => updateCard(srv.name));
  renderFleetHealthSummary(r);
  const rows = (r.rows || []).slice().sort((a, b) => (Number(b.estDaily || 0) - Number(a.estDaily || 0)));
  if (!tbody) return;
  tbody.innerHTML = rows.map((row) => {
    const latest = row.latestDate
      ? `${fmtAnyoneAmount(row.latestAmount)} · ${escapeHtml(formatWhen(row.latestDate))}`
      : (row.rewardWarning ? 'api err' : fmtAnyoneAmount(row.latestAmount));
    const title = [row.zeroReason, row.rewardWarning, row.error].filter(Boolean).join(' · ');
    return `
      <tr title="${escapeHtml(title)}">
        <td><b>${escapeHtml(row.name)}</b></td>
        <td>${claimedBadge(row)}</td>
        <td>${lockedBadge(row)}</td>
        <td>${earningBadge(row)}</td>
        <td>${contactBadge(row)}</td>
        <td>${familyHealthBadge(row)}</td>
        <td>${escapeHtml(latest)}</td>
        <td>${fmtEstimateCell(row.estHourly, row)}</td>
        <td>${fmtEstimateCell(row.estDaily, row)}</td>
        <td>${fmtEstimateCell(row.estMonthly, row)}</td>
      </tr>
    `;
  }).join('');
}

const fleetFingerprintRefreshBtn = $('#fleetFingerprintRefresh');
if (fleetFingerprintRefreshBtn) {
  fleetFingerprintRefreshBtn.addEventListener('click', refreshFleetFingerprints);
}

// ===== Güvenlik / Sertleştirme paneli =====
function secRenderTable(res) {
  const wrap = $('#secTableWrap');
  if (!wrap) return;
  const badge = (ok, txt) => `<span class="sec-badge ${ok ? 'ok' : 'bad'}">${escapeHtml(txt)}</span>`;
  const rows = (res.results || []).map((r) => {
    if (!r.ok) return `<tr class="sec-unreach"><td><b>${escapeHtml(r.name)}</b></td><td colspan="4">⚠ unreachable: ${escapeHtml(String(r.error || '').slice(0, 60))}</td><td></td></tr>`;
    const act = r.risky
      ? `<button class="sec-harden-one danger" data-name="${escapeHtml(r.name)}">Harden</button>`
      : `<span class="sec-badge ok">✓ protected</span>`;
    return `<tr class="${r.risky ? 'sec-risky' : ''}">`
      + `<td><b>${escapeHtml(r.name)}</b></td>`
      + `<td>${badge(r.f2b === 'active', 'fail2ban: ' + r.f2b)}</td>`
      + `<td>${escapeHtml(r.ban)} ban</td>`
      + `<td>${badge(r.pw !== 'yes', 'password: ' + (r.pw === 'yes' ? 'ON' : 'off'))}</td>`
      + `<td class="sec-dim">ms ${escapeHtml(r.ms)} · :${escapeHtml(r.port)}</td>`
      + `<td>${act}</td></tr>`;
  }).join('');
  wrap.innerHTML = `<table class="sec-table"><thead><tr><th>Relay</th><th>fail2ban</th><th>ban</th><th>password-auth</th><th>ssh</th><th>action</th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll('.sec-harden-one').forEach((b) => b.addEventListener('click', () => secHardenOne(b.dataset.name, b)));
}
async function secScan() {
  const status = $('#secStatus');
  const btn = $('#secScanBtn');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Scanning… (all relays, may take ~1-2 min)';
  try {
    const res = await window.api.securityScan('*ALL*');
    if (!res.ok) { if (status) status.textContent = 'Error: ' + (res.error || '?'); return; }
    if (status) status.textContent = `${res.count} relays scanned · ⚠ ${res.risky} risky · ${res.unreachable} unreachable`;
    window._secLast = res;
    secRenderTable(res);
  } catch (e) { if (status) status.textContent = 'Error: ' + e.message; }
  finally { if (btn) btn.disabled = false; }
}
async function secHardenOne(name, btn) {
  if (!confirm(`Harden ${name}?\n\nInstalls fail2ban + applies SSH DoS protection (MaxStartups/LoginGraceTime). Only affects SSH/port 22 — does not touch relay ports (9001/443/80).`)) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Hardening…'; }
  try {
    const r = await window.api.securityHarden(name);
    if (r.ok) { if (btn) { btn.textContent = '✓ done'; btn.classList.remove('danger'); } }
    else { if (btn) { btn.disabled = false; btn.textContent = 'Retry'; } alert(`Could not harden ${name}:\n${r.error || '?'}`); }
  } catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'Retry'; } alert(`${name}: ${e.message}`); }
}
const secScanBtn = $('#secScanBtn');
if (secScanBtn) secScanBtn.addEventListener('click', secScan);
const secHardenRiskyBtn = $('#secHardenRiskyBtn');
if (secHardenRiskyBtn) secHardenRiskyBtn.addEventListener('click', async () => {
  const res = window._secLast;
  if (!res || !res.results) { alert('Run "Scan All" first.'); return; }
  const risky = res.results.filter((r) => r.ok && r.risky).map((r) => r.name);
  if (!risky.length) { alert('No risky relays — all protected 🎉'); return; }
  if (!confirm(`Harden ${risky.length} risky relays?\n\n${risky.slice(0, 12).join(', ')}${risky.length > 12 ? ` … (+${risky.length - 12})` : ''}`)) return;
  const status = $('#secStatus');
  let done = 0;
  for (const name of risky) {
    if (status) status.textContent = `Hardening ${++done}/${risky.length}: ${name}…`;
    try { await window.api.securityHarden(name); } catch {}
  }
  await secScan();
});
const fleetFingerprintCopyBtn = $('#fleetFingerprintCopy');
if (fleetFingerprintCopyBtn) {
  fleetFingerprintCopyBtn.addEventListener('click', async () => {
    const out = $('#fleetFingerprintOut');
    const text = (out && out.dataset.copyText) || (out ? out.textContent : '');
    if (!text) return;
    await window.api.clipboardWriteText(text);
    flash(fleetFingerprintCopyBtn, 'Copied');
  });
}
const fleetMyFamilyCopyBtn = $('#fleetMyFamilyCopy');
if (fleetMyFamilyCopyBtn) {
  fleetMyFamilyCopyBtn.addEventListener('click', async () => {
    const out = $('#fleetFingerprintOut');
    const text = (out && out.dataset.myFamilyText) || '';
    if (!text || text === 'MyFamily ') return;
    await window.api.clipboardWriteText(text);
    flash(fleetMyFamilyCopyBtn, 'Copied');
  });
}
const fleetMyFamilyPreviewBtn = $('#fleetMyFamilyPreview');
if (fleetMyFamilyPreviewBtn) {
  fleetMyFamilyPreviewBtn.addEventListener('click', previewFleetMyFamily);
}
const fleetMyFamilyApplyBtn = $('#fleetMyFamilyApply');
if (fleetMyFamilyApplyBtn) {
  fleetMyFamilyApplyBtn.addEventListener('click', applyFleetMyFamily);
}
const fleetHealthRefreshBtn = $('#fleetHealthRefresh');
if (fleetHealthRefreshBtn) {
  fleetHealthRefreshBtn.addEventListener('click', refreshFleetHealthRewards);
}

const newsRefreshBtn = $('#newsRefresh');
if (newsRefreshBtn) newsRefreshBtn.addEventListener('click', () => ensureNewsLoaded(true));
const newsOpenXBtn = $('#newsOpenX');
if (newsOpenXBtn) newsOpenXBtn.addEventListener('click', () => window.api.openExternal('https://x.com/AnyoneFDN'));
const newsOpenTelegramBtn = $('#newsOpenTelegram');
if (newsOpenTelegramBtn) newsOpenTelegramBtn.addEventListener('click', () => window.api.openExternal('https://t.me/anyoneprotocol'));

// --- nyx tab ---
const nyxOpenBtn = $('#nyxOpen');
if (nyxOpenBtn) {
  nyxOpenBtn.addEventListener('click', async () => {
    const name = $('#nyxServer').value;
    const status = $('#nyxStatus');
    if (!name) { status.textContent = 'select a server first'; return; }
    status.textContent = 'Opening Terminal: ' + name + ' …';
    const r = await window.api.openNyx(name);
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
    status.textContent = 'Opening Terminal: ' + name + ' …';
    const r = await window.api.openHtop(name);
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
        timer = setTimeout(() => reject(new Error(`${label} zaman asimina ugradi (${Math.round(timeoutMs / 1000)}sn)`)), timeoutMs);
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

const configFirewallExitPortsBtn = $('#configFirewallExitPorts');
if (configFirewallExitPortsBtn) configFirewallExitPortsBtn.addEventListener('click', async () => {
  const EXCLUDE = ['baris1'];
  if (!confirm(`Firewall outbound ports will be opened and connection-tested on ALL servers (except ${EXCLUDE.join(', ')}).\n\nPorts: 110, 143, 993, 995, 8080, 8443, 5222, 9418, 6697\n\nContinue?`)) return;
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
  const EXCLUDE = ['baris1'];
  if (!confirm(`New exit policy ports will be added and restarted on ALL servers (except ${EXCLUDE.join(', ')}).\n\nAdded: 110, 143, 993, 995, 8080, 8443, 5222, 9418, 6697\n\nContinue?`)) return;
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
  updateAutoFixDashboard();
  refreshHeaderBadges();
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
    openaiApiKey: ($('#openaiApiKey').value || '').trim(),
    claudeApiKey: ($('#claudeApiKey').value || '').trim(),
    autoFixCommands: commands,
  };
  await window.api.saveAutoFixSettings(autoFixSettings);
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
    openaiApiKey: ($('#openaiApiKey').value || '').trim(),
    claudeApiKey: ($('#claudeApiKey').value || '').trim(),
    autoFixCommands: commands,
  };
  const out = $('#autoFixTestOut');
  if (out) out.textContent = 'Running AI test…';
  const r = await window.api.testAutoFix(draft);
  const result = r && r.result ? r.result : null;
  let msg = 'Could not get AI test result';
  if (result) {
    if (!result.ok) msg = `Test error: ${result.error || 'unknown error'}`;
    else if (result.action === 'none') msg = `AI connected, chose not to intervene: ${result.reason || 'no reason given'}`;
    else msg = `AI connected, would run: ${result.commandName || 'unknown'} (${result.reason || 'no reason given'}) [dry-run]`;
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

window.api.onFocusRelay((name) => {
  // Relay sekmesine geç
  const relayTab = document.querySelector('[data-tab="relays"]') || document.querySelector('.tab-btn');
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
        <h3>🔍 Kurulum Sağlık Kontrolü</h3>
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

/* BARIS PERF FIX: disabled experimental DOM-scanning hotfix blocks.
   They installed multiple MutationObservers and short intervals that scanned every node,
   which made the dashboard stutter with many relay cards. */

// --- Anyone Dashboard webview ---
const _wv = document.getElementById('anyonDashWebview');

function buildEthereumScript(safeWallet) {
  return `(function(){
    const W='${safeWallet}';
    async function rpc(m,p){
      const r=await fetch('https://1rpc.io/eth',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p||[]})});
      const j=await r.json();
      if(j.error)throw Object.assign(new Error(j.error.message),{code:j.error.code});
      return j.result;
    }
    const cb={};
    const p={
      isMetaMask:true,_relayMonitor:true,
      selectedAddress:W||null,chainId:'0x1',networkVersion:'1',
      request({method:m,params:ps=[]}){
        if(m==='eth_accounts'||m==='eth_requestAccounts')return Promise.resolve(W?[W]:[]);
        if(m==='eth_chainId')return Promise.resolve('0x1');
        if(m==='net_version')return Promise.resolve('1');
        if(m==='wallet_switchEthereumChain'||m==='wallet_addEthereumChain')return Promise.resolve(null);
        if(['eth_sendTransaction','personal_sign','eth_sign','eth_signTypedData_v4'].includes(m))
          return Promise.reject(Object.assign(new Error('Use Chrome+MetaMask for signing.'),{code:4001}));
        return rpc(m,ps);
      },
      on(e,f){(cb[e]=cb[e]||[]).push(f);return this;},
      once(e,f){const w=(...a)=>{f(...a);this.removeListener(e,w)};return this.on(e,w);},
      removeListener(e,f){if(cb[e])cb[e]=cb[e].filter(l=>l!==f);return this;},
      emit(e,...a){(cb[e]||[]).forEach(f=>{try{f(...a)}catch(x){}});}
    };
    if(!window.ethereum||!window.ethereum._relayMonitor){
      try{Object.defineProperty(window,'ethereum',{value:p,configurable:true,writable:false});}
      catch(e){window.ethereum=p;}
    }
    // EIP-6963: announce provider so web3modal detects us
    const detail={info:{uuid:'relay-monitor-mm',name:'MetaMask',rdns:'io.metamask',icon:''},provider:p};
    const ann=new CustomEvent('eip6963:announceProvider',{detail});
    window.dispatchEvent(ann);
    // Re-announce whenever the page re-requests providers (web3modal does this on modal open)
    if(!window._eip6963Listening){
      window._eip6963Listening=true;
      window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(ann));
    }
    p.emit('connect',{chainId:'0x1'});
    if(W)p.emit('accountsChanged',[W]);
  })();`;
}

function injectEthereum(wv) {
  const wallet = (servers && servers.find(s => s.wallet)) ? servers.find(s => s.wallet).wallet : '';
  const safeWallet = String(wallet).replace(/[^a-fA-F0-9x]/g, '');
  wv.executeJavaScript(buildEthereumScript(safeWallet)).catch(() => {});
}

const ANYON_DASH_URL = 'https://dashboard.anyone.io/#/';
let _anyonDashWvReady = false;

function initAnyonDashWebview() {
  const wv = document.getElementById('anyonDashWebview');
  if (!wv) return;
  // İlk kez: event listener ekle ve URL yükle
  if (!_anyonDashWvReady) {
    _anyonDashWvReady = true;
    // Inject on dom-ready AND repeatedly for first 3s to beat React hydration timing
    wv.addEventListener('dom-ready', () => {
      // about:blank'te inject etme
      if (wv.src && !wv.src.startsWith('about:')) injectEthereum(wv);
      setTimeout(() => { if (wv.src && !wv.src.startsWith('about:')) injectEthereum(wv); }, 500);
      setTimeout(() => { if (wv.src && !wv.src.startsWith('about:')) injectEthereum(wv); }, 1500);
      setTimeout(() => { if (wv.src && !wv.src.startsWith('about:')) injectEthereum(wv); }, 3000);
    });
    wv.src = ANYON_DASH_URL;
  } else if (!wv.src || wv.src === 'about:blank' || wv.src.startsWith('about:')) {
    // Tab'a geri dönüldü, about:blank'ten dashboard'u yeniden yükle
    try { wv.loadURL(ANYON_DASH_URL); } catch (e) { try { wv.src = ANYON_DASH_URL; } catch {} }
  } else {
    injectEthereum(wv);
  }
}

(function() {
  const wv = _wv;
  const chromeBtn = document.getElementById('anyonDashOpenChrome');
  const backBtn = document.getElementById('anyonDashBack');
  const fwdBtn = document.getElementById('anyonDashForward');
  const reloadBtn = document.getElementById('anyonDashReload');
  const urlLabel = document.getElementById('anyonDashUrl');

  if (!wv) return;

  if (backBtn) backBtn.addEventListener('click', () => { try { wv.goBack(); } catch(e){} });
  if (fwdBtn) fwdBtn.addEventListener('click', () => { try { wv.goForward(); } catch(e){} });
  if (reloadBtn) reloadBtn.addEventListener('click', () => { try { wv.reload(); } catch(e){} });
  if (chromeBtn) chromeBtn.addEventListener('click', () => {
    const url = (wv.getURL && wv.getURL()) || 'https://dashboard.anyone.io/#/';
    window.api.openExternal(url);
  });
  wv.addEventListener('did-navigate', (e) => { if (urlLabel) urlLabel.textContent = e.url || ''; });
  wv.addEventListener('did-navigate-in-page', (e) => { if (urlLabel) urlLabel.textContent = e.url || ''; });
  // Load fleet summary (online count + hourly/daily estimates) from live snaps — no network calls
  function refreshFleetSummary() {
    const fmtA = v => v > 0 ? Number(v).toLocaleString('tr-TR', {minimumFractionDigits:4, maximumFractionDigits:4}) : '—';
    const onlineCnt = Array.from(snaps.values()).filter(st => st.last && getEffectiveRelayState(st.last) === 'online').length;
    const staleCnt  = Array.from(snaps.values()).filter(st => st.last && getEffectiveRelayState(st.last) === 'stale').length;

    const el = id => document.getElementById(id);
    if (el('adSumOnline'))  el('adSumOnline').textContent  = (onlineCnt + staleCnt) + ' / ' + snaps.size;
    // Hourly/daily: use last known snaps connection counts as proxy (actual rewards from API later)
    // Try fleet health totals if already cached
    if (window._fleetTotals) {
      if (el('adSumHourly'))  el('adSumHourly').textContent  = fmtA(window._fleetTotals.hourly) + ' ANYONE';
      if (el('adSumDaily'))   el('adSumDaily').textContent   = fmtA(window._fleetTotals.daily)  + ' ANYONE';
      if (el('adSumMonthly')) el('adSumMonthly').textContent = fmtA(window._fleetTotals.monthly) + ' ANYONE';
    }
    // Gercek zincir verisi hazirsa tahmini ez
    if (typeof updateRealFleetTotals === 'function') updateRealFleetTotals();
  }

  // AO mesgulken (429) kartlarda tire yerine sebebi goster
  function markCardsAoBusy() {
    for (const card of document.querySelectorAll('.card')) {
      const lbl = card.querySelector('.rw-label');
      const h = card.querySelector('.rw-hourly');
      if (!lbl) continue;
      const txt = h ? String(h.textContent || '').trim() : '';
      if (txt && txt !== '—') continue;
      lbl.textContent = 'Meşgul';
      lbl.title = 'Anyone ödül ağı şu an yoğun (429) — birkaç dakika içinde otomatik tekrar denenecek';
    }
  }

  let _aoRetryTimer = null;

  // Fetch AO reward estimates directly from AO CU (no SSH)
  window.loadAoRewardEstimates = async function() {
    if (!window.api.fetchAoRewardEstimates) return;
    try {
      const res = await window.api.fetchAoRewardEstimates();
      if (res && res.ok && (res.hourly > 0 || res.daily > 0)) {
        window._aoBusy = false;
        window._fleetTotals = { hourly: res.hourly, daily: res.daily, monthly: res.monthly };
        refreshFleetSummary();
        return;
      }
      if (res && res.busy) {
        window._aoBusy = true;
        markCardsAoBusy();
        if (!_aoRetryTimer) {
          _aoRetryTimer = setTimeout(() => { _aoRetryTimer = null; window.loadAoRewardEstimates(); }, 3 * 60 * 1000);
        }
      }
    } catch(e) { /* silent */ }
  };

  refreshFleetSummary();
  window.loadAoRewardEstimates();
  setInterval(() => { window.loadAoRewardEstimates(); loadPerRelayRewards(); }, 60 * 60 * 1000);
  // Ag verisi kendi dongusunde: fingerprint'ler SSH ile gec doldugu icin sik denenir
  setInterval(loadRelayNetworkStats, 5 * 60 * 1000);
  setTimeout(loadRelayNetworkStats, 30 * 1000);
  window.api.onSnapshot(() => refreshFleetSummary());
})();
