/**
 * network-map/preload.js
 *
 * Bridge between the network map window and the RelayPulse main process.
 * Nothing but two functions is exposed — the page cannot reach Node, the
 * filesystem, or any other IPC channel.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relayPulseNetwork', {
  /**
   * Read a public Anyone endpoint through the main process (no CORS there).
   * Only paths on api.ec.anyone.tech are allowed; the main process enforces it.
   * @param {string} path e.g. '/relay-map'
   */
  fetchJson: (path) => ipcRenderer.invoke('network-map:fetch', path),

  /**
   * Bring the main RelayPulse window forward and open one of its screens.
   * @param {'rewards'|'settings'|'ai'} target
   */
  focusMain: (target) => ipcRenderer.invoke('network-map:focus-main', target),

  /**
   * Receive the operator's own relay coordinates from the app.
   * @param {(fleet: Array<{label?: string, lat: number, lon: number}>) => void} cb
   */
  /** A one-off status message from the app (e.g. endpoint fallback in use). */
  onNotice: (cb) => {
    ipcRenderer.on('network-map:notice', (_event, message) => cb(message));
  },

  onFleet: (cb) => {
    ipcRenderer.on('network-map:fleet', (_event, fleet) => cb(fleet));
  },
});
