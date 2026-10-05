/* DS Laundry — offline write queue.
 * A generic, durable outbox: operations survive a page reload (IndexedDB),
 * replay strictly in the order they were created, and auto-drain the moment
 * the browser is back online.
 *
 * This file only owns WHEN and IN WHAT ORDER a queued write gets replayed.
 * WHAT an operation actually means (which table, how to turn it into a real
 * Supabase call) is decided by supabase-config.js, which registers a single
 * handler via DSOffline.registerHandler().
 *
 * Load this BEFORE supabase-config.js. */
(function () {
  const DB_NAME = 'ds_offline_queue';
  const STORE   = 'ops';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains(STORE)) {
          idb.createObjectStore(STORE, { keyPath: 'queueId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return dbPromise;
  }

  async function withStore(mode, fn) {
    const idb = await openDb();
    return new Promise((resolve, reject) => {
      const tx    = idb.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(tx.error);
    });
  }

  function genQueueId() {
    return 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  let handler   = null;    // async (op) => void — set by supabase-config.js
  let draining  = false;
  let listeners = [];

  function notify(status) {
    listeners.forEach(fn => { try { fn(status); } catch (e) { console.error('[DS offline]', e); } });
  }

  async function getAll() {
    try {
      return await withStore('readonly', store => new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.createdAt - b.createdAt));
        req.onerror   = () => reject(req.error);
      }));
    } catch (e) { return []; }
  }

  async function removeOp(queueId) {
    try { await withStore('readwrite', store => store.delete(queueId)); } catch (e) {}
  }

  async function count() {
    return (await getAll()).length;
  }

  async function enqueue(op) {
    const queueId = genQueueId();
    const record  = Object.assign({ queueId, createdAt: Date.now() }, op);
    await withStore('readwrite', store => store.put(record));
    notify({ type: 'queued', pendingCount: await count() });
    // In case this was actually just a one-off network hiccup rather than a
    // real offline stretch, try to drain right away — harmless no-op if
    // we're genuinely offline.
    drain();
    return queueId;
  }

  async function drain() {
    if (draining) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (!handler) return;

    draining = true;
    notify({ type: 'sync-start' });
    let synced = 0;
    try {
      const ops = await getAll();
      for (const op of ops) {
        try {
          await handler(op);
          await removeOp(op.queueId);
          synced++;
        } catch (e) {
          // Stop here so ops stay strictly in order — an order created
          // second must never sync before one created first. If this failed
          // because we just dropped offline again, the next 'online' event
          // (or the periodic nudge below) picks up right where we left off.
          console.warn('[DS] Offline sync paused:', e && e.message ? e.message : e);
          break;
        }
      }
    } finally {
      draining = false;
      notify({ type: 'sync-end', synced: synced, pendingCount: await count() });
    }
  }

  window.addEventListener('online', drain);
  // Some browsers keep reporting navigator.onLine === true on a dead
  // connection (e.g. wifi with no real internet) — a periodic nudge catches
  // that without hammering the network.
  setInterval(drain, 30000);

  window.DSOffline = {
    registerHandler(fn) { handler = fn; drain(); },
    enqueue,
    getAll,
    count,
    onStatusChange(fn) { listeners.push(fn); return () => { listeners = listeners.filter(l => l !== fn); }; },
    drainNow: drain,
  };
})();
