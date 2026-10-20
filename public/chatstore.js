// Where a conversation lives on this device.
//
// Chats used to sit in localStorage: synchronous, about 5 MB for the whole origin,
// and one oversized write throws in a way that can take every transcript with it.
// IndexedDB is asynchronous, gets a budget measured in hundreds of megabytes, and a
// full database refuses the one write that did not fit.
//
// Values are kept as JSON strings, exactly as they were in localStorage, so history
// saved before this module existed reads back untouched and a payload can be
// measured before anything is written.
//
// If IndexedDB is unavailable — private mode, or a browser that blocks it outright —
// every call falls back to localStorage. A chat page that quietly moves your
// history somewhere smaller is a bug; one that loses it is a disaster.
(() => {
  'use strict';

  const DB_NAME = 'devchat.chats';
  const STORE = 'kv';
  // The budget this app holds itself to, which is deliberately lower than whatever
  // the browser is willing to give: it is the number the settings pane shows.
  const QUOTA = 30 * 1024 * 1024;

  let dbPromise = null;
  // Asked once per page: a browser that refuses IndexedDB should not be asked again
  // on every save.
  let unavailable = false;

  function open() {
    if (!window.indexedDB) {
      // Not a failure to retry: a browser with no IndexedDB at all has one answer,
      // and the pane has to be able to say which place the chats are really in.
      unavailable = true;
      return null;
    }
    if (unavailable) return null;
    if (!dbPromise) {
      dbPromise = new Promise((done, fail) => {
        let req;
        try {
          req = indexedDB.open(DB_NAME, 1);
        } catch (err) {
          fail(err);
          return;
        }
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => done(req.result);
        req.onerror = () => fail(req.error || new Error('The conversation store would not open.'));
        req.onblocked = () => fail(new Error('The conversation store is held by another tab.'));
      });
      // A rejected open must not poison every later attempt with the same error.
      dbPromise.catch(() => {
        unavailable = true;
        dbPromise = null;
      });
    }
    return dbPromise;
  }

  function run(mode, work) {
    const p = open();
    if (!p) return Promise.reject(new Error('no indexeddb'));
    return p.then((db) => new Promise((done, fail) => {
      const tx = db.transaction(STORE, mode);
      let result;
      try {
        result = work(tx.objectStore(STORE));
      } catch (err) {
        fail(err);
        return;
      }
      tx.oncomplete = () => done(result && result.result);
      tx.onerror = () => fail(tx.error || new Error('The conversation store call failed.'));
      tx.onabort = () => fail(tx.error || new Error('The conversation store write was refused.'));
    }));
  }

  // ------------------------------------------------------------ localStorage side

  function localRead(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function localWrite(key, text) {
    try {
      localStorage.setItem(key, text);
      return true;
    } catch {
      return false;
    }
  }

  function localDrop(key) {
    try {
      localStorage.removeItem(key);
    } catch { /* nothing to drop */ }
  }

  // ------------------------------------------------------------------- the store

  // Reads one key, moving it out of localStorage on first touch. The old copy is
  // dropped only after the new one has been read back: deleting before there is
  // proof of the copy is how histories get lost.
  async function get(key) {
    if (open()) {
      try {
        const found = await run('readonly', (s) => s.get(key));
        if (typeof found === 'string') return found;
        const legacy = localRead(key);
        if (legacy === null) return null;
        await run('readwrite', (s) => s.put(legacy, key));
        const back = await run('readonly', (s) => s.get(key));
        if (back === legacy) localDrop(key);
        return legacy;
      } catch (err) {
        console.warn('[chatstore] falling back to localStorage', err.message);
      }
    }
    return localRead(key);
  }

  // Overwrites one key. Returns where it went and whether the budget was the
  // reason it could not, so the caller can tell the user instead of guessing.
  async function set(key, text) {
    const bytes = new Blob([text]).size;
    if (bytes > QUOTA) {
      return { ok: false, reason: 'too-big', bytes, quota: QUOTA, where: 'indexeddb' };
    }
    if (open()) {
      try {
        await run('readwrite', (s) => s.put(text, key));
        localDrop(key);
        return { ok: true, bytes, quota: QUOTA, where: 'indexeddb' };
      } catch (err) {
        console.warn('[chatstore] write refused', err.message);
        return { ok: false, reason: 'refused', bytes, quota: QUOTA, where: 'indexeddb', error: err.message };
      }
    }
    const kept = localWrite(key, text);
    return { ok: kept, bytes, quota: QUOTA, where: 'localstorage', reason: kept ? null : 'refused' };
  }

  async function remove(key) {
    if (open()) {
      try {
        await run('readwrite', (s) => s.delete(key));
      } catch (err) {
        console.warn('[chatstore] delete refused', err.message);
      }
    }
    localDrop(key);
  }

  // Everything this module stored, for the byte count in the settings pane. One
  // account key per person, so reading the whole store costs nothing worth
  // optimising and never guesses at a size.
  async function all() {
    if (open()) {
      try {
        return await run('readonly', (s) => s.getAll());
      } catch { /* fall through to localStorage */ }
    }
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith('devchat.chats')) out.push(localStorage.getItem(key));
      }
    } catch { return out; }
    return out.filter((v) => typeof v === 'string');
  }

  async function usage() {
    const texts = await all();
    const bytes = texts.reduce((sum, t) => sum + new Blob([t]).size, 0);
    let browser = null;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const e = await navigator.storage.estimate();
        browser = { usage: e.usage || 0, quota: e.quota || 0 };
      } catch { /* not fatal, it only decorates the pane */ }
    }
    let persisted = false;
    if (navigator.storage && navigator.storage.persisted) {
      try {
        persisted = await navigator.storage.persisted();
      } catch { /* treat as not persisted */ }
    }
    return { bytes, quota: QUOTA, browser, persisted, where: unavailable ? 'localstorage' : 'indexeddb' };
  }

  // Ask the browser not to evict this storage when it needs room. A hint, not a
  // promise — which is why the pane reports what the browser actually granted.
  async function persist() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  window.ChatStore = {
    QUOTA,
    get,
    set,
    remove,
    usage,
    persist,
    get where() {
      return unavailable ? 'localstorage' : 'indexeddb';
    }
  };
})();
