#!/usr/bin/env node
/* RelayPulse (macOS/Electron) izole denetim kosumu.
 * Gercek main.js + src/*.js yuklenir, electron sahtelenir. SSH baglantisi kurulmaz,
 * kullanici config'i yazilmaz (userData gecici klasore yonlendirilir).
 */
const h = require('./harness.js');
const fs = require('fs'), path = require('path');
const results = [];
function expect(cond, msg) { if (!cond) throw new Error(msg); }
async function check(name, fn) {
  try { await fn(); results.push(true); console.log('PASS', name); }
  catch (e) { results.push(false); console.log('FAIL', name, '-', String(e.message).split('\n')[0]); }
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
    expect(i > 0, 'buildInstancePrefix yok');
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

  const pass = results.filter(Boolean).length;
  console.log(`\n${results.length} kontrol: ${pass} PASS, ${results.length - pass} FAIL`);
  process.exitCode = pass === results.length ? 0 : 1;
})();
