"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

let event = {};
try {
  event = JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "{}");
} catch {
  process.stdout.write(JSON.stringify({ cancel: true, reason: "Invalid Cline hook event JSON." }));
  process.exit(0);
}

const command = event.command || event.tool_input?.command || "";
const isProtectedOperation = /(?:^|\s)(?:git\s+push|gh\s+pr\s+(?:create|ready))(?:\s|$)/i.test(
  command,
);
if (!isProtectedOperation) {
  process.stdout.write(JSON.stringify({ cancel: false }));
  process.exit(0);
}

const guard = path.join(__dirname, "mgpl-gate-guard.js");
const result = spawnSync(process.execPath, [guard, "verify"], {
  cwd: path.resolve(__dirname, ".."),
  encoding: "utf8",
  windowsHide: true,
});
if (result.status === 0) {
  process.stdout.write(JSON.stringify({ cancel: false }));
} else {
  process.stdout.write(
    JSON.stringify({
      cancel: true,
      reason: (result.stderr || result.stdout || "MGPL gate evidence verification failed.").trim(),
    }),
  );
}
