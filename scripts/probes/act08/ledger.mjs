// The spend ledger's offline helper (AGENTS.md §3.1, #157). It makes no
// network call and never edits an earlier line: every command that writes
// appends exactly one line to spend-ledger.jsonl.
//
//   node scripts/probes/act08/ledger.mjs status
//   node scripts/probes/act08/ledger.mjs close-interrupted --run <run_id> --by <name>
//   node scripts/probes/act08/ledger.mjs reconcile --run <run_id> --billed-usd <n> --credit-record <file> --by <name>
//   node scripts/probes/act08/ledger.mjs explain --run <run_id> --note <text> --by <name>
//   node scripts/probes/act08/ledger.mjs card-charge --note <text> --by <name>
//
// The records folder is C:\dev\_staging\gcp\, or MGPL_GCP_DIR when set.
// Who may run which command is §3.1's rule, not this script's: status is for
// anyone; the others are for the Principal Operator, or the Prompt Author at
// the operator's direction (reconcile is the Prompt Author's).

import {
  existsSync,
  readFileSync,
  unlinkSync,
  closeSync,
  fsyncSync,
  openSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  AGENTS_PATH,
  CREDIT_MAX_AGE_MS,
  GuardRefusal,
  LEDGER_FILE,
  LOCK_FILE,
  UsageError,
  differenceFlagged,
  gcpDir,
  isMain,
  parseAuthorizations,
  readCreditRecords,
  readLedger,
  runCli,
  summarizeLedger,
} from "./lib.mjs";

const COMMANDS = {
  status: {},
  "close-interrupted": { run: true, by: true },
  reconcile: { run: true, "billed-usd": true, "credit-record": true, by: true },
  explain: { run: true, note: true, by: true },
  "card-charge": { note: true, by: true },
};

export function parseLedgerArgs(argv) {
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`command must be one of: ${Object.keys(COMMANDS).join(", ")}`);
  const out = { command };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new UsageError(`Unexpected argument: ${a}`);
    const name = a.slice(2);
    if (!(name in spec)) throw new UsageError(`${command} takes no --${name}`);
    const v = rest[++i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    out[name] = v;
  }
  for (const k of Object.keys(spec)) {
    if (out[k] === undefined) throw new UsageError(`${command} needs --${k}`);
    if (out[k].trim() === "") throw new UsageError(`--${k} must not be blank`);
  }
  if (out["billed-usd"] !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(out["billed-usd"]))
      throw new UsageError(`--billed-usd must be a non-negative number`);
    out["billed-usd"] = Number(out["billed-usd"]);
  }
  return out;
}

