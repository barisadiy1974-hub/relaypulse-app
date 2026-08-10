'use strict';
// Webview preload — runs in isolated world, exposes window.ethereum to main world via contextBridge

const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

const ETH_RPC = 'https://1rpc.io/eth';
// main.js copies this file into app.getPath('userData') before setting it as the
// webview preload, so __dirname IS the userData dir here — no OS-specific path guessing needed.
const userDataPath = __dirname;

let WALLET = '';
try {
  WALLET = JSON.parse(fs.readFileSync(path.join(userDataPath, 'webview-wallet.json'), 'utf8')).wallet || '';
} catch(e) {}

async function rpcCall(method, params = []) {
  const r = await fetch(ETH_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) { const err = new Error(j.error.message); err.code = j.error.code; throw err; }
  return j.result;
}

// Simple event emitter (lives in isolated world, bridged via contextBridge)
const _cbs = {};
function on(ev, cb)  { (_cbs[ev] = _cbs[ev] || []).push(cb); }
function off(ev, cb) { if (_cbs[ev]) _cbs[ev] = _cbs[ev].filter(l => l !== cb); }
function emit(ev, ...args) { (_cbs[ev] || []).forEach(cb => { try { cb(...args); } catch(e) {} }); }

// Fire connect + accountsChanged after page scripts have run
setTimeout(() => {
  emit('connect', { chainId: '0x1' });
  if (WALLET) emit('accountsChanged', [WALLET]);
}, 300);

contextBridge.exposeInMainWorld('ethereum', {
  isMetaMask: true,
  selectedAddress: WALLET || null,
  chainId: '0x1',
  networkVersion: '1',

  request({ method, params = [] }) {
    switch (method) {
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return Promise.resolve(WALLET ? [WALLET] : []);
      case 'eth_chainId':
        return Promise.resolve('0x1');
      case 'net_version':
        return Promise.resolve('1');
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return Promise.resolve(null);
      case 'eth_sendTransaction':
      case 'personal_sign':
      case 'eth_sign':
      case 'eth_signTypedData_v4':
        return Promise.reject(Object.assign(new Error('Use Chrome + MetaMask for signing.'), { code: 4001 }));
      default:
        return rpcCall(method, params);
    }
  },

  on(ev, cb)  { on(ev, cb);  },
  once(ev, cb) {
    const w = (...a) => { cb(...a); off(ev, w); };
    on(ev, w);
  },
  removeListener(ev, cb) { off(ev, cb); },
  removeAllListeners(ev) { if (ev) delete _cbs[ev]; else Object.keys(_cbs).forEach(k => delete _cbs[k]); },
});
