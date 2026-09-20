// Sandboxed SSH transport for the Mac App Store build.  It never invokes the
// system ssh client and does not read ~/.ssh or known_hosts.
const { Client } = require('ssh2');
const crypto = require('crypto');

const pool = new Map();
let privateKey = '';
let hostKeys = {};
let persistHostKey = null;

function configure(options = {}) {
  privateKey = String(options.privateKey || '');
  hostKeys = { ...(options.hostKeys || {}) };
  persistHostKey = typeof options.persistHostKey === 'function' ? options.persistHostKey : null;
}

function connectionKey(server) {
  return [server.user || 'root', server.host || server.sshAlias || server.name || '', Number(server.port || 22)].join('|');
}

function describe(server) {
  return `${server.host || server.sshAlias || server.name || 'target'}:${Number(server.port || 22)}`;
}

function normalizeError(error, server, timeoutMs) {
  const raw = String(error && error.message || error || '').trim();
  const target = describe(server);
  if (/timed out|timeout|ETIMEDOUT/i.test(raw)) return `SSH timed out: ${target} (${timeoutMs}ms).`;
  if (/ECONNREFUSED|Connection refused/i.test(raw)) return `SSH refused: ${target}. sshd is down on the server or a firewall is blocking the port.`;
  if (/ENETUNREACH|EHOSTUNREACH|No route to host/i.test(raw)) return `No network route: ${target}. Check the server, routing, or firewall.`;
  if (/All configured authentication methods failed|Authentication failed|Permission denied/i.test(raw)) return `Authentication failed: ${target}. Check the key, password, and username.`;
  if (/host key/i.test(raw)) return `Host key mismatch: ${target}. The server's SSH identity may have changed.`;
  return raw || `Could not establish an SSH connection: ${target}.`;
}

function buildConfig(server, auth = {}) {
  const key = connectionKey(server);
  return {
    host: server.host || server.sshAlias || server.name,
    port: Number(server.port || 22),
    username: server.user || 'root',
    readyTimeout: Math.max(3000, Number(auth.timeoutMs || 10000)),
    keepaliveInterval: 10000,
    keepaliveCountMax: 6,
    hostHash: 'sha256',
    hostVerifier: (fingerprint) => {
      const known = hostKeys[key];
      if (known) return known === fingerprint;
      hostKeys[key] = fingerprint;
      try { persistHostKey && persistHostKey(key, fingerprint); } catch {}
      return true; // TOFU: persist this first-seen public key before use.
    },
    ...auth,
  };
}

function connectOnce(server, auth, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) { try { client.end(); } catch {} reject(err); }
      else resolve(client);
    };
    const timer = setTimeout(() => finish(new Error('SSH timeout')), Math.max(3000, timeoutMs));
    client.once('ready', () => { clearTimeout(timer); finish(); });
    client.once('error', (err) => { clearTimeout(timer); finish(err); });
    client.connect(buildConfig(server, { ...auth, timeoutMs }));
  });
}

async function getClient(server, timeoutMs = 10000) {
  const key = connectionKey(server);
  const cached = pool.get(key);
  if (cached && cached.client) return cached.client;
  if (cached && cached.pending) return cached.pending;

  const attempt = (async () => {
    let client;
    let lastError;
    if (privateKey) {
      try { client = await connectOnce(server, { privateKey }, timeoutMs); }
      catch (err) { lastError = err; }
    }
    if (!client && server.password) {
      try { client = await connectOnce(server, { password: String(server.password) }, timeoutMs); }
      catch (err) { lastError = err; }
    }
    if (!client) throw new Error(normalizeError(lastError || 'No key or password available.', server, timeoutMs));
    const item = { client, pending: null };
    pool.set(key, item);
    client.on('close', () => { if (pool.get(key) === item) pool.delete(key); });
    client.on('error', () => {});
    return client;
  })();
  pool.set(key, { client: null, pending: attempt });
  try { return await attempt; }
  catch (err) { pool.delete(key); throw err; }
}

async function runSsh(server, remoteCmd, timeoutMs = 10000) {
  const client = await getClient(server, timeoutMs);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(normalizeError('SSH timeout', server, timeoutMs))), Math.max(3000, timeoutMs));
    client.exec(String(remoteCmd), (err, stream) => {
      if (err) { clearTimeout(timer); reject(new Error(normalizeError(err, server, timeoutMs))); return; }
      let stdout = '';
      let stderr = '';
      stream.on('data', (data) => { stdout += data.toString('utf8'); });
      stream.stderr.on('data', (data) => { stderr += data.toString('utf8'); });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 || code == null) resolve(stdout);
        else reject(new Error(normalizeError(stderr || `Remote command exited rc=${code}`, server, timeoutMs)));
      });
    });
  });
}

function startLogStream(server, onLine) {
  let closed = false;
  let stream = null;
  let carry = '';
  getClient(server, 15000).then((client) => {
    if (closed) return;
    client.exec('journalctl -u anon -f -n 50 --no-pager 2>/dev/null || tail -n 50 -F /var/log/anon/notices.log 2>/dev/null || tail -n 50 -F /var/log/anon/log', (err, next) => {
      if (err || closed) return;
      stream = next;
      stream.on('data', (data) => {
        const parts = (carry + data.toString('utf8')).split('\n');
        carry = parts.pop();
        parts.filter(Boolean).forEach(onLine);
      });
    });
  }).catch((err) => { if (!closed) onLine(`[SSH] ${normalizeError(err, server, 15000)}`); });
  return { close() { closed = true; try { stream && stream.close(); } catch {} } };
}

async function openShell(server, options = {}) {
  const client = await getClient(server, 15000);
  const stream = await new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: Number(options.cols || 100), rows: Number(options.rows || 28) }, (err, next) => err ? reject(err) : resolve(next));
  });
  return {
    write(data) { if (stream && stream.writable) stream.write(String(data)); },
    resize(cols, rows) { try { stream.setWindow(Number(rows || 28), Number(cols || 100), 0, 0); } catch {} },
    onData(callback) { stream.on('data', (data) => callback(data.toString('utf8'))); stream.stderr.on('data', (data) => callback(data.toString('utf8'))); },
    close() { try { stream.close(); } catch {} },
  };
}

function closeServer(server) {
  const key = connectionKey(server);
  const item = pool.get(key);
  pool.delete(key);
  try { item && item.client && item.client.end(); } catch {}
}

module.exports = { configure, runSsh, startLogStream, openShell, closeServer, normalizeError };
