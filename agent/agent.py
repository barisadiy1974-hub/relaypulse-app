#!/usr/bin/env python3
"""RelayPulse - lightweight metrics agent.
Usage: AGENT_TOKEN=xxx AGENT_PORT=19191 python3 agent.py
"""
import http.server, json, os, re, ssl, subprocess, threading, time

TOKEN = os.environ.get('AGENT_TOKEN', '')
PORT  = int(os.environ.get('AGENT_PORT', '19191'))
SCHEME = os.environ.get('AGENT_SCHEME', 'http').strip().lower() or 'http'
CERT = os.environ.get('AGENT_CERT', '/opt/anyone-agent/cert.pem')
KEY = os.environ.get('AGENT_KEY', '/opt/anyone-agent/key.pem')

_data = {}
_lock = threading.Lock()
_pub_ip = ''
_pub_ip_ts = 0

def _sh(cmd, default=''):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.DEVNULL, timeout=5).decode()
    except Exception:
        return default

def _read(path):
    try:
        with open(path) as f: return f.read()
    except Exception:
        return ''

def _pub_ip_get():
    global _pub_ip, _pub_ip_ts
    now = time.time()
    if now - _pub_ip_ts < 300:
        return _pub_ip
    for url in ['https://ifconfig.me', 'https://api.ipify.org', 'https://ipinfo.io/ip']:
        ip = _sh(f'curl -4 -fsS --max-time 4 {url}').strip().split('\n')[0]
        if ip and re.match(r'^\d{1,3}(\.\d{1,3}){3}$', ip):
            _pub_ip, _pub_ip_ts = ip, now
            return ip
    return _pub_ip

def collect():
    iface = _sh("ip route 2>/dev/null | awk '/^default/{print $5; exit}'").strip().split('\n')[0]

    net = None
    for ln in _read('/proc/net/dev').splitlines():
        t = ln.strip()
        i = t.find(':')
        if i < 0: continue
        if t[:i].strip() != iface: continue
        cols = t[i+1:].split()
        if len(cols) >= 9:
            net = {'iface': iface, 'rx': int(cols[0]), 'tx': int(cols[8])}
        break

    conn_raw = _sh("ss -tn state established 2>/dev/null | tail -n +2 | wc -l").strip()
    conn = int(conn_raw) if conn_raw.isdigit() else 0

    mem = {'totalMB': 0, 'usedMB': 0, 'pct': 0}
    mt = ma = 0
    for ln in _read('/proc/meminfo').splitlines():
        if ln.startswith('MemTotal:'): mt = int(ln.split()[1])
        elif ln.startswith('MemAvailable:'): ma = int(ln.split()[1])
    if mt:
        mem = {'totalMB': mt // 1024, 'usedMB': (mt - ma) // 1024, 'pct': round((mt - ma) * 100 / mt)}

    la = _read('/proc/loadavg').strip().split()[:3]
    load = [float(x) for x in la] if len(la) >= 3 else [0, 0, 0]

    disk = None
    dp = _sh("df -P / 2>/dev/null | tail -1").strip().split()
    if len(dp) >= 5:
        disk = {'totalKB': int(dp[1]), 'usedKB': int(dp[2]), 'availKB': int(dp[3]), 'usedPct': int(dp[4].rstrip('%'))}

    cpu = None
    for ln in _read('/proc/stat').splitlines():
        if ln.startswith('cpu '):
            n = [int(x) for x in ln.split()[1:]]
            idle = n[3] + (n[4] if len(n) > 4 else 0)
            cpu = {'idle': idle, 'total': sum(n)}
            break

    cpu_count_raw = _sh("nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null").strip().split('\n')[0]
    cpu_count = int(cpu_count_raw) if cpu_count_raw.isdigit() else None

    services = {}
    for svc in ['anon', 'anon@default', 'anyone', 'anyone-relay', 'tor-anon']:
        s = _sh(f'systemctl is-active {svc} 2>/dev/null').strip()
        if s: services[svc] = s

    ports_raw = _sh("ss -tnlp 2>/dev/null | grep -E ':(9001|9030|9050|9051)' | awk '{print $4}'").strip()
    ports = [p for p in ports_raw.splitlines() if p]

    any_active = any(v in ('active', 'activating') for v in services.values())
    anon_state = 'active' if (any_active or ports) else (next((v for v in services.values() if v and v != 'active'), 'inactive'))

    uptime = _sh('uptime -p 2>/dev/null || uptime').strip().split('\n')[0]

    return {
        'ts': int(time.time() * 1000),
        'iface': iface,
        'net': net,
        'conn': conn,
        'mem': mem,
        'load': load,
        'disk': disk,
        'cpu': cpu,
        'cpuCount': cpu_count,
        'anon': {'active': anon_state, 'ports': ports, 'services': services},
        'uptime': uptime,
        'publicIp': _pub_ip_get(),
    }

def _loop():
    while True:
        try:
            d = collect()
            with _lock:
                _data.clear()
                _data.update(d)
        except Exception:
            pass
        time.sleep(8)

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if TOKEN and self.headers.get('X-Agent-Token', '') != TOKEN:
            self.send_response(403); self.end_headers(); return
        with _lock:
            body = json.dumps(_data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a): pass

if __name__ == '__main__':
    threading.Thread(target=_loop, daemon=True).start()
    try:
        d = collect()
        with _lock: _data.update(d)
    except Exception:
        pass
    httpd = http.server.HTTPServer(('0.0.0.0', PORT), Handler)
    if SCHEME == 'https' and os.path.exists(CERT) and os.path.exists(KEY):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=CERT, keyfile=KEY)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    httpd.serve_forever()
