/* MGPL IndexedDB Client Persistence Layer (FEAT-0151)
 *
 * Provides window.OfflineStorage — a promise-based wrapper around IndexedDB
 * used to persist API responses so dashboard views can render offline.
 *
 * Database: mgpl_offline_db (version 1)
 * Object stores:
 *   - store_games  (library, playability, home widgets)
 *   - store_fleet  (device fleet)
 *   - store_deals  (deals hub)
 *   - store_hltb   (backlog / HLTB insights)
 *   - store_analytics (analytics visualizer cache)
 *   - play_sessions_queue (offline play-session records awaiting sync)
 *   - backlog_cache (offline backlog summary snapshot)
 *   - state_snapshots (latest exported state snapshot fallback point, FEAT-0164)
 *   - retro_save_states (client-side retro save-state slots, FEAT-0165)
 *   - store_prefs (client preference persistence, e.g. active theme, FEAT-0167)
 */
(function () {
  "use strict";

  const DB_NAME = "mgpl_offline_db";
  const DB_VERSION = 4;
  const STORES = [
    "store_games",
    "store_fleet",
    "store_deals",
    "store_hltb",
    "store_analytics",
    "play_sessions_queue",
    "backlog_cache",
    "state_snapshots",
    "retro_save_states",
    "store_prefs",
  ];

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB is not supported in this browser."));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        STORES.forEach((name) => {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: "key" });
          }
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  function getStore(storeName, mode) {
    return open().then((db) => {
      if (!db.objectStoreNames.contains(storeName)) {
        throw new Error(`Unknown object store: ${storeName}`);
      }
      const tx = db.transaction(storeName, mode);
      return tx.objectStore(storeName);
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const OfflineStorage = {
    /** Persist a record under a deterministic key. */
    save(storeName, key, data) {
      return getStore(storeName, "readwrite").then((store) =>
        requestToPromise(store.put({ key, data, savedAt: Date.now() })),
      );
    },

    /** Retrieve a single record by key (resolves to the stored data or null). */
    get(storeName, key) {
      return getStore(storeName, "readonly").then((store) =>
        requestToPromise(store.get(key)).then((record) => (record ? record.data : null)),
      );
    },

    /** Retrieve all records in a store (array of { key, data, savedAt }). */
    getAll(storeName) {
      return getStore(storeName, "readonly").then((store) => requestToPromise(store.getAll()));
    },

    /** Remove a single record by key. */
    remove(storeName, key) {
      return getStore(storeName, "readwrite").then((store) => requestToPromise(store.delete(key)));
    },

    /** Clear an entire store. */
    clear(storeName) {
      return getStore(storeName, "readwrite").then((store) => requestToPromise(store.clear()));
    },

    /** Feature detection helper. */
    isSupported() {
      return "indexedDB" in window;
    },

    /**
     * Enqueue a play session for later sync. Each record is keyed by its
     * client-generated sessionUuid so retries are idempotent on the server.
     */
    enqueueSession(session) {
      return getStore("play_sessions_queue", "readwrite").then((store) =>
        requestToPromise(
          store.put({ key: session.sessionUuid, data: session, savedAt: Date.now() }),
        ),
      );
    },

    /** Retrieve all queued (unsynced) play sessions. */
    getQueuedSessions() {
      return getStore("play_sessions_queue", "readonly").then((store) =>
        requestToPromise(store.getAll()).then((records) => (records || []).map((r) => r.data)),
      );
    },

    /** Remove a single queued session by its sessionUuid. */
    removeSession(sessionUuid) {
      return getStore("play_sessions_queue", "readwrite").then((store) =>
        requestToPromise(store.delete(sessionUuid)),
      );
    },

    /**
     * Attempt to push all queued sessions to the server. On success each record
     * is removed from the queue. Resolves to the number of sessions synced.
     */
    syncPlaySessions() {
      return this.getQueuedSessions().then((sessions) => {
        if (!sessions.length) return 0;
        const push = (session) =>
          fetch("/api/backlog/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(session),
          })
            .then((res) => {
              if (!res.ok) throw new Error("sync failed");
              return res.json();
            })
            .then((body) => {
              if (body && body.success) {
                return this.removeSession(session.sessionUuid);
              }
              throw new Error("server rejected session");
            });
        return sessions
          .reduce((chain, session) => chain.then(() => push(session)), Promise.resolve())
          .then(() => sessions.length);
      });
    },

    /** Cache the latest exported state snapshot as a local fallback point (FEAT-0164). */
    saveSnapshot(snapshot) {
      return this.save("state_snapshots", "latest", snapshot);
    },

    /** Retrieve the latest cached state snapshot (resolves to the snapshot or null). */
    getSnapshot() {
      return this.get("state_snapshots", "latest");
    },

    /**
     * Persist a retro save-state into a named slot (FEAT-0165). The record is
     * keyed deterministically as `${gameKey}::slot-${slot}` so multiple games
     * and slots coexist without collisions. stateData is stored as-is (an
     * ArrayBuffer or serializable object) — never transmitted to the server.
     */
    saveRetroState(gameKey, slot, stateData) {
      const key = `${gameKey}::slot-${slot}`;
      return getStore("retro_save_states", "readwrite").then((store) =>
        requestToPromise(
          store.put({ key, data: { gameKey, slot, stateData, savedAt: Date.now() } }),
        ),
      );
    },

    /**
     * Load a retro save-state from a named slot (FEAT-0165). Resolves to the
     * stored record ({ gameKey, slot, stateData, savedAt }) or null when the
     * slot has never been written.
     */
    loadRetroState(gameKey, slot) {
      const key = `${gameKey}::slot-${slot}`;
      return getStore("retro_save_states", "readonly").then((store) =>
        requestToPromise(store.get(key)).then((record) => (record ? record.data : null)),
      );
    },
  };

  window.OfflineStorage = OfflineStorage;
})();
