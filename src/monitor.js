// SSH polling & log streaming for Anyone relay/exit nodes.
//
// Strategy: shell out to the system `ssh` binary. This inherits the user's
// ~/.ssh/config, SSH agent, keys, and ControlMaster sockets automatically —
// which is why we expose `sshAlias` as the primary field. Fall back to
// user@host:port -i key if an alias isn't set.
//
// Per-tick we run a single bash snippet remotely that prints several sections
// separated by markers; we parse and diff rx/tx byte counters to get rates.
//
// Events emitted:
//   'snapshot'  { name, ok, error?, metrics? }
//   'aggregate' { online, total, totalRxMbps, totalTxMbps }
//   'log'       { name, line }   (only while a log stream is active)

const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');

// Per-app ControlMaster socket dir. Reusing a single TCP/SSH channel per host
// (instead of a fresh connection every 3s) drops load on both sides by 20x+
// and avoids tripping fail2ban / sshd MaxStartups on the remote.
// macOS caps Unix socket paths around 104 chars. Keep this directory short so
// longer server names still fit when SSH appends its temporary suffix.
const CM_DIR = '/tmp/am-ssh';
try { fs.mkdirSync(CM_DIR, { recursive: true, mode: 0o700 }); } catch {}

function controlSocketPath(server) {
  const key = [
    server.name || '',
    server.sshAlias || '',
    server.user || '',
    server.host || '',
    server.port || '',
  ].join('|');
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return path.join(CM_DIR, `cm-${hash}.sock`);
}

function serverConnectionKey(server) {
  return [
    server?.name || '',
    server?.sshAlias || '',
    server?.user || '',
    server?.host || '',
    String(server?.port || ''),
    server?.key || '',
    server?.password ? '__PASSWORD__' : '',
  ].join('|');
}

function shouldAvoidControlMaster(server) {
  return !!(server && server.sshNoMux);
}

const REMOTE_SCRIPT = `
# Some hosts run the remote command under /bin/sh where "set -o pipefail"
# is unsupported and can terminate the whole script. Probe safely first.
(set -o pipefail) >/dev/null 2>&1 && set -o pipefail || true
echo '===IFACE==='
ip route 2>/dev/null | awk '/^default/ {print $5; exit}'
echo '===NETDEV==='
cat /proc/net/dev
echo '===CONN==='
ss -tn state established 2>/dev/null | tail -n +2 | wc -l
echo '===MEM==='
awk '/^MemTotal|^MemAvailable/ {print $1, $2}' /proc/meminfo
echo '===LOAD==='
cat /proc/loadavg
echo '===DISK==='
df -P / 2>/dev/null | tail -1
echo '===CPU==='
head -1 /proc/stat
echo '===CPUCOUNT==='
(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || true) | head -1
echo '===ANON==='
# Detect which IP was used to connect (for multi-instance servers)
LOCAL_IP=$(echo $SSH_CONNECTION | awk '{print $3}')
# Try to find matching anonrc by Address field for multi-instance setups
MATCHED_ANONRC=""
if [ -n "$LOCAL_IP" ]; then
  for rc in /etc/anon/anonrc-* /etc/anon/instances/*/anonrc; do
    [ -f "$rc" ] || continue
    if grep -q "^Address $LOCAL_IP" "$rc" 2>/dev/null; then
      MATCHED_ANONRC="$rc"
      break
    fi
  done
fi
# Try multiple known service names — first non-inactive wins.
# Also detect multi-instance anon@NAME services dynamically.
MULTI_SVCS=$(systemctl list-units --state=active,activating,failed --no-legend --plain 'anon@*' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
NAMED_SVCS=$(systemctl list-units --state=active,activating,failed --no-legend --plain 'anon[0-9]*.service' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
for svc in $MULTI_SVCS $NAMED_SVCS anon anon@default anyone anyone-relay tor-anon; do
  s=$(systemctl is-active "$svc" 2>/dev/null || true)
  [ -n "$s" ] && echo "$svc=$s"
done
# If we matched a specific anonrc, print the Nickname from it
if [ -n "$MATCHED_ANONRC" ]; then
  echo "MATCHED_ANONRC=$MATCHED_ANONRC"
  grep '^Nickname' "$MATCHED_ANONRC" 2>/dev/null | head -1 | awk '{print "INSTANCE_NICKNAME="$2}'
fi
# Listening ports on the anon protocol range (9001/9030/9050/9051).
ss -tnlp 2>/dev/null | grep -E ':(9001|9030|9050|9051)' | awk '{print $4}' | sort -u | tr '\\n' ',' || true
echo
echo '===UPTIME==='
uptime -p 2>/dev/null || uptime
echo '===PUBIP==='
(curl -4 -fsS --max-time 4 ifconfig.me || curl -4 -fsS --max-time 4 ipinfo.io/ip || curl -4 -fsS --max-time 4 api.ipify.org || true) 2>/dev/null | head -1
echo '===FINGERPRINT==='
FP_FILE=""
if [ -n "$MATCHED_ANONRC" ]; then
  DATADIR=$(grep '^DataDirectory' "$MATCHED_ANONRC" 2>/dev/null | awk '{print $2}' | head -1)
  [ -n "$DATADIR" ] && [ -f "$DATADIR/fingerprint" ] && FP_FILE="$DATADIR/fingerprint"
fi
[ -z "$FP_FILE" ] && [ -f /var/lib/anon/fingerprint ] && FP_FILE=/var/lib/anon/fingerprint
[ -z "$FP_FILE" ] && [ -f /var/lib/tor/fingerprint ] && FP_FILE=/var/lib/tor/fingerprint
[ -n "$FP_FILE" ] && awk 'NR==1 { for(i=1;i<=NF;i++) { fp=$i; sub(/^\$/,"",fp); if(fp~/^[A-Fa-f0-9]{40}$/) { print fp; exit } } }' "$FP_FILE" 2>/dev/null || true
echo '===WARNS==='
journalctl -u anon -n 300 --no-pager --output=cat 2>/dev/null | grep '\\[WARN\\]' | tail -8 | sed 's/^[[:space:]]*//' || true
echo '===END==='
`;

// ── Password-auth ControlMaster ─────────────────────────────────────────────
// sshpass can't reuse an existing ControlMaster socket, but it CAN create one.
// We start ONE persistent master per server (sshpass -e ssh -M -S sock -N -o
// ControlPersist=4h ...) and then all subsequent poll commands run as plain
// `ssh -S sock user@host cmd` — no password or sshpass needed.  This cuts
// connections from N_servers/poll_interval to just 1 per server total.

const _pwMasters = new Map(); // socketPath -> establishing Promise (in-flight only)

function _pwSocketPath(server) {
  const key = [server.user || 'root', server.host || server.name, String(server.port || 22)].join('|');
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  return path.join(CM_DIR, `pw-${hash}.sock`);
}

function _ensurePwMaster(server) {
  const sock = _pwSocketPath(server);
  if (fs.existsSync(sock)) return Promise.resolve(sock);
  if (_pwMasters.has(sock)) return _pwMasters.get(sock);

  const p = new Promise((resolve, reject) => {
    const user = server.user || 'root';
    const host = server.host || server.name;
    const args = [
      '-M', '-S', sock, '-N',
      '-o', 'ControlPersist=4h',
      '-o', 'ConnectTimeout=15',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=6',
    ];
    if (server.port && server.port !== 22) args.push('-p', String(server.port));
    args.push(`${user}@${host}`);

    const env = { ...process.env, SSHPASS: server.password };
    const child = spawn('sshpass', ['-e', 'ssh', ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', b => { stderr += b; });

    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      _pwMasters.delete(sock);
      if (err) reject(err); else resolve(sock);
    };

    const poll = setInterval(() => {
      if (fs.existsSync(sock)) finish(null);
    }, 400);

    // Safety timeout: 16s
    const deadline = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error(`SSH master baglantisi kurulamadi (16s): ${stderr.trim()}`));
    }, 16000);

    child.on('error', e => {
      clearTimeout(deadline);
      finish(e.code === 'ENOENT'
        ? new Error('sshpass kurulu degil. Kur: sudo apt-get install -y sshpass')
        : e);
    });
    child.on('close', code => {
      clearTimeout(deadline);
      // With ControlPersist the master process exits 0 immediately after
      // handing off to the background mux — socket file should now exist.
      if (fs.existsSync(sock)) { finish(null); return; }
      if (done) return;
      const hint = sshpassHint(code) || stderr.trim() || `SSH master cikis kodu: ${code}`;
      finish(new Error(hint));
    });
  });

  _pwMasters.set(sock, p);
  return p;
}

