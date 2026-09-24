#!/usr/bin/env node
/* RelayPulse (macOS/Electron) izole denetim kosumu.
 * Gercek main.js + src/*.js yuklenir, electron sahtelenir. SSH baglantisi kurulmaz,
 * kullanici config'i yazilmaz (userData gecici klasore yonlendirilir).
 */
const h = require('./harness.js');
const fs = require('fs'), path = require('path');
const results = [];
const skipped = [];
function expect(cond, msg) { if (!cond) throw new Error(msg); }
// Bu dalda OLMAYAN bir ozellige ait kontrolu atla. Kosum public-main (1.8.x) ve
// mac-appstore dallarinin ikisinde de kosuyor, ozellik setleri ayni degil —
// olmayan seyi "hata" saymak gercek hatalari gurultude bogar. Atlama sessiz
// degil: satir SKIP olarak basilir ve ozete islenir.
function needs(cond, why) { if (!cond) { const e = new Error(why); e.skip = true; throw e; } }
async function check(name, fn) {
  try { await fn(); results.push(true); console.log('PASS', name); }
  catch (e) {
    if (e && e.skip) { skipped.push(name); console.log('SKIP', name, '-', e.message); return; }
    results.push(false); console.log('FAIL', name, '-', String(e.message).split('\n')[0]);
  }
}
const ROOT = h.ROOT;
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// Modul-duzeyi fonksiyonu sutun-0 kapanis ayracina kadar alip calistirilabilir yapar.
function cut(s, name) {
  const i = s.search(new RegExp('^function ' + name + '\\(', 'm'));
  if (i < 0) throw new Error('fonksiyon yok: ' + name);
  return s.slice(i, s.indexOf('\n}', i) + 2);
}
// ...deps: cikarilan fonksiyonun cagirdigi modul-duzeyi yardimcilar.
function grab(file, name, ...deps) {
  const s = src(file);
  const body = deps.map((d) => cut(s, d)).concat(cut(s, name)).join('\n');
  return new Function(body + '; return ' + name + ';')();
}