function append(dir, obj) {
  const fd = openSync(path.join(dir, LEDGER_FILE), "a");
  try {
    writeSync(fd, `${JSON.stringify(obj)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export { differenceFlagged };

export function ledgerStatus({ dir, agentsPath = AGENTS_PATH, now = Date.now } = {}) {
  const d = gcpDir(dir);
  const t = now();
  const auth = parseAuthorizations(readFileSync(agentsPath, "utf8"));
  const sum = summarizeLedger(readLedger(d));
  const runs = [...sum.runs.values()];
  let credit;
  try {
    const recs = readCreditRecords(d);
    const newest = recs[recs.length - 1];
    credit = {
      record: newest.name,
      balance_usd: newest.balance_usd,
      age_hours: Math.round(((t - newest.read_at_ms) / 3_600_000) * 10) / 10,
      fresh: t - newest.read_at_ms <= CREDIT_MAX_AGE_MS,
    };
  } catch (e) {
    credit = { error: e.message };
  }
  const windowLiab = runs.reduce((n, r) => n + r.liability_usd, 0);
  return {
    records_folder: d,
    lock: existsSync(path.join(d, LOCK_FILE)) ? "present" : "absent",
    window: {
      ends: new Date(auth.window.end_ms).toISOString(),
      total_usd: auth.window.total_usd,
      stop_line_usd: auth.window.stop_line_usd,
      liabilities_usd: Math.round(windowLiab * 1e9) / 1e9,
    },
    entries: auth.entries.map((e) => {
      const mine = runs.filter((r) => r.entry === e.id);
      const liab = mine.reduce((n, r) => n + r.liability_usd, 0);
      return {
        entry: e.id,
        script: e.script,
        expires: new Date(e.expires_ms).toISOString(),
        attempts: sum.attemptsByEntry.get(e.id) ?? 0,
        request_cap: e.request_cap,
        liabilities_usd: Math.round(liab * 1e9) / 1e9,
        dollar_cap_usd: e.dollar_cap_usd,
        headroom_usd:
          Math.round(Math.min(e.dollar_cap_usd - liab, auth.window.total_usd - windowLiab) * 1e9) /
          1e9,
      };
    }),
    open_runs: sum.openRuns.map((r) => r.run_id),
    runs: runs.map((r) => ({
      run_id: r.run_id,
      entry: r.entry,
      reserved_usd: r.max_usd,
      attempts: r.attempts.length,
      computed_usd: r.computed_usd,
      ended: r.ended?.status ?? null,
      reconciled_billed_usd: r.billed_usd,
      liability_usd: r.liability_usd,
    })),
    unexplained_differences: sum.unexplained.map((f) => f.run_id),
    card_charges: sum.cardCharges.length,
    credit,
  };
}

export async function main(argv, { dir, now = Date.now, log = console.log } = {}) {
  const args = parseLedgerArgs(argv);
  const d = gcpDir(dir);
  const at = new Date(now()).toISOString();
  if (args.command === "status") {
    log(JSON.stringify(ledgerStatus({ dir: d, now }), null, 2));
    return 0;
  }
  if (args.command === "card-charge") {
    append(d, { type: "card_charge", note: args.note, by: args.by, at });
    log("Appended a card_charge line. Every authorized run is now stopped.");
    return 0;
  }
  const sum = summarizeLedger(readLedger(d));
  const run = sum.runs.get(args.run);
  const lockFile = path.join(d, LOCK_FILE);
  if (args.command === "close-interrupted") {
    let held = null;
    try {
      held = JSON.parse(readFileSync(lockFile, "utf8"));
    } catch {
      held = null;
    }
    if (!run) {
      if (held?.run_id === args.run) {
        unlinkSync(lockFile);
        log(`Run ${args.run} has no reservation line; removed its lock. Nothing appended.`);
        return 0;
      }
      throw new GuardRefusal("ledger", `no reservation for run ${args.run}`);
    }
    if (run.ended) throw new GuardRefusal("ledger", `run ${args.run} already has an end line`);
    append(d, {
      type: "end",
      run_id: run.run_id,
      entry: run.entry,
      status: "interrupted",
      by: args.by,
      at,
    });
    if (held?.run_id === args.run) unlinkSync(lockFile);
    log(
      `Appended an end line (interrupted) for ${args.run}. Its liability stays $${run.liability_usd} until reconciliation.` +
        (held && held.run_id !== args.run
          ? ` The lock names another run (${held.run_id}); left in place.`
          : ""),
    );
    return 0;
  }
  if (!run) throw new GuardRefusal("ledger", `no reservation for run ${args.run}`);
  if (args.command === "reconcile") {
    if (!run.ended) throw new GuardRefusal("ledger", `run ${args.run} has not ended`);
    const recs = readCreditRecords(d);
    if (!recs.some((r) => r.name === args["credit-record"]))
      throw new GuardRefusal(
        "ledger",
        `${args["credit-record"]} is not a credit-position record in ${d}`,
      );
    const billed = args["billed-usd"];
    const flagged = differenceFlagged(billed, run.computed_usd);
    append(d, {
      type: "reconciliation",
      run_id: run.run_id,
      entry: run.entry,
      billed_usd: billed,
      computed_usd: run.computed_usd,
      difference_usd: Math.round((billed - run.computed_usd) * 1e9) / 1e9,
      flagged, // for the reader; the guard derives the flag from the amounts itself
      credit_record: args["credit-record"],
      by: args.by,
      at,
    });
    log(
      `Appended a reconciliation line for ${args.run}: billed $${billed}, computed $${run.computed_usd}` +
        (flagged
          ? ". FLAGGED: the difference exceeds max(10%, $1); every run is blocked until it is explained."
          : "."),
    );
    return 0;
  }
  // explain
  if (!run.reconciliations.length)
    throw new GuardRefusal("ledger", `run ${args.run} has no reconciliation to explain`);
  append(d, { type: "explained", run_id: run.run_id, note: args.note, by: args.by, at });
  log(`Appended an explained line for ${args.run}.`);
  return 0;
}

if (isMain(import.meta.url)) runCli(main);