function _runSshViaPasswordMaster(server, remoteCmd, timeoutMs) {
  return _ensurePwMaster(server).then(sock => {
    return new Promise((resolve, reject) => {
      const user = server.user || 'root';
      const host = server.host || server.name;
      const args = ['-S', sock, '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes'];
      if (server.port && server.port !== 22) args.push('-p', String(server.port));
      args.push(`${user}@${host}`, remoteCmd);

      execFile('ssh', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout.toString());
        const stderrText = (stderr || '').toString().trim();
        // Stale socket — delete it so next call re-establishes
        if (/mux.*failed|Control.*socket.*connect.*failed|No such file|not exist/i.test(stderrText)) {
          try { fs.unlinkSync(sock); } catch {}
          // One immediate retry with a fresh master
          return _runSshViaPasswordMaster(server, remoteCmd, timeoutMs).then(resolve, reject);
        }
        reject(new Error(normalizeSshError(stderrText || err.message, server)));
      });
    });
  });
  // No fallback to direct sshpass: if master fails the error is meaningful
  // (wrong password, host unreachable, etc.) and a fallback would just fail again.
}

// ────────────────────────────────────────────────────────────────────────────

function buildSshArgs(server, extra = [], opts = {}) {
  const hasPassword = !!server.password;
  const reuseControlMaster = opts.reuseControlMaster !== false && !shouldAvoidControlMaster(server);
  const defaultKey = path.join(process.env.HOME || '', '.ssh', 'id_ed25519');
  const sshConfigExists = fs.existsSync(path.join(process.env.HOME || '', '.ssh', 'config'));
  const args = [
    '-o', 'ConnectTimeout=8',
    '-o', 'ConnectionAttempts=2',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=6',
  ];
  if (hasPassword) {
    // Used only for initial master setup — subsequent polls go through the socket.
    args.push('-o', 'PreferredAuthentications=password,keyboard-interactive');
    args.push('-o', 'PubkeyAuthentication=no');
  } else {
    // Key auth path: BatchMode (never prompt)
    args.push('-o', 'BatchMode=yes');
    if (server.key) args.push('-i', server.key);
    else if (fs.existsSync(defaultKey)) args.push('-i', defaultKey);
    if (reuseControlMaster) {
      // Reuse ONE TCP/SSH channel per host — critical to avoid rate-limit on the
      // VPS side. 'auto' opens the master if absent, reuses it if present.
      const sock = controlSocketPath(server);
      args.push('-o', 'ControlMaster=auto');
      args.push('-o', `ControlPath=${sock}`);
      args.push('-o', 'ControlPersist=5m');
    } else {
      // Fresh connection fallback. This avoids stale mux sockets producing
      // false offline/stale states when the master has silently died.
      args.push('-o', 'ControlMaster=no');
      args.push('-o', 'ControlPath=none');
      args.push('-o', 'ControlPersist=no');
    }
  }
  if (server.port && server.port !== 22) args.push('-p', String(server.port));
  let target;
  if (hasPassword) {
    // With password we MUST have user+host (ssh config alias may not carry user)
    const user = server.user || 'root';
    const host = server.host || server.sshAlias || server.name;
    target = `${user}@${host}`;
  } else if (server.sshAlias && sshConfigExists) {
    // For key-auth servers, prefer the SSH alias when present so ~/.ssh/config
    // can supply IdentityFile, User, Port, ProxyJump, backup ports, etc.
    // If the user wants a direct host-based connection they can clear sshAlias
    // or provide an explicit key path in the app config.
    target = server.sshAlias;
  } else if (server.host) {
    const user = server.user || 'root';
    target = `${user}@${server.host}`;
  } else if (server.user && server.host) {
    target = `${server.user}@${server.host}`;
  } else {
    target = server.name;
  }
  args.push(target);
  args.push(...extra);
  return args;
}

// sshpass exit codes — we translate the useful ones into Turkish hints.
function sshpassHint(code) {
  switch (code) {
    case 1: return 'sshpass: gecersiz parametre';
    case 2: return 'sshpass: cakisan argumanlar';
    case 3: return 'sshpass: kullanim hatasi';
    case 4: return 'sshpass: bilinmeyen hata (stderr bos)';
    case 5: return 'Parola HATALI veya sshd parola auth kapali. /etc/ssh/sshd_config > PasswordAuthentication yes';
    case 6: return 'Host key bilinmiyor veya degismis. Terminal\'den bir kere SSH yapip yes de.';
    case 7: return 'sshpass: IO hatasi';
    case 8: return 'sshpass: beklenen prompt gelmedi';
    default: return null;
  }
}

function stripTerminalNoise(text) {
  return String(text || '')
    .replace(/\x1B\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/^root@[^\n]*[#>$]\s?/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^Connection to [^\n]+ closed\.?\s*$/gmi, '')
    .replace(/^Shared connection to [^\n]+ closed\.?\s*$/gmi, '')
    .replace(/\r/g, '')
    .trim();
}

function normalizeSshError(text, server) {
  const msg = stripTerminalNoise(text || '');
  if (!msg) return msg;
  const host = server?.host || server?.sshAlias || server?.name || 'hedef';

  if (/Connection refused/i.test(msg)) {
    return `SSH reddedildi: ${host}:${server?.port || 22}. Uzak sunucuda ssh/sshd kapali veya firewall port 22'yi reddediyor.\n${msg}`;
  }
  if (/Permission denied/i.test(msg)) {
    return `Kimlik dogrulama basarisiz: ${host}. Kullanici/parola/key bilgisini kontrol et.\n${msg}`;
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(msg)) {
    return `Host key uyusmazligi: ${host}. Terminal'den bir kere manuel SSH yapip known_hosts kaydini duzelt.\n${msg}`;
  }
  if (/No route to host|Network is unreachable/i.test(msg)) {
    return `Ag erisimi yok: ${host}. Sunucu kapali olabilir veya rota/firewall sorunu var.\n${msg}`;
  }
  if (/Broken pipe|send disconnect: Broken pipe|client_loop: send disconnect/i.test(msg)) {
    return `SSH baglantisi koptu: ${host}. Genelde gecici ag kopmasi, NAT timeout, Wi-Fi degisimi veya sshd restart kaynaklidir.\n${msg}`;
  }
  if (/Connection closed by remote host|Connection reset by peer/i.test(msg)) {
    return `SSH oturumu uzak tarafca kapatildi: ${host}. Sunucu, firewall veya ara ag oturumu dusurmus olabilir.\n${msg}`;
  }
  if (/SSH master baglantisi kurulamadi \(16s\):\s*$/i.test(msg) || /banner exchange|kex_exchange_identification|Connection timed out during banner exchange/i.test(msg)) {
    return `SSH cevap vermiyor: ${host}:${server?.port || 22}. Port acik olsa da sshd banner/handshake donmuyor; servis takilmis, yuk altinda veya firewall oturumu bekletiyor olabilir.\n${msg}`;
  }
  return msg;
}

function isTransientSshError(msg) {
  return /zaman asimi|timed out|Connection reset|Broken pipe|network is unreachable|Connection closed by remote host|Connection closed by|reset by peer|send disconnect|mux_client_request_session|ssh_exchange_identification/i.test(String(msg || ''));
}

function runSshPasswordViaPrompt(server, remoteCmd, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const sshArgs = ['-tt', ...buildSshArgs(server, [])];
    const env = { ...process.env, SSHPASS: server.password };
    const child = spawn('sshpass', ['-e', 'ssh', ...sshArgs], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const begin = '__ANYONE_MONITOR_BEGIN__';
    const end = '__ANYONE_MONITOR_END__';
    let stdout = '';
    let stderr = '';
    let sent = false;
    let finished = false;

    const timer = setTimeout(() => {
      finished = true;
      try { child.kill(); } catch {}
      const msg = (stderr || stdout).toString().trim();
      reject(new Error(`zaman asimi (${timeoutMs}ms). ${msg}`.trim()));
    }, timeoutMs);

    const sendPayload = () => {
      if (sent || finished) return;
      sent = true;
      const lines = [
        'stty -echo',
        `printf '${begin}\\n'`,
        remoteCmd,
        'rc=$?',
        `printf '\\n${end}:%s\\n' "$rc"`,
        'stty echo',
        'exit'
      ];
      let i = 0;
      const writeNext = () => {
        if (finished || i >= lines.length) return;
        child.stdin.write(lines[i] + '\n');
        i += 1;
        setTimeout(writeNext, 80);
      };
      setTimeout(writeNext, 120);
    };

    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
      const clean = stdout.replace(/\r/g, '');
      if (!sent && /[#>$] ?$/.test(clean)) sendPayload();
    });

    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      finished = true;
      if (e.code === 'ENOENT') {
        reject(new Error('sshpass kurulu degil. Kur: brew install hudochenkov/sshpass/sshpass'));
      } else {
        reject(e);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      const clean = stdout.replace(/\r/g, '');
      const startIdx = clean.indexOf(begin + '\n');
      if (startIdx >= 0) {
        const body = clean.slice(startIdx + begin.length + 1);
        const m = body.match(new RegExp(`([\\s\\S]*?)\\n${end}:(\\d+)`));
        if (m) {
          const rc = Number(m[2] || 0);
          if (rc === 0) return resolve(stripTerminalNoise(m[1]));
          const msg = normalizeSshError(m[1] || stderr || `rc=${rc}`, server);
          return reject(new Error(msg));
        }
      }
      let msg = normalizeSshError(stderr || clean, server);
      if (!msg) msg = `rc=${code}`;
      reject(new Error(msg));
    });
  });
}

