import path from "path";

const PROTECTED_DATABASE_NAMES = new Set(["mgpl-staging.db", "mpgl_app.db", "test_mgpl.db"]);

export function assertIsolatedRestoreTarget(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const basename = path.basename(resolved).toLowerCase();
  if (PROTECTED_DATABASE_NAMES.has(basename))
    throw new Error(`Refusing protected database target: ${basename}`);
  if (!resolved.toLowerCase().includes(`${path.sep}recovery-drills${path.sep}`)) {
    throw new Error("Restore target must be inside a recovery-drills directory.");
  }
  if (path.extname(resolved).toLowerCase() !== ".db")
    throw new Error("Restore target must use the .db extension.");
  return resolved;
}
