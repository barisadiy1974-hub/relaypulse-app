// Tek çalıştırılabilir kontrol: filo geneli hata bastırma mantığı.
// node tools/test-network-suspect.js
const assert = require('assert');
const Monitor = require('../src/monitor.js');

const fn = Monitor.prototype._noteFailureAndSuspectNetwork;
function stub(n, internetOk = false) {
  return {
    servers: Array.from({ length: n }, (_, i) => ({ name: `r${i}` })), pollMs: 10000, _logDebug() {},
    _failureCluster: Monitor.prototype._failureCluster, _subnetOf: Monitor.prototype._subnetOf,
    _internetOk: () => internetOk,
  };
}

// Sağlayıcı kesintisi (2026-09-26): filonun üçte biri düştü ama internet
// çalışıyor — bu bizim ağımız değil, alarm bastırılmamalı.
const p = stub(150, true);
for (let i = 0; i < 50; i++) assert.strictEqual(fn.call(p, `r${i}`), false, "internet varken bastirma olmamali");

// Tek tük hata: bastırma yok, relay gerçekten düşmüş olabilir.
let s = stub(140);
for (let i = 0; i < 13; i++) assert.strictEqual(fn.call(s, `r${i}`), false, 'esik altinda bastirma olmamali');

// %10'a ulaşınca: bizim ağ sorunumuz sayılır ve pencere boyunca sürer.
assert.strictEqual(fn.call(s, 'r13'), true, '14/140 esikte bastirilmali');
assert.strictEqual(fn.call(s, 'r99'), true, 'pencere boyunca bastirma surmeli');

// Aynı relay'in tekrar tekrar düşmesi filo geneli sayılmaz.
s = stub(140);
for (let i = 0; i < 30; i++) assert.strictEqual(fn.call(s, 'ayni-relay'), false, 'tek relay bastirmayi tetiklememeli');

// Küçük filoda mutlak eşik (5) geçerli.
s = stub(20);
for (let i = 0; i < 4; i++) assert.strictEqual(fn.call(s, `r${i}`), false);
assert.strictEqual(fn.call(s, 'r4'), true, 'kucuk filoda 5 hata esik');

// Küçük filo: HEPSİ birden düşerse bu bizim ağımızdır (müşterinin 3 sunucusu
// vardır ve WiFi'si koptuğunda üçü de aynı anda cevapsız kalır).
s = stub(3);
assert.strictEqual(fn.call(s, 'r0'), false, 'ilk hata bastirilmamali');
assert.strictEqual(fn.call(s, 'r1'), false, 'ikinci hata bastirilmamali');
assert.strictEqual(fn.call(s, 'r2'), true, 'ucunun ucu de dustuyse bizim agimiz');

// Ama kucuk filoda TEK sunucu duserse alarm gitmeli — gercek ariza olabilir.
s = stub(3);
for (let i = 0; i < 20; i++) assert.strictEqual(fn.call(s, 'tek-relay'), false, 'tek relay bastirmayi tetiklememeli');

// Tek sunuculu musteride bu kural calisamaz (karsilastiracak ikinci sunucu yok);
// orada cihazin kendi ag durumu devreye girer.
s = stub(1);
for (let i = 0; i < 5; i++) assert.strictEqual(fn.call(s, 'r0'), false, 'tek sunucuda bastirma yok');

console.log('network-suspect testleri gecti');
