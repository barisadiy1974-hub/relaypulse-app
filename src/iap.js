// Mac App Store in-app purchase (non-consumable lifetime unlock).
//
// Only loaded in the MAS build. Everywhere else RelayPulse keeps its own
// Ed25519 license key (src/license.js) — the App Store forbids unlocking app
// functionality with an external purchase, and Apple forbids nothing about the
// direct-sale builds, so the two paths stay separate.
//
// Entitlement is cached in config so the app opens instantly offline. The cache
// is only ever written from a StoreKit transaction or a restore, never from the
// UI, and "Restore Purchases" re-asks StoreKit if the cache is wrong.
const { inAppPurchase } = require('electron');

// One product for the whole app record: a non-consumable bought on either
// platform unlocks both, so "buy once, use on Mac and iPhone" holds. The iOS
// app already sells this same id.
const PRODUCT_ID = 'com.baris.relaypulse.pro.lifetime';

let config = null;
let onChange = null;
// A MAS build cannot be debugged locally — it only runs installed from
// TestFlight or the App Store — so the StoreKit path writes what it does to
// the app's debug log. Set by start(); a no-op until then.
let log = () => {};

function setPurchased(value) {
  const cfg = config.load();
  if (!!cfg.masPurchased === !!value) return;
  cfg.masPurchased = !!value;
  config.save(cfg);
  try { onChange && onChange(!!value); } catch {}
}

// Called from the tray menu, which is built before start() runs. Treat "not
// started yet" as not purchased rather than throwing: a crash here would take
// out the tray menu, and the worst case is one menu render showing the free
// tier a moment early.
function isPurchased() {
  if (!config) return false;
  try { return !!config.load().masPurchased; } catch { return false; }
}

// StoreKit delivers transactions asynchronously, including ones that completed
// while the app was closed. Every transaction MUST be finished or StoreKit
// replays it on every launch.
function start(options = {}) {
  config = options.config;
  onChange = options.onChange || null;
  log = options.log || (() => {});

  // Requiring the module already registered the SKPaymentQueue observer, so
  // this line marks the point after which transactions can arrive.
  log(`start: canMakePayments=${inAppPurchase.canMakePayments()} purchased=${isPurchased()}`);

  inAppPurchase.on('transactions-updated', (_event, transactions) => {
    log(`transactions-updated: ${Array.isArray(transactions) ? transactions.length : 'not an array'}`);
    if (!Array.isArray(transactions)) return;
    for (const t of transactions) {
      log(`  transaction state=${t && t.transactionState} product=${t && t.payment && t.payment.productIdentifier} error=${t && t.errorMessage}`);
      const state = t && t.transactionState;
      if (state === 'purchased' || state === 'restored') {
        if (!t.payment || t.payment.productIdentifier === PRODUCT_ID) setPurchased(true);
        inAppPurchase.finishTransactionByDate(t.transactionDate);
      } else if (state === 'failed') {
        inAppPurchase.finishTransactionByDate(t.transactionDate);
      }
      // 'purchasing' and 'deferred' are still in flight — do not finish them.
    }
  });
}

async function getProduct() {
  if (!inAppPurchase.canMakePayments()) {
    return { ok: false, error: 'This Mac is not allowed to make payments.' };
  }
  try {
    const products = await inAppPurchase.getProducts([PRODUCT_ID]);
    const p = Array.isArray(products) && products[0];
    if (!p) return { ok: false, error: 'Product is not available from the App Store yet.' };
    return { ok: true, title: p.localizedTitle, description: p.localizedDescription, price: p.formattedPrice };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
}

// Resolves once StoreKit has accepted the payment request. The actual unlock
// arrives later through 'transactions-updated'.
async function purchase() {
  if (!inAppPurchase.canMakePayments()) {
    return { ok: false, error: 'This Mac is not allowed to make payments.' };
  }
  try {
    const accepted = await inAppPurchase.purchaseProduct(PRODUCT_ID, 1);
    // accepted only means StoreKit queued the payment; the sheet and the
    // transaction come later, or not at all.
    log(`purchaseProduct -> ${accepted}`);
    return accepted ? { ok: true } : { ok: false, error: 'The App Store did not accept the purchase request.' };
  } catch (e) {
    log(`purchaseProduct threw: ${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
}

function restore() {
  try {
    inAppPurchase.restoreCompletedTransactions();
    log('restoreCompletedTransactions called');
    return { ok: true };
  } catch (e) {
    log(`restoreCompletedTransactions threw: ${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
}

module.exports = { PRODUCT_ID, start, isPurchased, getProduct, purchase, restore };