// Non-interactive password-auth path: sshpass injects the password, ssh runs
// `remoteCmd` as a one-shot command (no PTY, no MOTD, no prompt detection).
// Replaces the older interactive `runSshPasswordViaPrompt` for routine polls
// because that path was timing out on slow MOTD-heavy hosts (the 25s budget
// was being eaten by login banner render + 80ms-per-line stdin streaming).
function runSshPasswordOneshot(server, remoteCmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const user = server.user || 'root';
    const host = server.host || server.sshAlias || server.name;
    const args = [
      '-o', 'ConnectTimeout=8',
      '-o', 'ConnectionAttempts=1',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'LogLevel=ERROR',
      '-o', 'TCPKeepAlive=yes',
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=3',
    ];
    if (server.port && server.port !== 22) args.push('-p', String(server.port));
    args.push(`${user}@${host}`, remoteCmd);

    const env = { ...process.env, SSHPASS: server.password };
    execFile('sshpass', ['-e', 'ssh', ...args], {
      env,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.toString());
      if (err.code === 'ENOENT') {
        return reject(new Error('sshpass kurulu degil. Kur: sudo apt-get install -y sshpass'));
      }
      const stderrText = (stderr || '').toString().trim();
      const errMsg = (err.message || '').trim();
      // execFile timeout: killed=true, signal SIGTERM, no exit code
      if (err.killed) {
        return reject(new Error(normalizeSshError(`zaman asimi (${timeoutMs}ms). ${stderrText}`, server)));
      }
      const hint = (typeof err.code === 'number') ? sshpassHint(err.code) : null;
      const msg = hint || stderrText || errMsg || `rc=${err.code}`;
      reject(new Error(normalizeSshError(msg, server)));
    });
  });
}

function runSsh(server, remoteCmd, timeoutMs = 10000) {
  // Password-auth: non-interactive sshpass. The older interactive path
  // (runSshPasswordViaPrompt) is kept for callers that explicitly need a TTY
  // (sudo prompts etc.) but is no longer the default — it timed out on slow
  // MOTD hosts and polluted error messages with the login banner.
  if (server.password) {
    const passAttempt = runSshPasswordOneshot(server, remoteCmd, Math.max(timeoutMs, 12000));
    if (!server.sshAlias && !server.key) return passAttempt;
    return passAttempt.catch((passErr) => {
      const msg = String(passErr && passErr.message || passErr || '');
      if (!/Permission denied|Kimlik dogrulama basarisiz|Parola HATALI|password auth kapali/i.test(msg)) throw passErr;
      const keyServer = { ...server, password: '', passwordRef: '' };
      return runSsh(keyServer, remoteCmd, timeoutMs).catch((keyErr) => {
        const keyMsg = String(keyErr && keyErr.message || keyErr || '');
        throw new Error(`${msg}\nSSH alias/key fallback da basarisiz: ${keyMsg}`);
      });
    });
  }

  // Key-auth path (unchanged)
  return new Promise((resolve, reject) => {
    const tryRun = (reuseControlMaster) => {
      const sshArgs = buildSshArgs(server, [remoteCmd], { reuseControlMaster });
      const child = execFile('ssh', sshArgs, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout.toString());
        const stderrText = (stderr?.toString().trim()) || '';
        const errMsg = (err.message || '').trim();
        const rc = err.code;
        if (rc === 'ENOENT') {
          return reject(new Error('ssh komutu bulunamadi (PATH sorunu). ' + errMsg));
        }
        const normalized = normalizeSshError(`zaman asimi (${timeoutMs}ms). ${stderrText || errMsg}`, server);
        if (reuseControlMaster && isTransientSshError(normalized)) {
          return tryRun(false);
        }
        if (err.killed || /ETIMEDOUT|timed out/i.test(errMsg)) {
          return reject(new Error(normalized));
        }
        const msg = stderrText || errMsg || `rc=${rc}`;
        return reject(new Error(normalizeSshError(msg, server)));
      });
      child.on('error', (e) => {
        if (e.code === 'ENOENT') {
          return reject(new Error('ssh komutu bulunamadi (PATH sorunu). ' + e.message));
        }
        const normalized = normalizeSshError(e.message || String(e), server);
        if (reuseControlMaster && isTransientSshError(normalized)) {
          return tryRun(false);
        }
        reject(new Error(normalized));
      });
    };
    tryRun(true);
  });
}

function fetchAgent(server) {
  return new Promise((resolve, reject) => {
    const host = server.host || server.sshAlias || server.name;
    const port = server.agentPort || 19191;
    const token = server.agentToken || '';
    const configuredScheme = String(server.agentScheme || '').toLowerCase();
    const schemes = configuredScheme ? [configuredScheme] : ['https', 'http'];

    const tryScheme = (idx, lastErr) => {
      if (idx >= schemes.length) {
        return reject(lastErr || new Error('Agent baglanti hatasi'));
      }
      const scheme = schemes[idx];
      const mod = scheme === 'https' ? https : http;
      const opts = {
        hostname: host,
        port,
        path: '/metrics',
        method: 'GET',
        timeout: 6000,
        headers: token ? { 'X-Agent-Token': token } : {},
      };
      if (scheme === 'https') {
        // Self-signed relay-local certs are acceptable here; auth is still enforced by token.
        opts.rejectUnauthorized = false;
      }
      const req = mod.request(opts, (res) => {
        if (res.statusCode === 403) return reject(new Error('Agent token hatali'));
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Agent JSON parse hatasi: ' + e.message)); }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        const err = new Error(`Agent ${scheme.toUpperCase()} zaman asimi (6s)`);
        if (!configuredScheme && idx + 1 < schemes.length) return tryScheme(idx + 1, err);
        reject(err);
      });
      req.on('error', (e) => {
        const err = new Error(`Agent ${scheme.toUpperCase()} baglanti hatasi: ` + e.message);
        if (!configuredScheme && idx + 1 < schemes.length) return tryScheme(idx + 1, err);
        reject(err);
      });
      req.end();
    };

    tryScheme(0);
  });
}

function parseSections(text) {
  const sections = {};
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let cur = null;
  let buf = [];
  for (const line of lines) {
    const m = line.match(/^===([A-Z]+)===$/);
    if (m) {
      if (cur) sections[cur] = buf.join('\n');
      cur = m[1];
      buf = [];
    } else if (cur) {
      buf.push(line);
    }
  }
  if (cur) sections[cur] = buf.join('\n');
  return sections;
}

