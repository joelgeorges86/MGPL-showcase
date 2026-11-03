import Database, { Database as DatabaseType } from "better-sqlite3";

// AI-043: registry of every long-lived SQLite handle the app process opens, so
// shutdown can close all of them explicitly. db.ts and several route modules
// each open their own handle at module load; closing only one would leave the
// rest open, and SQLite only checkpoints the WAL when the last one closes.

export interface ClosableHandle {
  readonly open: boolean;
  close(): unknown;
  pragma(source: string): unknown;
}

export interface CloseAllResult {
  registered: number;
  closed: number;
  failed: number;
}

// Busy timeout applied to every registered handle once shutdown starts. better-sqlite3
// is synchronous, so a call waiting on another connection's lock blocks the event
// loop, and with it the drain deadline timer, for up to the handle's busy timeout
// (10 s from db.ts, 5 s by default). A short wait makes a contended call fail fast
// instead. It cannot interrupt a call that is already waiting when the signal lands.
export const SHUTDOWN_BUSY_TIMEOUT_MS = 250;

export interface ShortenResult {
  registered: number;
  shortened: number;
  failed: number;
}

const handles = new Set<ClosableHandle>();

export function trackHandle<T extends ClosableHandle>(handle: T): T {
  handles.add(handle);
  return handle;
}

export function openDatabase(
  filename: string,
  options?: ConstructorParameters<typeof Database>[1],
): DatabaseType {
  return trackHandle(new Database(filename, options));
}

export function shortenBusyTimeouts(): ShortenResult {
  const result: ShortenResult = { registered: handles.size, shortened: 0, failed: 0 };
  for (const handle of handles) {
    if (!handle.open) continue;
    try {
      // PRAGMA takes no bound parameters; the value is a numeric module constant.
      handle.pragma(`busy_timeout = ${SHUTDOWN_BUSY_TIMEOUT_MS}`);
      result.shortened++;
    } catch {
      // e.g. the connection is mid-iteration; shutdown carries on and reports it.
      result.failed++;
    }
  }
  return result;
}

export function closeAllDatabases(): CloseAllResult {
  const result: CloseAllResult = { registered: handles.size, closed: 0, failed: 0 };
  for (const handle of handles) {
    if (!handle.open) continue;
    try {
      handle.close();
      result.closed++;
    } catch {
      // Keep closing the rest; the caller reports the failure count.
      result.failed++;
    }
  }
  handles.clear();
  return result;
}
