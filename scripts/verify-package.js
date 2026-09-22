#!/usr/bin/env node
/**
 * Paket sonrasi duman testi.
 *
 * Neden var: main.js acilista `require('./network-map/window')` yapiyordu ama o klasor
 * hicbir zaman depoya girmemisti. Paketleme main.js'i CALISTIRMADIGI icin CI yesil gecti
 * ve v1.8.0 paketleri acilista "Cannot find module" ile duserek yayinlandi. Bu betik
 * uretilen asar'in ICINE bakip her relatif require hedefinin gercekten paketlendigini
 * dogrular; eksik varsa derlemeyi kirar.
 */
const fs = require("fs");
const path = require("path");

const OUT = "dist-public";

function findAsar(dir) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === "app.asar") hits.push(full);
    }
  };
  walk(dir, 0);
  return hits;
}

/**
 * asar icerigini DOGRUDAN okur. Onceki surum `npx @electron/asar list` cagiriyordu;
 * Windows'ta npx bir .cmd oldugu icin execFileSync kabuk olmadan ENOENT veriyordu
 * (build (windows-latest) bu yuzden kirmizi dondu). Bicim basit: 16 bayt pickle
 * basligi, ardindan JSON dizin agaci — ek bagimlilik gerekmiyor.
 */
function asarList(asar) {
  const fd = fs.openSync(asar, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    const tree = JSON.parse(json.toString("utf8").replace(/\0+$/, ""));
    const out = new Set();
    (function walk(node, prefix) {
      for (const [name, value] of Object.entries(node.files || {})) {
        const p = prefix ? prefix + "/" + name : name;
        out.add(p);
        if (value && value.files) walk(value, p);
      }
    })(tree, "");
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Kaynaktaki her .js dosyasindan relatif require hedeflerini topla. */
function relativeRequires() {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === OUT) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) {
        // Yorumlari at: hem bu betigin hem network-map/window.js'in aciklamasinda
        // ornek olarak gecen require satirlari yanlis pozitif uretiyordu.
        const src = fs.readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        for (const m of src.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
          found.push({ from: path.relative(".", full), target: m[2] });
        }
      }
    }
  };
  walk(".");
  return found;
}

const asars = findAsar(OUT);
if (!asars.length) {
  console.error(`verify-package: ${OUT} altinda app.asar bulunamadi`);
  process.exit(1);
}

let failures = 0;
for (const asar of asars) {
  const entries = asarList(asar);
  console.log(`verify-package: ${asar} — ${entries.size} girdi`);

  // 1. Girisler pakette mi
  for (const must of ["package.json", "main.js", "preload.js", "renderer/index.html"]) {
    if (!entries.has(must)) { console.error(`  EKSIK: ${must}`); failures++; }
  }

  // 2. Her relatif require hedefi cozulebiliyor mu
  for (const { from, target } of relativeRequires()) {
    // Yalnizca asar'a GIREN dosyalarin require'lari sayilir. Kaynak agacinda olup
    // pakete bilerek alinmayan dosyalar (tools/** denetim kosumu) yanlis pozitif
    // uretiyordu: tools/audit/check.js -> ./harness.js, ikisi de zaten disarida.
    // Paketin butunlugu, paketlenmemis bir dosyanin bagimliligini ilgilendirmez.
    if (!entries.has(from.split(path.sep).join("/"))) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from.split(path.sep).join("/")), target));
    const candidates = [base, `${base}.js`, `${base}.json`, `${base}/index.js`];
    if (!candidates.some((c) => entries.has(c))) {
      console.error(`  COZULEMEDI: ${from} -> ${target}`);
      failures++;
    }
  }
}

if (failures) {
  console.error(`verify-package: ${failures} sorun — paket eksik dosyayla yayinlanamaz.`);
  process.exit(1);
}
console.log("verify-package: paket butun, her relatif require hedefi iceride.");