function parseNetDev(text, iface) {
  // /proc/net/dev — 2 header lines, then rows: "iface: rx_bytes rx_packets ... tx_bytes tx_packets ..."
  const lines = text.split('\n');
  for (const ln of lines) {
    const t = ln.trim();
    if (!t || t.startsWith('Inter-') || t.startsWith('face')) continue;
    const idx = t.indexOf(':');
    if (idx < 0) continue;
    const name = t.slice(0, idx).trim();
    if (iface && name !== iface) continue;
    const cols = t.slice(idx + 1).trim().split(/\s+/).map(Number);
    // rx: bytes=0, packets=1, errs=2, drop=3
    // tx: bytes=8, packets=9
    if (cols.length >= 10) return { iface: name, rx: cols[0], tx: cols[8] };
  }
  return null;
}

function parseCpu(text) {
  // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
  const parts = text.trim().split(/\s+/);
  if (parts[0] !== 'cpu') return null;
  const nums = parts.slice(1).map(Number);
  const idle = nums[3] + (nums[4] || 0);
  const total = nums.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function parseCpuCount(text) {
  const n = Number(String(text || '').trim().split(/\s+/)[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function parseMem(text) {
  const out = {};
  for (const ln of text.split('\n')) {
    const [k, v] = ln.trim().split(/\s+/);
    if (k && v) out[k.replace(/:$/, '')] = Number(v); // kB
  }
  const total = out.MemTotal || 0;
  const avail = out.MemAvailable || 0;
  return { totalMB: Math.round(total / 1024), usedMB: Math.round((total - avail) / 1024), pct: total ? Math.round(((total - avail) / total) * 100) : 0 };
}

function parseDisk(text) {
  // "/dev/sda1  total  used  avail  pct%  /"
  const t = text.trim().split(/\s+/);
  if (t.length < 5) return null;
  return {
    totalKB: Number(t[1] || 0),
    usedKB: Number(t[2] || 0),
    availKB: Number(t[3] || 0),
    usedPct: Number((t[4] || '0').replace('%', '')),
  };
}

function parseAnon(text) {
  // Each line is either "<svc>=<state>" for a service probe, or a
  // comma-separated port list (the last non-empty line).
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const services = {};
  let ports = [];
  for (const ln of lines) {
    const m = ln.match(/^([A-Za-z0-9@_.\-]+)=(\w+)$/);
    if (m) services[m[1]] = m[2];
    else if (ln.includes(':')) ports = ln.split(',').filter(Boolean);
  }
  // "active" = any probed service reports active, OR (only when no service
  // status was detected at all) listening ports on the anon range.
  // Port-only detection is intentionally suppressed when services are known
  // to be inactive/failed — otherwise a lingering socket after a crash keeps
  // the card green even though the relay is down.
  const anyActive = Object.values(services).some(v => v === 'active' || v === 'activating');
  const anyKnown = Object.keys(services).length > 0;
  const portActive = !anyKnown && ports.length > 0;
  // ÖNEMLI: Hiç veri okunamadıysa (servis durumu YOK + port YOK), bu "servis kapalı"
  // demek DEĞİL — SSH/agent çıktısı eksik/boş gelmiş demek. Bu durumda 'unknown' dön.
  // 'inactive' dönmek yanlış auto-fix tetiklenmesine ve gereksiz restart döngüsüne yol açıyordu.
  const noDataAtAll = !anyKnown && ports.length === 0;
  const active = (anyActive || portActive) ? 'active'
    : noDataAtAll ? 'unknown'
    : (Object.values(services).find(v => v && v !== 'active') || 'inactive');
  return { active, ports, services };
}

class Monitor extends EventEmitter {
  constructor(cfg, opts = {}) {
    super();
    this.servers = cfg.servers || [];
    // Default to 30s polling to keep the dashboard fresh without excessive SSH churn.
    this.pollMs = cfg.pollMs || 10000;
    // 'https' = use agent if agentEnabled, 'ssh' = always use SSH regardless of agentEnabled
    this.connectionMode = cfg.connectionMode || 'https';
    this.state = new Map();   // name -> { prev, prevT, cpuPrev, lastOkTs, fails }
    this.timers = new Map();  // name -> { intervalId, startupId }
    this.logStreams = new Map(); // name -> child process
    // Log cache: stores last known good logs per server so AI auto-fix has context
    // even when SSH is failing (relay offline). Updated on every successful SSH poll
    // and also fetched eagerly on the first failure (stale state) while SSH is still up.
    this._logCache = new Map(); // name -> { ts, lines, anonState, source }
    // Flap dampening: how many consecutive failures before we flip the card
    // from "stale" (last known data, yellow) to "offline" (red).
    this.OFFLINE_AFTER = 2;
    // Debug log: append poll failures to a file so we can share it with support.
    this.debugLogPath = opts.debugLogPath || null;
    if (this.debugLogPath) {
      try { fs.appendFileSync(this.debugLogPath, `\n=== app start ${new Date().toISOString()} ===\n`); } catch {}
    }
  }
  _logDebug(line) {
    if (!this.debugLogPath) return;
    try {
      fs.appendFileSync(this.debugLogPath, `[${new Date().toISOString()}] ${line}\n`);
    } catch {}
  }
  start() {
    for (const s of this.servers) this._startTimer(s);
  }
  stop() {
    for (const t of this.timers.values()) {
      try { clearInterval(t.intervalId); } catch {}
      try { clearTimeout(t.startupId); } catch {}
    }
    this.timers.clear();
    for (const p of this.logStreams.values()) { try { p.kill(); } catch {} }
    this.logStreams.clear();
    // Close all ControlMaster sockets so we don't leave orphan ssh processes.
    for (const s of this.servers) this._closeMaster(s).catch(() => {});
  }
  _closeMaster(server) {
    return new Promise((resolve) => {
      const sock = server.password ? _pwSocketPath(server) : controlSocketPath(server);
      if (!fs.existsSync(sock)) return resolve();
      const user = server.user || 'root';
      const host = server.sshAlias || server.host || server.name;
      execFile('ssh', ['-S', sock, '-O', 'exit', `${user}@${host}`], { timeout: 3000 }, () => resolve());
    });
  }
  updateServers(next) {
    const nextByName = new Map(next.map(s => [s.name, s]));
    const keep = new Set(nextByName.keys());
    // Remove gone servers.
    for (const name of Array.from(this.timers.keys())) {
      if (!keep.has(name)) {
        const timer = this.timers.get(name);
        if (timer) {
          clearInterval(timer.intervalId);
          clearTimeout(timer.startupId);
        }
        this.timers.delete(name);
        this.state.delete(name);
        this.stopLogStream(name);
        // Best-effort close of the gone server's control master socket.
        const old = this.servers.find(x => x.name === name);
        if (old) this._closeMaster(old).catch(() => {});
      }
    }

    // Existing timers close over the original server object. If connection
    // settings change after Save, polling would keep using stale host/alias/key
    // values until a full app restart. Restart only the changed server timers.
    for (const old of this.servers) {
      const fresh = nextByName.get(old.name);
      if (!fresh) continue;
      if (serverConnectionKey(old) === serverConnectionKey(fresh)) continue;

      const timer = this.timers.get(old.name);
      if (timer) {
        clearInterval(timer.intervalId);
        clearTimeout(timer.startupId);
      }
      this.timers.delete(old.name);
      this.state.delete(old.name);
      this.stopLogStream(old.name);
      this._closeMaster(old).catch(() => {});
    }

    this.servers = next;
    for (const s of next) {
      if (!this.timers.has(s.name)) this._startTimer(s);
    }
  }
  updateSettings(s) {
    if (s.connectionMode && s.connectionMode !== this.connectionMode) {
      this.connectionMode = s.connectionMode;
    }
    if (s.pollMs && s.pollMs !== this.pollMs) {
      this.pollMs = s.pollMs;
      // Restart timers with new interval.
      for (const name of Array.from(this.timers.keys())) {
        const timer = this.timers.get(name);
        if (timer) {
          clearInterval(timer.intervalId);
          clearTimeout(timer.startupId);
        }
        this.timers.delete(name);
      }
      for (const srv of this.servers) this._startTimer(srv);
    }
  }
  _startTimer(server) {
    const tick = () => {
      // Skip this tick if the previous poll for this server is still in flight.
      // This prevents buildup when a host is down (10s timeout with a 3s interval
      // would otherwise spawn 3+ overlapping ssh processes — exhausting NAT/fd).
      if (this.inflight && this.inflight.get(server.name)) return;
      if (!this.inflight) this.inflight = new Map();
      this.inflight.set(server.name, true);
      this._poll(server)
        .catch(() => {})
        .finally(() => this.inflight.delete(server.name));
    };
    const index = Math.max(0, this.servers.findIndex((s) => s.name === server.name));
    // Tüm relayları en fazla 30 saniyede başlat. 92 relay → ~326ms arayla başlar.
    // Eskisi: min 5000ms spread → 92 relay × 5s = 7.5 dakika bekleme (BEKLENİYOR sorunu).
    const MAX_TOTAL_SPREAD_MS = 30000;
    const spread = Math.max(200, Math.min(Math.floor(MAX_TOTAL_SPREAD_MS / Math.max(this.servers.length || 1, 1)), 2000));
    const initialDelay = index * spread;
    // Interval'i ilk tick'ten SONRA kur. Aksi halde setInterval hemen kurulduğu
    // için tüm relaylar aynı anda ateşler (initialDelay sadece ilk tick'i kaydırır)
    // ve her pollMs'te 143 eşzamanlı SSH açılır → MaxStartups/timeout uyarıları.
    const entry = { intervalId: null, startupId: null };
    entry.startupId = setTimeout(() => {
      entry.intervalId = setInterval(tick, this.pollMs);
      tick();
    }, initialDelay);
    this.timers.set(server.name, entry);
  }
  async _poll(server) {
    const t0 = Date.now();
    try {
      let iface, net, conn, mem, load, disk, cpu, cpuCount, anon, uptime, publicIp, fingerprint, warnLines = [];

      // connectionMode=ssh → skip agent entirely and go straight to SSH.
      // agentEnabled: try HTTP agent first. On 403 (token mismatch), SSH into
      // the server to read the real token from the systemd service file and
      // retry once. If the retry also fails, fall back to SSH polling so the
      // card stays online.
      let agentTokenFailed = false;
      if (server.agentEnabled && this.connectionMode !== 'ssh') {
        try {
          const d = await fetchAgent(server);
          iface = d.iface || null;
          net = d.net || null;
          conn = d.conn || 0;
          mem = d.mem || { totalMB: 0, usedMB: 0, pct: 0 };
          load = Array.isArray(d.load) ? d.load : [0, 0, 0];
          disk = d.disk || null;
          cpu = d.cpu || null;
          cpuCount = d.cpuCount || null;
          anon = d.anon || { active: 'unknown', ports: [], services: {} };
          uptime = d.uptime || '';
          publicIp = d.publicIp || '';
        } catch (agentErr) {
          if (/token hatali/i.test(agentErr.message)) {
            // Try to auto-fix: SSH in, read real token, retry agent once.
            try {
              const fixedToken = await this._fetchRemoteAgentToken(server);
              if (fixedToken) {
                server.agentToken = fixedToken;
                this.emit('agentTokenFixed', { name: server.name, token: fixedToken });
                const d2 = await fetchAgent(server);
                iface = d2.iface || null;
                net = d2.net || null;
                conn = d2.conn || 0;
                mem = d2.mem || { totalMB: 0, usedMB: 0, pct: 0 };
                load = Array.isArray(d2.load) ? d2.load : [0, 0, 0];
                disk = d2.disk || null;
                cpu = d2.cpu || null;
                cpuCount = d2.cpuCount || null;
                anon = d2.anon || { active: 'unknown', ports: [], services: {} };
                uptime = d2.uptime || '';
                publicIp = d2.publicIp || '';
              } else {
                agentTokenFailed = true;
              }
            } catch {
              agentTokenFailed = true;
            }
          } else {
            // Agent bağlanamadı (connection refused, timeout vs.) — SSH fallback dene.
            // Böylece relay gerçekten offline mi SSH de kontrol eder; agent olmadan da veri alınır.
            agentTokenFailed = true;
          }
        }
      }
      // SSH ile poll et: connectionMode 'ssh' ise (agent bypass) VEYA agent yoksa
      // VEYA agent denenip basarisiz olduysa. ÖNCEKİ BUG: connectionMode='ssh' +
      // agentEnabled=true olan sunucularda hem agent yolu (mode!=='ssh' false) hem de
      // bu SSH yolu (!agentEnabled false) atlaniyordu → hicbir veri pollanmiyor, anon
      // undefined kaliyor ve anon-inactive auto-fix tetiklenemiyordu.
      if (this.connectionMode === 'ssh' || !server.agentEnabled || agentTokenFailed) {
        // With ControlMaster, all polls after the first one are cheap (no
        // handshake), so the worst case is the initial master setup. Give it
        // up to ~20s to tolerate slow networks, but never more than 2x pollMs
        // so we don't pile up.
        const sshTimeout = Math.max(12000, Math.min(25000, this.pollMs * 2));
        let stdout;
        try {
          stdout = await runSsh(server, REMOTE_SCRIPT, sshTimeout);
        } catch (firstErr) {
          const msg = (firstErr && firstErr.message) || '';
          const transient = isTransientSshError(msg);
          if (!transient) throw firstErr;
          await new Promise(r => setTimeout(r, 500));
          try {
            stdout = await runSsh(server, REMOTE_SCRIPT, sshTimeout);
          } catch (secondErr) {
            const secondMsg = (secondErr && secondErr.message) || '';
            if (!isTransientSshError(secondMsg)) throw secondErr;
            await new Promise(r => setTimeout(r, 800));
            throw secondErr;
          }
        }
        const sec = parseSections(stdout);
        iface = (sec.IFACE || '').trim().split('\n')[0] || null;
        net = parseNetDev(sec.NETDEV || '', iface);
        conn = Number((sec.CONN || '0').trim()) || 0;
        mem = parseMem(sec.MEM || '');
        load = (sec.LOAD || '').trim().split(/\s+/).slice(0, 3).map(Number);
        disk = parseDisk(sec.DISK || '');
        cpu = parseCpu(sec.CPU || '');
        cpuCount = parseCpuCount(sec.CPUCOUNT || '');
        anon = parseAnon(sec.ANON || '');
        uptime = (sec.UPTIME || '').trim();
        publicIp = (sec.PUBIP || '').trim().split('\n')[0] || '';
        const fpRaw = (sec.FINGERPRINT || '').trim().split('\n')[0] || '';
        if (/^[A-Fa-f0-9]{40}$/.test(fpRaw)) fingerprint = fpRaw.toUpperCase();
        // WARN lines from journalctl — deduplicated, max 8
        const rawWarnLines = (sec.WARNS || '').split('\n').map(l => l.trim()).filter(l => l && l.includes('[WARN]'));
        const seen = new Set();
        warnLines = rawWarnLines.filter(l => { const k = l.replace(/^[A-Za-z]+ \d+ \d+:\d+:\d+ \S+ [^:]+:\s*/, ''); return seen.has(k) ? false : (seen.add(k), true); });
      }

      const prev = this.state.get(server.name) || {};
      let rxMbps = 0, txMbps = 0, cpuPct = 0;
      if (prev.net && net) {
        const dt = (t0 - prev.t) / 1000;
        if (dt > 0) {
          rxMbps = Math.max(0, ((net.rx - prev.net.rx) * 8) / 1_000_000 / dt);
          txMbps = Math.max(0, ((net.tx - prev.net.tx) * 8) / 1_000_000 / dt);
        }
      }
      if (prev.cpu && cpu) {
        const di = cpu.idle - prev.cpu.idle;
        const dt = cpu.total - prev.cpu.total;
        if (dt > 0) cpuPct = Math.max(0, Math.min(100, Math.round(((dt - di) / dt) * 100)));
      }
      // Reset fail counter on success, record lastOk.
      this.state.set(server.name, { ...prev, net, t: t0, cpu, lastOkTs: t0, fails: 0 });
      // Update log cache with current warn lines + anon state (used by AI auto-fix as fallback).
      if (warnLines.length) {
        this._logCache.set(server.name, { ts: t0, lines: warnLines, anonState: anon, source: 'poll-warns' });
      }

      const snap = {
        name: server.name,
        ok: true,
        state: 'online',
        ts: t0,
        iface,
        rxMbps, txMbps,
        conn,
        mem, load, disk, cpuPct, cpuCount,
        anon,
        uptime,
        publicIp,
        fingerprint: fingerprint || undefined,
        warnLines: warnLines.length ? warnLines : undefined,
      };
      this.emit('snapshot', snap);
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      const prev = this.state.get(server.name) || {};
      const fails = (prev.fails || 0) + 1;
      this.state.set(server.name, { ...prev, fails });
      // Card is only "offline" (red) after N consecutive failures. Before
      // that it's "stale" (yellow) — keep the last good numbers visible so
      // the user doesn't see flapping for transient network blips.
      const state = fails >= this.OFFLINE_AFTER ? 'offline' : 'stale';
      this._logDebug(`${server.name} FAIL (${fails}x, ${state}): ${errMsg.replace(/\n/g, ' | ').slice(0, 300)}`);
      // On the first failure (stale) fetch and cache logs while SSH may still be reachable.
      // By the time the relay flips to offline (2nd failure), AI auto-fix has recent logs.
      if (state === 'stale' && !this._logCache.has(server.name)) {
        this.fetchLogs(server.name, 80).then(r => {
          if (r.ok && r.lines.length) {
            this._logCache.set(server.name, { ts: t0, lines: r.lines, anonState: null, source: 'stale-fetch' });
          }
        }).catch(() => {});
      }
      this.emit('snapshot', { name: server.name, ok: false, state, ts: t0, fails, error: errMsg });
    } finally {
      this._emitAggregate();
    }
  }
  _emitAggregate() {
    let online = 0, rx = 0, tx = 0;
    for (const s of this.servers) {
      const st = this.state.get(s.name);
      // Count only servers that are still within the flap-dampening window.
      // After OFFLINE_AFTER consecutive failures the tray should stop showing
      // the host as online even though we still keep its last net counters.
      if (st && (st.fails || 0) < this.OFFLINE_AFTER && st.net) online++;
    }
    // Sum of last-known rates — we need to pull them from somewhere; keep
    // a rolling lastRates map.
    for (const s of this.servers) {
      const r = this._lastRates?.get(s.name);
      if (r) { rx += r.rx; tx += r.tx; }
    }
    this.emit('aggregate', { online, total: this.servers.length, totalRxMbps: rx, totalTxMbps: tx });
  }
  // Override emit('snapshot') to cache last rates for the aggregate calc.
  emit(evt, payload) {
    if (evt === 'snapshot' && payload && payload.ok) {
      if (!this._lastRates) this._lastRates = new Map();
      this._lastRates.set(payload.name, { rx: payload.rxMbps || 0, tx: payload.txMbps || 0 });
    }
    return super.emit(evt, payload);
  }

  async _fetchRemoteAgentToken(server) {
    try {
      const out = await runSsh(server,
        "grep -oP '(?<=AGENT_TOKEN=)\\S+' /etc/systemd/system/anyone-agent.service 2>/dev/null || true",
        10000);
      const token = out.trim().split('\n')[0].trim();
      return token || null;
    } catch {
      return null;
    }
  }

  async testServer(server) {
    try {
      const out = await runSsh(server, 'echo OK && hostname && (which anon 2>/dev/null || echo no-anon)', 8000);
      return { ok: true, output: out.trim() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async runCommand(serverName, command, timeoutMs = 30000) {
    const server = this.servers.find(s => s.name === serverName);
    if (!server) return { ok: false, error: 'server bulunamadi: ' + serverName };
    try {
      const out = await runSsh(server, command, timeoutMs);
      return { ok: true, output: out.trim() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async auditRelay(server) {
    try {
      const cmd = `ANONRC=""
LOCAL_IP=$(echo $SSH_CONNECTION | awk '{print $3}')
# Try IP-matched anonrc first (multi-instance servers)
if [ -n "$LOCAL_IP" ]; then
  for rc in /etc/anon/anonrc-* /etc/anon/instances/*/anonrc; do
    [ -f "$rc" ] || continue
    if grep -q "^Address $LOCAL_IP" "$rc" 2>/dev/null; then
      ANONRC="$rc"
      break
    fi
  done
fi
# Fallback to default paths
if [ -z "$ANONRC" ]; then
  for p in /etc/anon/anonrc /usr/local/etc/anon/anonrc /etc/tor/torrc; do
    [ -f "$p" ] && ANONRC="$p" && break
  done
fi
echo "ANONRC=$ANONRC"
if [ -n "$ANONRC" ]; then
  awk '/^(ContactInfo|MyFamily|Nickname)/ {print}' "$ANONRC" 2>/dev/null || true
fi
# Find fingerprint in DataDirectory matching the anonrc
FP_FILE=""
if [ -n "$ANONRC" ]; then
  DATADIR=$(grep '^DataDirectory' "$ANONRC" 2>/dev/null | awk '{print $2}' | head -1)
  [ -n "$DATADIR" ] && [ -f "$DATADIR/fingerprint" ] && FP_FILE="$DATADIR/fingerprint"
fi
[ -z "$FP_FILE" ] && [ -f /var/lib/anon/fingerprint ] && FP_FILE=/var/lib/anon/fingerprint
[ -z "$FP_FILE" ] && [ -f /var/lib/tor/fingerprint ] && FP_FILE=/var/lib/tor/fingerprint
if [ -n "$FP_FILE" ]; then
  awk 'NR==1 { for (i=1; i<=NF; i++) { fp=$i; sub(/^\\$/, "", fp); if (fp ~ /^[A-Fa-f0-9]{40}$/) { print "FINGERPRINT=" fp; exit } } }' "$FP_FILE"
fi
if command -v anon >/dev/null 2>&1; then
  echo "ANON_VERSION=$(anon --version 2>/dev/null | head -1)"
elif [ -x /usr/bin/anon ]; then
  echo "ANON_VERSION=$(/usr/bin/anon --version 2>/dev/null | head -1)"
fi
MULTI_SVCS2=$(systemctl list-units --state=active,activating,failed --no-legend --plain 'anon@*' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
NAMED_SVCS2=$(systemctl list-units --state=active,activating,failed --no-legend --plain 'anon[0-9]*.service' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
for svc in $MULTI_SVCS2 $NAMED_SVCS2 anon.service anon anon@default anyone anyone-relay tor-anon; do
  s=$(systemctl is-active "$svc" 2>/dev/null || true)
  [ -n "$s" ] && echo "SERVICE=$svc:$s" && break
done`;
      const out = await runSsh(server, cmd, 12000);
      const parsed = {};
      for (const line of out.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) parsed[line.slice(0, idx)] = line.slice(idx + 1).trim();
      }
      const contact = (out.match(/^ContactInfo\s+(.+)$/m) || [])[1] || '';
      const myFamilyLines = out.split('\n')
        .map((line) => (line.match(/^MyFamily\s+(.+)$/) || [])[1] || '')
        .filter(Boolean);
      const myFamily = myFamilyLines[0] || '';
      const nickname = (out.match(/^Nickname\s+(.+)$/m) || [])[1] || '';
      return { ok: true, output: out.trim(), parsed: { ...parsed, contact, myFamily, myFamilyLines, nickname } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async bindRelayWallet(server, wallet) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(String(wallet || ''))) {
      return { ok: false, error: 'Gecersiz wallet adresi. 0x ile baslayan 42 karakter olmali.' };
    }
    try {
      const cmd = `set -e
WALLET="${wallet}"
LOCAL_IP=$(echo $SSH_CONNECTION | awk '{print $3}')
ANONRC=""
if [ -n "$LOCAL_IP" ]; then
  for rc in /etc/anon/anonrc-* /etc/anon/instances/*/anonrc; do
    [ -f "$rc" ] || continue
    grep -q "^Address $LOCAL_IP" "$rc" 2>/dev/null && ANONRC="$rc" && break
  done
fi
if [ -z "$ANONRC" ]; then
  for p in /etc/anon/anonrc /usr/local/etc/anon/anonrc /etc/tor/torrc; do
    [ -f "$p" ] && ANONRC="$p" && break
  done
fi
if [ -z "$ANONRC" ]; then
  echo 'anonrc not found' >&2
  exit 1
fi
if grep -q '^ContactInfo ' "$ANONRC"; then
  sed -i.bak -E "s|^ContactInfo .*|ContactInfo @anon: ${wallet}|" "$ANONRC"
else
  printf '\nContactInfo @anon: ${wallet}\n' >> "$ANONRC"
fi
VERIFY=skipped
if command -v anon >/dev/null 2>&1; then
  anon -f "$ANONRC" --verify-config >/tmp/anyone-wallet-verify.log 2>&1
  VERIFY=ok
elif [ -x /usr/bin/anon ]; then
  /usr/bin/anon -f "$ANONRC" --verify-config >/tmp/anyone-wallet-verify.log 2>&1
  VERIFY=ok
fi
RESTARTED=none
MULTI_SVCS3=$(systemctl list-units --state=active,activating,failed --no-legend --plain 'anon@*' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
NAMED_SVCS3=$(systemctl list-units --state=active,activating,failed --no-legend --plain 'anon[0-9]*.service' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
for svc in $MULTI_SVCS3 $NAMED_SVCS3 anon.service anon anon@default anyone anyone-relay tor-anon; do
  if systemctl status "$svc" >/dev/null 2>&1; then
    systemctl restart "$svc"
    RESTARTED="$svc"
    break
  fi
done
echo "ANONRC=$ANONRC"
echo "VERIFY=$VERIFY"
echo "RESTARTED=$RESTARTED"
grep '^ContactInfo ' "$ANONRC" || true`;
      const out = await runSsh(server, cmd, 20000);
      return { ok: true, output: out.trim() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Read /etc/anon/anonrc (or fallback paths) from the remote server. Returns
  // { ok, path, content } on success, { ok:false, error } otherwise.
  async readAnonrc(server) {
    // Wrap in subshell so `exit` doesn't terminate the parent interactive shell
    // when this runs via runSshPasswordViaPrompt (password-auth servers).
    const cmd = `(set -e
LOCAL_IP=$(echo $SSH_CONNECTION | awk '{print $3}')
ANONRC=""
if [ -n "$LOCAL_IP" ]; then
  for rc in /etc/anon/anonrc-* /etc/anon/instances/*/anonrc; do
    [ -f "$rc" ] || continue
    grep -q "^Address $LOCAL_IP" "$rc" 2>/dev/null && ANONRC="$rc" && break
  done
fi
if [ -z "$ANONRC" ]; then
  for p in /etc/anon/anonrc /usr/local/etc/anon/anonrc /etc/tor/torrc; do
    [ -f "$p" ] && ANONRC="$p" && break
  done
fi
if [ -z "$ANONRC" ]; then
  echo 'anonrc not found' >&2
  exit 1
fi
printf '===ANONRC_PATH===\n%s\n' "$ANONRC"
printf '===ANONRC_BEGIN===\n'
cat "$ANONRC"
printf '\n===ANONRC_END===\n')`;
    try {
      const out = await runSsh(server, cmd, 25000);
      const clean = String(out || '').replace(/\r/g, '');
      const pathMatch = clean.match(/===ANONRC_PATH===\n([^\n]+)/);
      const bodyMatch = clean.match(/===ANONRC_BEGIN===\n([\s\S]*?)\n===ANONRC_END===/);
      if (!pathMatch || !bodyMatch) return { ok: false, error: 'could not parse remote output' };
      return { ok: true, path: pathMatch[1].trim(), content: bodyMatch[1] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Write new anonrc content. We stream it over stdin (base64 encoded on the
  // wire) to avoid shell-quoting hell with the user's content. Optionally
  // verify-config and restart anon. On verify failure we restore the .bak.
  //
  //   opts = { restart: true|false, verify: true|false }
  //
  // Returns { ok, path, verify, restarted, output }.
  async writeAnonrc(server, content, opts = {}) {
    const { restart = true, verify = true } = opts;
    const b64 = Buffer.from(String(content), 'utf8').toString('base64');
    const cmd = `(set -e
LOCAL_IP=$(echo $SSH_CONNECTION | awk '{print $3}')
ANONRC=""
if [ -n "$LOCAL_IP" ]; then
  for rc in /etc/anon/anonrc-* /etc/anon/instances/*/anonrc; do
    [ -f "$rc" ] || continue
    grep -q "^Address $LOCAL_IP" "$rc" 2>/dev/null && ANONRC="$rc" && break
  done
fi
if [ -z "$ANONRC" ]; then
  for p in /etc/anon/anonrc /usr/local/etc/anon/anonrc /etc/tor/torrc; do
    [ -f "$p" ] && ANONRC="$p" && break
  done
fi
if [ -z "$ANONRC" ]; then
  echo 'anonrc not found' >&2
  exit 1
fi
cp -a "$ANONRC" "$ANONRC.bak"
printf %s '${b64}' | base64 -d > "$ANONRC.new"
mv "$ANONRC.new" "$ANONRC"
chown --reference "$ANONRC.bak" "$ANONRC" 2>/dev/null || true
chmod --reference "$ANONRC.bak" "$ANONRC" 2>/dev/null || true
VERIFY=skipped
${verify ? `if command -v anon >/dev/null 2>&1; then
  if ! anon -f "$ANONRC" --verify-config >/tmp/anyone-anonrc-verify.log 2>&1; then
    if grep -qiE 'User has not agreed to the terms|Not agreed to terms|/root/\\.anon/anons\\.tmp|No such file or directory' /tmp/anyone-anonrc-verify.log 2>/dev/null; then
      VERIFY=skipped_terms
    else
      echo "VERIFY_FAILED"
      cat /tmp/anyone-anonrc-verify.log
      # roll back only on real config failures
      mv "$ANONRC.bak" "$ANONRC"
      exit 2
    fi
  else
    VERIFY=ok
  fi
fi` : ''}
RESTARTED=none
${restart ? `MULTI_SVCS4=$(systemctl list-units --state=active,activating,failed --no-legend --plain 'anon@*' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
NAMED_SVCS4=$(systemctl list-units --state=active,activating,failed --no-legend --plain 'anon[0-9]*.service' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
for svc in $MULTI_SVCS4 $NAMED_SVCS4 anon.service anon anon@default anyone anyone-relay tor-anon; do
  if systemctl status "$svc" >/dev/null 2>&1; then
    systemctl restart "$svc"
    RESTARTED="$svc"
    break
  fi
done
sleep 2
ACTIVE=unknown
if [ "$RESTARTED" != none ]; then
  ACTIVE=$(systemctl is-active "$RESTARTED" 2>/dev/null || echo unknown)
fi
echo "ACTIVE=$ACTIVE"` : ''}
echo "ANONRC=$ANONRC"
echo "VERIFY=$VERIFY"
echo "RESTARTED=$RESTARTED")`;
    try {
      const out = await runSsh(server, cmd, 35000);
      const info = {
        ok: true,
        path: (out.match(/ANONRC=(.+)/) || [])[1] || '',
        verify: (out.match(/VERIFY=(\w+)/) || [])[1] || 'skipped',
        restarted: (out.match(/RESTARTED=(\S+)/) || [])[1] || 'none',
        active: (out.match(/ACTIVE=(\S+)/) || [])[1] || '',
        output: out.trim(),
      };
      return info;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Write /etc/fail2ban/jail.d/whitelist.local on the remote so our IP isn't
  // banned by the poll traffic, then unban anything currently jailed and
  // bounce fail2ban. Also makes sure sshd is up. Idempotent.
  async whitelistIp(server, ip) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(ip || ''))) {
      return { ok: false, error: 'Gecersiz IP: ' + ip };
    }
    const cmd = `set -e
mkdir -p /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/whitelist.local <<WL
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 ${ip}
WL
fail2ban-client unban --all 2>/dev/null || true
if command -v fail2ban-client >/dev/null 2>&1; then
  systemctl restart fail2ban 2>/dev/null || true
fi
systemctl is-active ssh 2>/dev/null || systemctl start ssh 2>/dev/null || true
echo "FB=$(systemctl is-active fail2ban 2>/dev/null || echo missing)"
echo "SSH=$(systemctl is-active ssh 2>/dev/null)"
echo "DONE"`;
    try {
      const out = await runSsh(server, cmd, 20000);
      return {
        ok: true,
        output: out.trim(),
        fail2ban: (out.match(/FB=(\S+)/) || [])[1] || '',
        sshd: (out.match(/SSH=(\S+)/) || [])[1] || '',
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async setupHealthCheck(server) {
    const cmd = `
LOCAL_IP=$(echo $SSH_CONNECTION | awk '{print $3}')
ANONRC=""
if [ -n "$LOCAL_IP" ]; then
  for rc in /etc/anon/anonrc-* /etc/anon/instances/*/anonrc; do
    [ -f "$rc" ] || continue
    grep -q "^Address $LOCAL_IP" "$rc" 2>/dev/null && ANONRC="$rc" && break
  done
fi
if [ -z "$ANONRC" ]; then
  for p in /etc/anon/anonrc /usr/local/etc/anon/anonrc /etc/tor/torrc; do
    [ -f "$p" ] && ANONRC="$p" && break
  done
fi

# 1. anonrc var mi?
if [ -n "$ANONRC" ]; then
  echo "CHECK_ANONRC=ok:$ANONRC"
else
  echo "CHECK_ANONRC=err:anonrc bulunamadi (/etc/anon/anonrc)"
fi

# 2. exit-notice.html
HAS_DIRPORT_CFG=0
[ -n "$ANONRC" ] && grep -q '^DirPortFrontPage' "$ANONRC" 2>/dev/null && HAS_DIRPORT_CFG=1
if [ -f /etc/anon/anyone-exit-notice.html ]; then
  echo "CHECK_EXIT_NOTICE=ok:mevcut (/etc/anon/anyone-exit-notice.html)"
elif [ "$HAS_DIRPORT_CFG" = "1" ]; then
  echo "CHECK_EXIT_NOTICE=warn:dosya yok ama anonrc'de DirPortFrontPage tanimli — olustur: mkdir -p /etc/anon && echo '<html><body>Exit Node</body></html>' > /etc/anon/anyone-exit-notice.html"
else
  echo "CHECK_EXIT_NOTICE=ok:gerekmiyor (DirPortFrontPage anonrc'de yok)"
fi

# 3. ORPort 9001 dinleniyor mu?
if ss -tlnp 2>/dev/null | grep -q ':9001 '; then
  echo "CHECK_ORPORT=ok:9001 dinlemede"
elif ss -tlnp 2>/dev/null | grep -q ':9001'; then
  echo "CHECK_ORPORT=ok:9001 dinlemede"
else
  echo "CHECK_ORPORT=warn:9001 henuz dinlenmiyor — servis yeni baslamis olabilir, 1-2 dk bekle"
fi

# 4. Servis enabled mi?
SVC_ENABLED_NAME=""
SVC_ENABLED_STATE=""
MULTI_E=$(systemctl list-units --all --no-legend --plain 'anon@*' 2>/dev/null | awk '{print $1}' | head -3)
NAMED_E=$(systemctl list-units --all --no-legend --plain 'anon[0-9]*.service' 2>/dev/null | awk '{print $1}' | head -3)
for svc in $MULTI_E $NAMED_E anon anon@default anyone anyone-relay; do
  ST=$(systemctl is-enabled "$svc" 2>/dev/null || true)
  if [ -n "$ST" ] && [ "$ST" != "" ]; then
    SVC_ENABLED_NAME="$svc"
    SVC_ENABLED_STATE="$ST"
    break
  fi
done
if [ -z "$SVC_ENABLED_NAME" ]; then
  echo "CHECK_SVC_ENABLED=warn:anon servisi sistemde bulunamadi"
elif echo "$SVC_ENABLED_STATE" | grep -q 'enabled'; then
  echo "CHECK_SVC_ENABLED=ok:$SVC_ENABLED_NAME enabled ($SVC_ENABLED_STATE)"
else
  echo "CHECK_SVC_ENABLED=err:$SVC_ENABLED_NAME — $SVC_ENABLED_STATE (enable icin: systemctl enable $SVC_ENABLED_NAME)"
fi

# 5. Disk kullanimi
DISK_PCT=$(df -P / 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%')
if [ -n "$DISK_PCT" ] && echo "$DISK_PCT" | grep -qE '^[0-9]+$'; then
  if [ "$DISK_PCT" -ge 90 ]; then
    echo "CHECK_DISK=err:\${DISK_PCT}% dolu — temizlik yap"
  elif [ "$DISK_PCT" -ge 75 ]; then
    echo "CHECK_DISK=warn:\${DISK_PCT}% dolu — izle"
  else
    echo "CHECK_DISK=ok:\${DISK_PCT}% dolu"
  fi
else
  echo "CHECK_DISK=warn:disk bilgisi alinamadi"
fi

# 6. anon versiyonu
if command -v anon >/dev/null 2>&1; then
  VER=$(anon --version 2>/dev/null | head -1 | tr -d '\\n' || true)
  echo "CHECK_VERSION=ok:$VER"
elif [ -x /usr/bin/anon ]; then
  VER=$(/usr/bin/anon --version 2>/dev/null | head -1 | tr -d '\\n' || true)
  echo "CHECK_VERSION=ok:$VER"
else
  echo "CHECK_VERSION=warn:anon komutu bulunamadi (PATH sorunu olabilir)"
fi

# 7. Son 10 WARN satiri
echo "CHECK_WARNS_BEGIN"
journalctl -u anon -n 300 --no-pager --output=cat 2>/dev/null | grep '\\[WARN\\]' | tail -10 || true
echo "CHECK_WARNS_END"
`;
    try {
      const out = await runSsh(server, cmd, 18000);
      const checkLabels = {
        CHECK_ANONRC: 'anonrc dosyası',
        CHECK_EXIT_NOTICE: 'Exit Notice HTML',
        CHECK_ORPORT: 'ORPort 9001',
        CHECK_SVC_ENABLED: 'Servis (enabled)',
        CHECK_DISK: 'Disk kullanımı',
        CHECK_VERSION: 'anon versiyonu',
      };
      const checks = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^(CHECK_\w+)=(ok|warn|err):(.*)$/);
        if (m && checkLabels[m[1]]) {
          checks.push({ key: m[1], label: checkLabels[m[1]], status: m[2], detail: m[3].trim() });
        }
      }
      // Son WARN satirlari
      const warnStart = out.indexOf('CHECK_WARNS_BEGIN\n');
      const warnEnd = out.indexOf('\nCHECK_WARNS_END');
      let recentWarns = [];
      if (warnStart >= 0 && warnEnd > warnStart) {
        recentWarns = out.slice(warnStart + 'CHECK_WARNS_BEGIN\n'.length, warnEnd)
          .split('\n').map(l => l.trim()).filter(l => l && l.includes('[WARN]'));
      }
      return { ok: true, checks, recentWarns };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async fetchLogs(name, lines = 200) {
    const server = this.servers.find(s => s.name === name);
    if (!server) return { ok: false, error: 'server not found' };
    const cmd = `journalctl -u anon -n ${Number(lines) || 200} --no-pager 2>/dev/null || tail -n ${Number(lines) || 200} /var/log/anon/notices.log 2>/dev/null || tail -n ${Number(lines) || 200} /var/log/anon/log 2>/dev/null || echo "(no anon logs found — check journalctl -u anon or /var/log/anon/)"`;
    try {
      const out = await runSsh(server, cmd, 10000);
      const lines = out.split('\n');
      // Also update the log cache whenever we successfully fetch logs.
      this._logCache.set(name, { ts: Date.now(), lines, anonState: null, source: 'fetch' });
      return { ok: true, lines };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Returns the last known logs for a server (used by AI auto-fix when SSH is down).
  getLogCache(name) {
    return this._logCache.get(name) || null;
  }

  startLogStream(name) {
    this.stopLogStream(name);
    const server = this.servers.find(s => s.name === name);
    if (!server) return;
    const sshArgs = buildSshArgs(server, [
      "journalctl -u anon -f -n 50 --no-pager 2>/dev/null || tail -n 50 -F /var/log/anon/notices.log 2>/dev/null || tail -n 50 -F /var/log/anon/log"
    ]);
    const usePass = !!server.password;
    const cmd = usePass ? 'sshpass' : 'ssh';
    const cmdArgs = usePass ? ['-e', 'ssh', ...sshArgs] : sshArgs;
    const env = usePass ? { ...process.env, SSHPASS: server.password } : process.env;
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let carry = '';
    child.stdout.on('data', (buf) => {
      const chunk = carry + buf.toString('utf8');
      const parts = chunk.split('\n');
      carry = parts.pop();
      for (const line of parts) {
        if (line) this.emit('log', { name, line });
      }
    });
    child.on('close', () => this.logStreams.delete(name));
    this.logStreams.set(name, child);
  }
  stopLogStream(name) {
    const p = this.logStreams.get(name);
    if (p) { try { p.kill(); } catch {} this.logStreams.delete(name); }
  }
}

module.exports = Monitor;
module.exports.runSsh = runSsh;
