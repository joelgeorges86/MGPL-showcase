import { Router, Request, Response, NextFunction } from "express";

/**
 * AI-082 (#161): scanning "this computer" reads the hardware of the machine
 * the server runs on. On a developer's machine that is the user's own PC; on a
 * hosted site it is the server, and the result was written to the one shared
 * "local-host" device row that every visitor sees.
 *
 * The scan routes therefore run only where the server is the user's own
 * machine: local development (NODE_ENV unset, empty or "development") and the
 * test suite (NODE_ENV "test"). Every other value, including "production" and
 * "staging", turns them off. The Docker image sets NODE_ENV=production, and
 * each hosted compose file sets "production" or "staging".
 *
 * On a hosted site the client asks GET /api/host-scan/status and, when the
 * scan is off, opens the Device Fleet form so the user enters their own
 * device instead. A scan run by a helper on the user's own PC is deferred.
 */

/** The routes that read the server's hardware and write the "local-host" row. */
export const HOST_SCAN_PATHS = ["/api/devices/scan", "/api/devices/scan-local", "/api/scan"];

export const HOST_SCAN_DISABLED_ERROR =
  "Scanning this computer's hardware is not available on this site. Add your device in Device Fleet instead.";

export function hostScanEnabled(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === undefined || nodeEnv === "" || nodeEnv === "development" || nodeEnv === "test";
}

export function requireHostScan(_req: Request, res: Response, next: NextFunction): void {
  if (hostScanEnabled()) {
    next();
    return;
  }
  res.status(404).json({
    success: false,
    code: "HOST_SCAN_DISABLED",
    error: HOST_SCAN_DISABLED_ERROR,
  });
}

/**
 * The path as the routers below would match it. Express matches without regard
 * to case, accepts a trailing slash, and its "/api/devices" and "/api" mounts
 * also accept a doubled slash after the mount ("/api/devices//scan" reaches
 * the devices router's "/scan"). Collapsing repeated slashes, dropping a
 * trailing slash and lower-casing makes every such spelling compare equal to
 * one of HOST_SCAN_PATHS. Percent-escapes are decoded too, so the comparison
 * can only block more, never less.
 */
export function normalizeScanPath(rawPath: string): string {
  let p = rawPath;
  try {
    p = decodeURIComponent(p);
  } catch {
    // Keep the raw path if it is not valid percent-encoding.
  }
  p = p.replace(/\/{2,}/g, "/").toLowerCase();
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

const SCAN_PATH_SET = new Set(HOST_SCAN_PATHS);

export function isHostScanRequest(method: string, rawPath: string): boolean {
  return method.toUpperCase() === "POST" && SCAN_PATH_SET.has(normalizeScanPath(rawPath));
}

/**
 * Mounted in src/index.ts before the devices and Hardware Explorer routers,
 * so the check runs before any hardware read or database write. It compares
 * the normalized path itself instead of relying on route matching, because
 * the scan handlers are reached through mounted routers whose matching is
 * looser than a full-path route.
 */
const router = Router();

router.get("/api/host-scan/status", (_req: Request, res: Response) => {
  res.json({ success: true, enabled: hostScanEnabled() });
});

router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isHostScanRequest(req.method, req.path)) {
    next();
    return;
  }
  requireHostScan(req, res, next);
});

export default router;
