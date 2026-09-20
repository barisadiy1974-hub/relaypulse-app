// A believable but entirely invented fleet.
//
// It exists for two reasons:
//  1. App Review. The reviewer has no relay servers and no SSH access, so
//     without this they open RelayPulse, see an empty list, and can exercise
//     nothing — which is a Guideline 2.1 rejection.
//  2. Store screenshots, so no real relay name, IP or wallet has to be
//     published.
//
// The numbers are derived from the clock rather than randomised, so the fleet
// looks the same on every launch but the values drift enough that the screen
// reads as live. Nothing here touches the network.
//
// The iOS app carries the same fleet (RelayPulse/Store/DemoFleet.swift); the
// names and addresses are kept identical so a reviewer comparing the two sees
// one product. Addresses come from the RFC 5737 documentation ranges, which can
// never belong to a real host.

const BLUEPRINT = [
  { name: 'relay-oslo-01', host: '203.0.113.10', state: 'online' },
  { name: 'relay-oslo-02', host: '203.0.113.11', state: 'online' },
  { name: 'relay-bergen-01', host: '203.0.113.24', state: 'online' },
  { name: 'relay-frankfurt-01', host: '198.51.100.7', state: 'online' },
  { name: 'relay-frankfurt-02', host: '198.51.100.8', state: 'warn' },
  { name: 'relay-amsterdam-01', host: '198.51.100.42', state: 'online' },
  { name: 'relay-paris-01', host: '192.0.2.15', state: 'stale' },
  { name: 'relay-london-01', host: '192.0.2.31', state: 'online' },
  { name: 'relay-madrid-01', host: '192.0.2.77', state: 'offline' },
  { name: 'relay-warsaw-01', host: '203.0.113.90', state: 'online' },
];

const BANNER = 'Demo data — not a real fleet';

// Shaped like the entries in the real config so the renderer draws its cards
// from these without knowing the difference.
function servers() {
  return BLUEPRINT.map(b => ({
    name: b.name,
    host: b.host,
    sshUser: 'root',
    sshPort: 22,
    agentPort: 19191,
    agentScheme: 'https',
    agentToken: 'demo',
    wallet: '',
  }));
}

function round(n, places) {
  const m = Math.pow(10, places);
  return Math.round(n * m) / m;
}

// Same shape as the objects Monitor emits on 'snapshot'.
function snapshots(now = Date.now()) {
  const tick = Math.floor(now / 1000 / 20);

  return BLUEPRINT.map((b, i) => {
    const wave = Math.sin(tick / 9 + i) * 0.5 + 0.5; // 0…1

    if (b.state === 'offline') {
      return {
        name: b.name,
        ok: false,
        state: 'offline',
        ts: now - 1_450_000,
        fails: 4,
        error: 'Connection refused (agent unreachable)',
      };
    }
    if (b.state === 'stale') {
      return {
        name: b.name,
        ok: false,
        state: 'stale',
        ts: now - 190_000,
        fails: 2,
        error: 'Timed out',
      };
    }

    const anonActive = b.state !== 'warn';
    return {
      name: b.name,
      ok: true,
      state: 'online',
      ts: now - (8 + i * 3) * 1000,
      iface: 'eth0',
      rxMbps: round(2.2 + wave * 11, 1),
      txMbps: round(1.8 + wave * 9, 1),
      conn: Math.round(180 + wave * 640) + i * 7,
      mem: { totalMB: 3936, usedMB: Math.round(3936 * (44 + wave * 33) / 100), pct: Math.round(44 + wave * 33) },
      load: [round(0.2 + wave, 2), round(0.3 + wave * 0.8, 2), round(0.4 + wave * 0.5, 2)],
      disk: { usedPct: 31 + i * 3 },
      cpuPct: Math.round(6 + wave * 27),
      cpuCount: i % 3 === 0 ? 4 : 2,
      anon: {
        active: anonActive ? 'active' : 'inactive',
        ports: anonActive ? ['9001', '9030'] : [],
        services: { anon: anonActive ? 'active' : 'inactive' },
      },
      uptime: `${9 + i} days, 4:17`,
      publicIp: b.host,
      responseMs: Math.round(60 + wave * 90),
      demo: true,
    };
  });
}

// What the tray title and the fleet header need, without re-deriving it in main.
function aggregate(snaps) {
  const online = snaps.filter(s => s.ok).length;
  const rx = snaps.reduce((a, s) => a + (s.rxMbps || 0), 0);
  const tx = snaps.reduce((a, s) => a + (s.txMbps || 0), 0);
  return { online, total: snaps.length, totalRxMbps: round(rx, 1), totalTxMbps: round(tx, 1) };
}

module.exports = { BANNER, servers, snapshots, aggregate };