(async () => {
  h.load('main.js');
  const H = h.captured.handlers;
  const call = (ch, ...args) => H[ch]({ sender: { id: 1, send() {}, isDestroyed: () => false } }, ...args);
  const Monitor = require(path.join(ROOT, 'src/monitor.js'));
  const Config = require(path.join(ROOT, 'src/config.js'));
  const certPin = require(path.join(ROOT, 'src/cert-pin.js'));
  const { verifyLicenseKey } = require(path.join(ROOT, 'src/license.js'));

  // ---- 1. Disari acilan adresler ----
  await check('external_open_rejects_non_http', async () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://x/y']) {
      const r = await call('external:open', u);
      expect(r && r.ok === false, 'kabul edildi: ' + u);
    }
  });
  await check('external_open_rejects_unknown_host', async () => {
    const r = await call('external:open', 'https://evil.example.com/x');
    expect(r && r.ok === false, 'bilinmeyen host acildi');
  });

  // ---- 2. Sunucu adi dogrulamasi ----
  await check('handlers_reject_unknown_server', async () => {
    for (const ch of ['anonrc:read', 'anonrc:write', 'htop:open', 'nyx:open', 'anonlog:open', 'relay:audit']) {
      if (!H[ch]) continue;
      const r = await call(ch, '../../etc/passwd', 'x');
      expect(r && (r.ok === false || r.error), ch + ' bilinmeyen sunucuyu kabul etti');
    }
  });

  // ---- 3. fail2ban IP dogrulamasi ----
  await check('fail2ban_rejects_injected_ip', async () => {
    const m = new Monitor({ servers: [] });
    const r = await m.whitelistIp({ name: 'x', host: '10.0.0.1' }, '1.2.3.4; rm -rf /');
    expect(r && r.ok === false, 'enjeksiyonlu IP kabul edildi');
  });

  // ---- 4. Instance alani kabuk'a sizmasin ----
  await check('instance_field_not_shell_injectable', () => {
    const body = src('src/monitor.js');
    const i = body.indexOf('function buildInstancePrefix');
    needs(i > 0, 'bu dalda instance ozelligi yok (public-main 1.8.x)');
    const fn = new Function('server', body.slice(body.indexOf('{', i) + 1, body.indexOf('\n}', i)));
    for (const bad of ["1'; rm -rf / #", '$(id)', '`id`', '../x', 'a b']) {
      expect(fn({ instance: bad }) === '', 'kabuk sizintisi: ' + bad);
    }
    expect(fn({ instance: 'anon2' }).includes('anon2'), 'gecerli instance reddedildi');
  });

  // ---- 5. parseAnon dogrulugu ----
  await check('parse_anon_states', () => {
    const fn = grab('src/monitor.js', 'parseAnon', 'anonStateFrom');
    expect(fn('anon.service=active').active === 'active', 'active taninmadi');
    expect(fn('anon.service=inactive').active === 'inactive', 'inactive taninmadi');
    expect(fn('anon.service=failed').active !== 'active', 'failed active sayildi');
    expect(fn('').active === 'unknown', 'bos cikti unknown degil');
    expect(fn('0.0.0.0:9001,[::]:9030,').active === 'active', 'gercek port satiri okunmadi');
  });

  // ---- 5b. Gurultulu satir "dinlenen port" sayilmamali ----
  await check('parse_anon_ignores_noise_lines', () => {
    const fn = grab('src/monitor.js', 'parseAnon', 'anonStateFrom');
    const noise = [
      "Warning: Permanently added '10.0.0.5' (ED25519) to the list of known hosts.",
      'bash: line 12: systemctl: command not found',
      'sudo: unable to resolve host relay7: Name or service not known',
    ];
    for (const n of noise) {
      const r = fn(n);
      expect(r.active !== 'active', 'gurultu ACTIVE sayildi: ' + n.slice(0, 40) + ' -> ' + r.active);
    }
  });

  // ---- 6. Gecici SSH hatasi siniflandirmasi ----
  await check('transient_ssh_errors_classified', () => {
    const body = src('src/monitor.js');
    const i = body.indexOf('function isTransientSshError');
    const fn = new Function('msg', body.slice(body.indexOf('{', i) + 1, body.indexOf('\n}', i)));
    expect(fn('Connection timed out') === true, 'timeout gecici sayilmadi');
    expect(fn('kex_exchange_identification: Connection closed by remote host') === true, 'kex gecici degil');
    expect(fn('Permission denied (publickey,password)') === false, 'kimlik hatasi GECICI sayildi');
    expect(fn('Host key verification failed') === false, 'host key hatasi gecici sayildi');
  });

  // ---- 7. Auto-fix uygunlugu: kimlik/host-key hatasinda KAPALI olmali ----
  await check('autofix_blocked_on_credential_errors', () => {
    const cls = grab('main.js', 'classifyAutoFixability');
    const mustBlock = [
      'Permission denied (publickey,password).',
      'Host key verification failed.',
      'Authentication failed: 10.0.0.5. Check the username, password, or key.',
      'Host key mismatch: 10.0.0.5. Connect once manually from Terminal to fix the known_hosts entry.',
    ];
    for (const m of mustBlock) {
      expect(cls(m).autoFixable === false, 'auto-fix ACIK kalmis: ' + m.slice(0, 46));
    }
  });
  await check('autofix_blocked_when_ssh_unreachable', () => {
    const cls = grab('main.js', 'classifyAutoFixability');
    for (const m of [
      'ssh: connect to host 10.0.0.5 port 22: Connection refused',
      'SSH refused: 10.0.0.5:22. SSH/sshd may be disabled on the remote server.',
      'Network unreachable: 10.0.0.5. The server may be offline.',
      'SSH connection dropped: 10.0.0.5.',
    ]) {
      expect(cls(m).autoFixable === false, 'ulasilamayan sunucuda auto-fix acik: ' + m.slice(0, 40));
    }
  });

  // ---- 8. Lisans anahtari dogrulama ----
  await check('license_rejects_garbage', () => {
    for (const k of ['', 'AAAA-BBBB-CCCC', 'x'.repeat(64), null]) {
      expect(verifyLicenseKey(k) === false, 'gecersiz anahtar kabul edildi: ' + k);
    }
  });

  // ---- 9. Config: sirlar duz metin yazilmasin ----
  await check('secrets_not_plaintext_in_config', () => {
    const c = new Config(h.tmpUserData);
    const cfg = c.load();
    cfg.servers = [{ name: 'a', host: '10.0.0.1', user: 'root', password: 'SUPERSECRET1', agentToken: 'TOKENSECRET2' }];
    c.save(cfg);
    const raw = fs.readFileSync(path.join(h.tmpUserData, 'anyone-monitor.json'), 'utf8');
    expect(!raw.includes('SUPERSECRET1'), 'parola duz metin yazildi');
    expect(!raw.includes('TOKENSECRET2'), 'agent token duz metin yazildi');
    const back = c.load();
    expect(back.servers[0].password === 'SUPERSECRET1', 'parola geri okunamadi');
    expect(back.servers[0].agentToken === 'TOKENSECRET2', 'token geri okunamadi');
  });

  // ---- 10. Sertifika pinleme (TOFU) ----
  await check('cert_pin_tofu_behaviour', () => {
    certPin.reset();
    const unpinned = {};
    certPin.apply(unpinned, '10.0.0.9');
    expect(unpinned.rejectUnauthorized === false, 'ilk gorusde baglanti reddediliyor (TOFU bozuk)');
    const fakeRes = { socket: { getPeerCertificate: () => ({ raw: Buffer.from('CERT-A') }) } };
    certPin.learn('10.0.0.9', fakeRes);
    expect(certPin.count() === 1, 'pin kaydedilmedi');
    const pinned = {};
    certPin.apply(pinned, '10.0.0.9');
    expect(pinned.rejectUnauthorized === true && Array.isArray(pinned.ca), 'pinli hostta dogrulama kapali');
    certPin.learn('10.0.0.9', { socket: { getPeerCertificate: () => ({ raw: Buffer.from('CERT-B') }) } });
    const after = {};
    certPin.apply(after, '10.0.0.9');
    expect(after.ca[0] === pinned.ca[0], 'pin sessizce DEGISTI (MITM kapisi)');
  });

  // ---- 11. Demo modu gercek config'i ezmesin ----
  await check('demo_mode_does_not_overwrite_servers', async () => {
    const before = JSON.stringify(await call('servers:get'));
    await call('demo:set', true);
    const r = await call('servers:save', [{ name: 'DEMO-OVERWRITE', host: '9.9.9.9' }]);
    await call('demo:set', false);
    expect(r === false || (r && r.ok === false), 'demo modda gercek filo uzerine yazildi');
    const after = JSON.stringify(await call('servers:get'));
    expect(before === after, 'demo modda yazilan kayit gercek filoya sizdi');
  });

  // ---- 12. 'unknown' anon durumu ariza sayilmasin (regresyon) ----
  await check('unknown_anon_is_not_an_incident', async () => {
    const classify = grab('main.js', 'classifyRelayIssue');
    const snap = { ok: true, state: 'online', anon: { active: 'unknown', ports: [] }, flags: null, error: '' };
    expect(classify(snap) !== 'anon', "okunamayan servis durumu 'anon arizasi' sayildi");
    expect(classify({ ...snap, anon: { active: 'inactive' } }) === 'anon', 'gercek inactive kacirildi');
  });

  // ---- 13. parseAnon gercek ss ciktisini bozmadan gurultuyu reddetsin ----
  await check('parse_anon_keeps_real_ports', async () => {
    const parse = grab('src/monitor.js', 'parseAnon', 'anonStateFrom');
    const ok = parse('anon.service=active\n0.0.0.0:9001,[::]:9030,*:9050,');
    expect(ok.active === 'active', 'gercek active kayboldu');
    expect(ok.ports.length === 3, 'gercek portlar kayboldu: ' + JSON.stringify(ok.ports));
    for (const noise of [
      "Warning: Permanently added '10.0.0.5' (ED25519) to the list of known hosts.",
      'bash: line 12: systemctl: command not found',
      'sudo: unable to resolve host relay-07: Name or service not known',
    ]) {
      const r = parse(noise);
      expect(r.active === 'unknown', 'gurultu durum uretti: ' + noise);
      expect(r.ports.length === 0, 'gurultu port uretti: ' + noise);
    }
  });

  // ---- 14. monitor.js'in URETTIGI hata metinleri auto-fix'i kapatsin ----
  await check('autofix_blocked_for_english_ssh_errors', async () => {
    const classify = grab('main.js', 'classifyAutoFixability');
    const blocked = [
      'Host key verification failed.',
      'Authentication failed: Permission denied (publickey).',
      'Host key mismatch: REMOTE HOST IDENTIFICATION HAS CHANGED',
      'SSH refused: connect to host 10.0.0.5 port 22: Connection refused',
      'Network unreachable: connect to host 10.0.0.5 port 22: Network is unreachable',
      'SSH connection dropped: Connection closed by remote host',
    ];
    for (const m of blocked) {
      const r = classify(m);
      expect(r && r.autoFixable === false, 'auto-fix ACIK kaldi: ' + m);
    }
    const fixable = classify('anon service became inactive');
    expect(fixable && fixable.autoFixable !== false, 'gercek onarilabilir vaka bloklandi');
  });

  // ---- 15. Cokmus servisin artik soketi karti yesil tutmasin (SSH + agent) ----
  await check('lingering_socket_does_not_fake_active', async () => {
    const decide = grab('src/monitor.js', 'anonStateFrom');
    expect(decide({ anon: 'inactive' }, ['0.0.0.0:9001']) === 'inactive', 'artik soket inactive servisi active yapti');
    expect(decide({ anon: 'failed' }, ['[::]:9030']) === 'failed', 'artik soket failed servisi active yapti');
    expect(decide({ anon: 'active' }, []) === 'active', 'gercek active kayboldu');
    expect(decide({ anon: 'activating' }, []) === 'active', 'activating kayboldu');
    expect(decide({}, ['0.0.0.0:9001']) === 'active', 'servis bilinmiyorken port kaniti yok sayildi');
    expect(decide({}, []) === 'unknown', 'veri yokken inactive dondu');
  });

  // ---- 16. agent.py ayni karari versin (iki uygulama da bu JSON'u yiyor) ----
  await check('agent_py_matches_desktop_decision', async () => {
    const { execFileSync } = require('child_process');
    const py = `
import re, sys
src = open(${JSON.stringify(path.join(ROOT, 'agent/agent.py'))}).read()
assert "port_active = (not any_known) and bool(ports)" in src, "agent.py'de port bastirmasi YOK"
print("ok")`;
    const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
    expect(out.trim() === 'ok', 'agent.py kontrolu basarisiz');
  });

  // ---- 18. Menu cubugundaki Quit gercekten cikmali (App Review 2.1(a), 2026-09-23) ----
  // 5.6 temizliginde clearDashboardKeepAliveTimer'in tanimi silindi, cagrilari
  // kaldi: requestAppQuit ReferenceError ile app.quit()'e varmadan duruyordu.
  await check('tray_quit_reaches_app_quit', async () => {
    // requestAppQuit'i serbest degiskenleri sahte bir kapsamda calistir; tanimsiz
    // bir isim cagrilirsa with-kapsaminda bulunamaz ve ReferenceError firlatir.
    let quitCalled = false;
    const body = cut(src('main.js'), 'requestAppQuit');
    const ctx = {
      isQuitting: false, relayReminderTimers: new Map([['x', 1]]),
      monitor: { stop() {} }, tray: { destroy() {} },
      win: { isDestroyed: () => false, removeAllListeners() {}, close() {} },
      app: { quit() { quitCalled = true; }, exit() {} }, setTimeout: () => {}, clearInterval: () => {},
    };
    const fn = new Function('ctx', 'with (ctx) { ' + body + '; return requestAppQuit; }')(ctx);
    try { fn(); } catch (e) { throw new Error('Quit tiklamasi hata firlatti: ' + e.message); }
    expect(quitCalled, 'Quit app.quit() cagirmadi');
    expect(ctx.tray === null, 'tepsi simgesi kaldirilmadi');

    // before-quit dinleyicileri gercek modul kapsaminda calisir (Cmd+Q de buradan gecer).
    const bq = h.captured.appEvents['before-quit'] || [];
    expect(bq.length > 0, 'before-quit dinleyicisi yakalanmadi');
    for (const f of bq) {
      try { f({ preventDefault() {} }); } catch (e) { throw new Error('before-quit hata firlatti: ' + e.message); }
    }
  });

  // ---- 19. MyFamily plani filo disi uyeleri korusun, dusecekleri gostersin ----
  // Gercek filoda (2026-09-23) plan filo disi bir aile uyesini tum relay'lerden silecekti: plan sadece
  // canli fingerprint'lerden kuruluyordu. Ekstra liste + removedFingerprints bunu onler.
  await check('family_plan_keeps_extras_and_lists_removals', async () => {
    const m = src('main.js');
    const cutAny = (s, name) => {
      const i = s.search(new RegExp('^(async )?function ' + name + '\\(', 'm'));
      if (i < 0) throw new Error('fonksiyon yok: ' + name);
      return s.slice(i, s.indexOf('\n}', i) + 2);
    };
    const body = ['normalizeRelayFingerprint', 'formatMyFamilyLine', 'parseMyFamilyFingerprints', 'familyExtraFingerprints', 'buildRelayFamilyPlan'].map((n) => cutAny(m, n)).join('\n');
    needs(/function familyExtraFingerprints/.test(m), 'bu dalda family ekstra listesi yok');
    const A = 'A'.repeat(40), B = 'B'.repeat(40), X = 'C'.repeat(40), OLD = 'D'.repeat(40);
    const ctx = {
      config: { load: () => ({ familyExtraFingerprints: [X] }) },
      fetchAllRelayFingerprints: async () => ({ rows: [
        { name: 'r1', ok: true, fingerprint: A, myFamilyLines: [`$${B},$${OLD}`] },
        { name: 'r2', ok: true, fingerprint: B, myFamilyLines: [`$${A},$${X}`] },
      ] }),
    };
    const build = new Function('ctx', 'with (ctx) { ' + body + '; return buildRelayFamilyPlan; }')(ctx);
    const plan = await build();
    const r1 = plan.rows.find((r) => r.name === 'r1'), r2 = plan.rows.find((r) => r.name === 'r2');
    expect(plan.familySize === 3, 'aile buyuklugu 3 olmali (2 relay + 1 ekstra), ' + plan.familySize);
    expect(r1.familyFingerprints.includes(X), 'filo disi uye r1 satirina girmedi');
    expect(!r1.familyFingerprints.includes(A), 'relay kendi fingerprint\'ini ailesine yazdi');
    expect(JSON.stringify(r1.removedFingerprints) === JSON.stringify([OLD]), 'dusecek eski FP listelenmedi: ' + JSON.stringify(r1.removedFingerprints));
    expect(r2.familyUpToDate === true, 'zaten dogru olan relay degisecek sanildi');
    expect(plan.familyLine.includes(X) && plan.familyLine.includes(A) && plan.familyLine.includes(B), 'Copy MyFamily satiri eksik');
  });

  // ---- 20. Config okuyan/yazan her komut instance'a gore dosya secsin ----
  // Ayni IP'de iki relay ayni "Address" satirini tasir; yalnizca IP eslemesi
  // ikinci relay'e anonrc-1'i veriyordu (editor, cuzdan, family, saglik kontrolu).
  await check('anonrc_commands_pick_by_instance', () => {
    const mon = src('src/monitor.js');
    needs(/const PICK_ANONRC/.test(mon), 'bu dalda ortak anonrc secimi yok');
    for (const fn of ['readAnonrc', 'writeAnonrc', 'bindRelayWallet', 'setupHealthCheck']) {
      const i = mon.indexOf('  async ' + fn + '(');
      expect(i > 0, fn + ' bulunamadi');
      const body = mon.slice(i, mon.indexOf('\n  async ', i + 10));
      expect(body.includes('buildInstancePrefix(server) + `'), fn + ' instance onekini almiyor');
      expect(body.includes('${PICK_ANONRC}'), fn + ' ortak secimi kullanmiyor');
      expect(!/grep -q "\^Address \$LOCAL_IP"/.test(body), fn + ' hala kendi IP eslemesini yapiyor');
    }
    // Yazici, instance biriminden baskasini yeniden baslatmamali.
    expect(/SVC_LIST="\$ANON_UNIT"/.test(mon), 'yazici instance birimini hedeflemiyor');
    // verify-config, DataDirectory'nin sahibi olarak calismali: root olarak anon1/anon2
    // kutularinda cokuyor (exit 134) ve gecerli config bozuk sayilip geri aliniyordu.
    expect(/\$AS_OWNER anon -f "\$ANONRC" --verify-config/.test(mon), 'verify-config hala root olarak calisiyor');
  });

  // ---- 17. Durmus servis gorunsun, var olmayan servis alarm vermesin ----
  // Gercek agent.py fonksiyonu, PATH'e konan sahte bir systemctl ile calisir.
  // systemctl'in gercek cikis kodlarini taklit eder: inactive/failed 3, yok 4.
  await check('agent_sees_stopped_but_ignores_missing_units', async () => {
    const { execFileSync } = require('child_process');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-systemctl-'));
    fs.writeFileSync(path.join(dir, 'systemctl'), `#!/bin/sh
if [ "$1" = show ]; then
  case "$5" in gone) echo not-found;; hidden) echo masked;; *) echo loaded;; esac; exit 0
fi
case "$2" in up) echo active; exit 0;; down) echo inactive; exit 3;; crashed) echo failed; exit 3;; *) echo inactive; exit 4;; esac
`, { mode: 0o755 });
    const py = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("agent", ${JSON.stringify(path.join(ROOT, 'agent/agent.py'))})
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
print(json.dumps(agent._service_states(["up", "down", "crashed", "gone", "hidden"])))`;
    const out = execFileSync('python3', ['-c', py], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    const got = JSON.parse(out.trim().split('\n').pop());
    expect(got.up === 'active', 'calisan servis kayboldu');
    expect(got.down === 'inactive', 'durmus servis DUSURULDU (cikis kodu 3 yutuluyor)');
    expect(got.crashed === 'failed', 'cokmus servis DUSURULDU');
    expect(!('gone' in got), 'var olmayan servis inactive sayildi — her normal sunucu bozuk gorunur');
    expect(!('hidden' in got), 'maskelenmis servis sayildi');
    // Masaustu SSH betigi ayni kurali iki dongude de uygulamali.
    const guards = (src('src/monitor.js').match(/LoadState --value "\$svc"[^\n]*not-found\|masked\) continue/g) || []).length;
    expect(guards >= 2, `monitor.js'de LoadState korumasi ${guards} dongude, 2 olmali`);
  });

  if (h.stubGaps.size) {
    console.log(`\nKOSUM EKSIGI (sahtelenmemis, no-op donduruldu): ${[...h.stubGaps].join(', ')}`);
  }
  // ---- 17. Ulasilamayan kutuda AI cagrilari durmali (2026-09-22) ----
  await check('unreachable_box_brakes_autofix', async () => {
    const classify = grab('main.js', 'classifyAutoFixability');
    // Canli olaydan alinan GERCEK hata metni: kutu OS duzeyinde olmustu, SSH banner
    // bile gelmiyordu; Auto-Fix 5 dakikada bir AI cagirip bosa harciyordu.
    const live = 'SSH session closed by the remote side: 203.0.113.145. The server, firewall, '
      + 'or an intermediate network may have dropped the session.';
    expect(classify(live).autoFixable === false, 'ulasilamaz hata hala "duzeltilebilir" sayiliyor');

    // Fren gercekten bagli mi (kazara silinirse yakala).
    const m = src('main.js');
    expect(/AUTOFIX_DEAD_END_LIMIT\s*=\s*\d+/.test(m), 'fren esigi yok');
    expect(/autoFixDeadEnds\.get\(snap\.name\)[^\n]*>=\s*AUTOFIX_DEAD_END_LIMIT/.test(m),
      'tetikleyicide fren kontrolu yok');
    expect(/autoFixDeadEnds\.set\(snap\.name/.test(m), 'sayac hic artmiyor');
    expect(/autoFixDeadEnds\.delete\(data\.name\)/.test(m), 'relay toparlayinca fren birakilmiyor');
  });

  // ---- 18. Ana config dosyasi sadece sahibine okunur olmali ----
  await check('main_config_written_0600', async () => {
    // IPC yolu monitor instance'i istiyor; asil olculmek istenen config modulunun
    // YAZMA davranisi, o yuzden dogrudan onu cagiriyoruz.
    const cfgPath = path.join(h.tmpUserData, 'anyone-monitor.json');
    const store = new Config(h.tmpUserData);   // modul SINIF export ediyor; yapici dizin ister
    const cur = store.load();
    store.save({ ...cur, servers: [{ name: 'AUDIT-PERM', host: '10.0.0.1' }] });
    expect(fs.existsSync(cfgPath), 'config yazilmadi: ' + cfgPath);
    const mode = fs.statSync(cfgPath).mode & 0o777;
    // Icinde licenseKey duruyor. Sidecar zaten 0600, ana config umask'a birakilmisti.
    expect(mode === 0o600, 'ana config modu 0' + mode.toString(8) + ' (0600 olmali)');
  });

  // ---- 19. AI saglayici istekleri suresiz asili kalmamali ----
  await check('ai_requests_have_timeout', async () => {
    const a = src('src/ai-fixer.js');
    expect(/AbortController/.test(a), 'AbortController yok');
    expect(/signal:\s*\w+\.signal/.test(a), 'istege signal baglanmamis');
    const calls = a.match(/await fetch\('https:\/\/api\./g) || [];
    expect(calls.length === 0, calls.length + ' saglayici cagrisi hala ciplak fetch');
  });

  // ---- 20. Uptime gecmisi atomik yazilmali ----
  await check('uptime_stats_written_atomically', async () => {
    const m = src('main.js');
    const i = m.indexOf('uptimeStatsPath');
    expect(i > 0, 'uptimeStatsPath yok');
    const block = m.slice(i, i + 2500);
    expect(/renameSync\(\s*tmp/.test(block), 'tmp + rename deseni yok — yarim yazma gecmisi bozar');
  });

  // ---- 21. Anahtarsiz fallback: her imza DOGRU komuta gitmeli ----
  await check('fallback_maps_signatures_to_commands', async () => {
    const { pickFallbackCommand } = require(path.join(ROOT, 'src/ai-fixer.js'));
    // Kullanicinin gercek listesiyle ayni ad seti.
    const cmds = [
      { id: 1, name: 'Restart relay service' }, { id: 2, name: 'Check service status' },
      { id: 3, name: 'Last 50 log lines' },     { id: 5, name: 'Restart SSH service' },
      { id: 12, name: 'Disk usage' },           { id: 13, name: 'RAM and load' },
      { id: 16, name: 'Reboot required?' },
    ];
    const cases = [
      ['/var: No space left on device',                        'Disk usage'],
      ['EXT4-fs error (device vda1): ext4_journal_check_start', 'Disk usage'],
      ['anon invoked oom-killer: gfp_mask=0x100cca',            'RAM and load'],
      ['bash: fork: Cannot allocate memory',                    'RAM and load'],
      ['*** System restart required ***',                       'Reboot required?'],
      ['Could not get lock /var/lib/dpkg/lock-frontend',        'Last 50 log lines'],
      ['fail2ban: IP 1.2.3.4 banned in jail sshd',              'Check service status'],
      ['certificate is not yet valid — clock skew detected',    'Last 50 log lines'],
      ['anon service became inactive',                          'Restart relay service'],
      ['dashboard_running=false',                               'Restart relay service'],
      ['ssh master: broken pipe on port 22',                    'Restart SSH service'],
    ];
    for (const [err, want] of cases) {
      const got = pickFallbackCommand(err, cmds);
      expect(got && got.name === want, `${JSON.stringify(err)} -> ${got && got.name} (beklenen ${want})`);
    }
  });

  // ---- 22. Fallback GUVENLIK: taninmayan/bilgi amacli imza servis yeniden baslatmasin ----
  await check('fallback_never_restarts_on_diagnostic_signatures', async () => {
    const { pickFallbackCommand } = require(path.join(ROOT, 'src/ai-fixer.js'));
    const cmds = [
      { id: 1, name: 'Restart relay service' }, { id: 2, name: 'Check service status' },
      { id: 3, name: 'Last 50 log lines' },     { id: 5, name: 'Restart SSH service' },
      { id: 12, name: 'Disk usage' },           { id: 13, name: 'RAM and load' },
      { id: 16, name: 'Reboot required?' },
    ];
    const mutating = /restart/i;
    for (const err of ['No space left on device', 'invoked oom-killer', 'System restart required',
                       'Could not get lock', 'banned in jail sshd', 'clock skew detected',
                       'something nobody has ever seen before']) {
      const got = pickFallbackCommand(err, cmds);
      expect(got, `${JSON.stringify(err)} icin komut donmedi`);
      expect(!mutating.test(got.name), `${JSON.stringify(err)} -> ${got.name} (servis yeniden baslatiyor!)`);
    }
    // Bos hata hicbir sey calistirmamali.
    expect(pickFallbackCommand('', cmds) === null, 'bos hata icin komut dondu');
    // Komut listesi bossa da patlamamali.
    expect(pickFallbackCommand('No space left on device', []) === null, 'bos listede komut uydurdu');
  });

  // ---- 23. Profil karti: hangi paket / hangi config / kac relay ----
  await check('app_profile_reports_identity', async () => {
    const p = await call('app:profile');
    expect(p && typeof p === 'object', 'profil donmedi');
    for (const k of ['version', 'sandboxed', 'appPath', 'userData', 'relayCount', 'autoFixMode']) {
      expect(k in p, 'eksik alan: ' + k);
    }
    // Kosum userData'yi gecici klasore yonlendiriyor; sandbox kabini degil.
    expect(p.sandboxed === false, 'gecici klasor sandbox sanildi: ' + p.userData);
    expect(p.userData === h.tmpUserData, 'config yolu yanlis raporlandi: ' + p.userData);
    expect(typeof p.relayCount === 'number', 'relayCount sayi degil');
    expect(['off', 'dry-run', 'live'].includes(p.autoFixMode), 'gecersiz mod: ' + p.autoFixMode);
    // Kartin asil isi: profildeki relay sayisini DOGRU bildirmek (0/0 karisikligi
    // sayinin hic gosterilmemesinden cikmisti). Sabit bir sayi beklemek kontrolleri
    // birbirine baglar; config ne diyorsa kart onu demeli.
    const store = new Config(h.tmpUserData);
    const actual = (store.load().servers || []).length;
    expect(p.relayCount === actual, `kart ${p.relayCount} diyor, config ${actual}`);
  });

  // ---- 24. Toplu hata: saglayici olayi mi, yerel ag mi? ----
  await check('provider_outage_not_silenced_as_local_network', async () => {
    // Buyuk filo: 100'u farkli subnetlerde, 20'si tek bir node'da (203.0.113.x).
    const servers = [];
    for (let i = 0; i < 124; i++) servers.push({ name: 'spread' + i, host: `10.${i}.0.5` });
    for (let i = 0; i < 20; i++) servers.push({ name: 'node' + i, host: `203.0.113.${i + 10}` });
    const mk = () => { const m = Object.create(Monitor.prototype); m.servers = servers; m.pollMs = 10000; m._logDebug = () => {}; return m; };

    // (a) Tek node'daki 20 relay duserse: SAGLAYICI olayi, alarm BASTIRILMAMALI.
    const a = mk();
    let suppressed = false;
    for (let i = 0; i < 20; i++) suppressed = a._noteFailureAndSuspectNetwork('node' + i);
    expect(suppressed === false, 'saglayici kesintisi yerel ag sanilip susturuldu');

    // (b) Ayni sayida relay FARKLI subnetlerden duserse: yerel ag, bastirilmali.
    const b = mk();
    let sup2 = false;
    for (let i = 0; i < 20; i++) sup2 = b._noteFailureAndSuspectNetwork('spread' + i);
    expect(sup2 === true, 'dagilmis hata saglayici olayi sanildi (alarm firtinasi riski)');

    // (c) Tek relay hicbir zaman toplu sayilmaz.
    const c = mk();
    expect(c._noteFailureAndSuspectNetwork('node0') === false, 'tek hata bastirildi');

    // (d) Kumelenme testi hostname/IPv6'da patlamamali.
    const d = Object.create(Monitor.prototype);
    d.servers = [{ name: 'x', host: 'relay.example.com' }, { name: 'y', host: '::1' }];
    d._logDebug = () => {};
    expect(d._failureCluster(['x', 'y']) === null, 'IP olmayan hostlarda kumelenme uydurdu');
  });

  // ---- 25. Onay kuyrugu: komut onaysiz CALISMAMALI ----
  await check('approval_queue_holds_commands', async () => {
    const list = await call('autofix:pending');
    expect(Array.isArray(list), 'bekleyen liste dizi degil');

    // Bilinmeyen/suresi gecmis oneri ASLA calistirilmamali. TTL yolu da buraya cikar:
    // prune siler, arama basarisiz olur, komut calismaz.
    const r = await call('autofix:approve', 'ap-yok-boyle-bir-sey');
    expect(r && r.ok === false, 'olmayan oneri onaylandi');
    expect(/no longer available|expired|handled/i.test(String(r.error || '')),
      'red sebebi acik degil: ' + r.error);

    const rej = await call('autofix:reject', 'ap-yok-boyle-bir-sey');
    expect(rej && rej.ok === false, 'olmayan oneri reddedildi diye TRUE dondu');

    // Kaynak: onay modunda komut kutuya GITMEMELI.
    const m = src('main.js');
    // runCommandFn ucluleri sirayla: dry-run -> onay -> canli. Onay dali komutu
    // kuyruga aliyor ve monitor.runCommand'a HIC ulasmadan donuyor. Regex yerine
    // sira kontrolu: bicim degisse de anlam korunur.
    const iApproval = m.indexOf(': requireApproval');
    const iAwait = m.indexOf('[awaiting approval]');
    const iRun = m.indexOf('monitor.runCommand(name, cmd)');
    expect(iApproval > 0, 'runCommandFn onay dali yok');
    expect(iAwait > iApproval, 'onay dalinda komut yakalanmiyor');
    expect(iRun > iAwait, 'onay dali canli calistirmadan SONRA gelmiyor');
    expect(/queuedApproval\s*=\s*\{/.test(m), 'oneri kuyruga alinmiyor');
    expect(/autoFixRequireApproval/.test(m), 'onay modu okunmuyor');
    // dry-run onay modunu ezmeli (daha guvenli olan kazanir).
    expect(/const requireApproval = !dryRun/.test(m), 'dry-run onay modunu ezmiyor');
    // TTL gercekten var mi.
    expect(/APPROVAL_TTL_MS/.test(m), 'onay onerilerinin suresi yok');
  });

  // ---- 26. Arayuz kablolamasi: DOM id'leri ve api adlari birbirini tutmali ----
  await check('renderer_wiring_matches_backend', async () => {
    const html = src('renderer/index.html');
    const app = src('renderer/app.js');
    const pre = src('preload.js');

    // Renderer'in aradigi her DOM id HTML'de var mi? (sessiz null -> ozellik olu)
    for (const id of ['approvalPanel', 'approvalList', 'profileCard', 'profileCardBody',
                      'profileWarning', 'incidentPolicy']) {
      expect(html.includes(`id="${id}"`), `HTML'de id yok: ${id}`);
      expect(app.includes(id), `renderer bu id'yi hic kullanmiyor: ${id}`);
    }

    // Renderer'in cagirdigi her api metodu preload'da aciliyor mu?
    for (const m of ['autoFixPending', 'autoFixApprove', 'autoFixReject', 'appProfile']) {
      expect(app.includes(`window.api.${m}`) || app.includes(`api.${m}(`), `renderer ${m} kullanmiyor`);
      expect(pre.includes(`${m}:`), `preload ${m} acmiyor`);
    }

    // preload'daki her kanal main tarafinda kayitli mi?
    const m = src('main.js');
    for (const ch of ['autofix:pending', 'autofix:approve', 'autofix:reject', 'app:profile']) {
      expect(pre.includes(`'${ch}'`), `preload ${ch} kanalini bilmiyor`);
      expect(m.includes(`ipcMain.handle('${ch}'`), `main ${ch} handler'i yok`);
    }

    // Politika listesi 4 secenekli ve renderer 4 bekliyor.
    expect((html.match(/<option value="(auto|approve|dryrun|off)"/g) || []).length === 4,
      'politika listesi 4 secenekli degil');
    expect(app.includes("opts.length === 4"), 'renderer hala 3 secenek bekliyor');
  });

  // ---- 27. Port tespiti UDP'yi de kapsamali ----
  await check('port_detection_covers_udp', async () => {
    // "Izlenecek portlar" ayari kullaniciya ait: WireGuard 51820/udp, DNS 53/udp,
    // oyun/VoIP sunuculari UDP dinler. Yalnizca TCP'ye bakmak bunlari sessizce
    // "kapali" gosterirdi — uygulamanin Anyone disina cikmasinin onundeki engel.
    const mon = src('src/monitor.js');
    const agent = src('agent/agent.py');
    expect(!/ss -tnlp[^\n]*PORT_RE/.test(mon), 'monitor hala yalnizca TCP dinliyor');
    expect(/ss -tunlp[^\n]*PORT_RE/.test(mon), 'monitor UDP bayragini kullanmiyor');
    expect(/ss -tunlp/.test(agent), 'agent.py UDP bayragini kullanmiyor');
    // -u, ss'in basina Netid sutunu ekler; sabit '{print $4}' o zaman Send-Q
    // okur. Bu kontrol ilk halinde sadece bayraga bakiyordu ve bunu kacirdi.
    expect(!/ss -tunlp[^\n]*print \$4/.test(mon), "monitor ss -tunlp ciktisinda sabit $4 okuyor (Netid kaymasi)");

    // Davranis: gercek agent.py fonksiyonu, gercek 'ss -tunlp' bicimini basan sahte ss ile.
    const { execFileSync } = require('child_process');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-ss-'));
    fs.writeFileSync(path.join(dir, 'ss'), `#!/bin/sh
cat <<'OUT'
Netid State  Recv-Q Send-Q  Local Address:Port  Peer Address:PortProcess
udp   UNCONN 0      0            0.0.0.0:51820      0.0.0.0:*
tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=1,fd=3))
tcp   LISTEN 0      128             [::]:22            [::]:*
tcp   LISTEN 0      65535        0.0.0.0:2222       0.0.0.0:*
tcp   LISTEN 0      4096       127.0.0.1:9051       0.0.0.0:*
OUT
`, { mode: 0o755 });
    const py = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("agent", ${JSON.stringify(path.join(ROOT, 'agent/agent.py'))})
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
print(json.dumps([agent._listening(["22"]), agent._listening(["51820"]), agent._listening(["5432"])]))`;
    const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    fs.rmSync(dir, { recursive: true, force: true });
    const [ssh, wg, none] = JSON.parse(out.trim().split('\n').pop());
    expect(JSON.stringify(ssh) === JSON.stringify(['0.0.0.0:22', '[::]:22']), `22 yanlis okundu: ${JSON.stringify(ssh)} (Send-Q mi, :2222 mi?)`);
    expect(JSON.stringify(wg) === JSON.stringify(['0.0.0.0:51820']), `UDP 51820 okunmadi: ${JSON.stringify(wg)}`);
    expect(none.length === 0, 'dinlenmeyen port bulundu');

    // Kurulu baglanti sayaci TCP kalmali: UDP baglantisiz bir protokol, orada
    // "established" diye bir sey yok; UDP soketi saymak yaniltici bir sayi uretirdi.
    expect(/ss -tn state established/.test(mon), 'baglanti sayaci TCP olmaktan cikti');
    expect(!/ss -tun state established/.test(mon), 'UDP soketleri baglanti diye sayiliyor');

    // parseAnon UDP portlarini da ayristirabilmeli (ayni adres:port bicimi).
    const parse = grab('src/monitor.js', 'parseAnon', 'anonStateFrom');
    const r = parse('wg-quick@wg0.service=active\n0.0.0.0:51820,[::]:53,');
    expect(r.active === 'active', 'UDP servisi active okunamadi');
    expect(r.ports.length === 2, 'UDP portlari ayristirilamadi: ' + JSON.stringify(r.ports));
  });

  const pass = results.filter(Boolean).length;
  const sk = skipped.length ? `, ${skipped.length} SKIP` : '';
  console.log(`\n${results.length + skipped.length} kontrol: ${pass} PASS, ${results.length - pass} FAIL${sk}`);
  process.exitCode = pass === results.length ? 0 : 1;
})();
