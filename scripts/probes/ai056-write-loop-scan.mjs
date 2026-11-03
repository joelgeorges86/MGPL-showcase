// AI-056 scan: every loop in src/ that performs SQLite writes, directly or through a
// helper, and whether an error thrown by those writes is caught inside the loop.
//
//   node scripts/probes/ai056-write-loop-scan.mjs [--all]
//
// A mechanical search, not a reading: it parses every non-test .ts file under src/
// with the TypeScript compiler and applies the rules below, so the list can be
// re-run and diffed. Without --all it prints only loops that write; --all also
// prints the counts it saw.
//
// Rules
//   write call    x.run(...), db.exec(...) / <handle>.exec(...) (receiver text matches
//                 /db|database|conn|sqlite|handle/i, excluding RegExp.exec), and a
//                 call to x.transaction(...)(...) or x.transaction(...).immediate(...).
//   writer        a named function (declaration, const arrow/function, method, or
//                 object-literal property) whose body contains a write call or a
//                 call to another writer, resolved by bare name across all files to a
//                 fixpoint. Name collisions over-report; that is deliberate.
//   loop          for / for-of / for-in / while / do, and the callback of
//                 forEach / map / flatMap / reduce / filter / some / every / find.
//   checkpoint    the loop body awaits shutdownCheckpoint() (AI-056's cancellation).
//   caught        the write (or writer call) sits inside a try block whose catch
//                 clause is itself inside the loop body, so the error does not end
//                 the loop. A writer that catches internally is reported as
//                 "helper catches" - also catch-and-continue from the loop's view.
//
// Output: one line per loop, tab-separated, sorted by file and line.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

// Scans the tree the script sits in, or the one given with --root <dir>.
const rootArg = process.argv.indexOf("--root");
const ROOT =
  rootArg > 0
    ? path.resolve(process.argv[rootArg + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(ROOT, "src");
const showAll = process.argv.includes("--all");

function listTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...listTs(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !/\.(test|spec)\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const files = listTs(SRC).sort();
const sources = files.map((f) => ({
  file: path.relative(ROOT, f).split(path.sep).join("/"),
  sf: ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true),
}));

const LOOP_METHODS = new Set(["forEach", "map", "flatMap", "reduce", "filter", "some", "every", "find"]);
const EXEC_RECEIVER = /db|database|conn|sqlite|handle/i;

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

// Names bound to a transaction function: const tx = db.transaction(fn). Calling tx(...)
// or tx.immediate(...) runs writes, whatever fn contains.
const transactionVars = new Set();
function isTransactionCall(n) {
  return !!n && ts.isCallExpression(n) && calleeName(n) === "transaction";
}

function isDirectWrite(node, sf) {
  if (!ts.isCallExpression(node)) return false;
  const e = node.expression;
  if (ts.isIdentifier(e) && transactionVars.has(e.text)) return true;
  if (!ts.isPropertyAccessExpression(e)) {
    // db.transaction(fn)(args)
    return isTransactionCall(e);
  }
  const name = e.name.text;
  if (name === "run") return true;
  if (name === "exec") {
    if (ts.isRegularExpressionLiteral(e.expression)) return false;
    return EXEC_RECEIVER.test(e.expression.getText(sf));
  }
  // db.transaction(fn).immediate(args) / .deferred / .exclusive
  if (["immediate", "deferred", "exclusive"].includes(name)) {
    return (
      isTransactionCall(e.expression) ||
      (ts.isIdentifier(e.expression) && transactionVars.has(e.expression.text))
    );
  }
  return false;
}

for (const { sf } of sources) {
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isTransactionCall(n.initializer))
      transactionVars.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// Named function bodies, by bare name, across every file.
const functionsByName = new Map(); // name -> [{file, node, body}]
function addFn(name, file, node, body) {
  if (!name || !body) return;
  if (!functionsByName.has(name)) functionsByName.set(name, []);
  functionsByName.get(name).push({ file, node, body });
}
for (const { file, sf } of sources) {
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) addFn(n.name.text, file, n, n.body);
    else if (ts.isMethodDeclaration(n) && n.name && ts.isIdentifier(n.name)) addFn(n.name.text, file, n, n.body);
    else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      addFn(n.name.text, file, n, n.initializer.body);
    else if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      addFn(n.name.text, file, n, n.initializer.body);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function someDescendant(node, pred) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (pred(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

// Fixpoint: a writer is a named function containing a write or a call to a writer.
const sfOf = new Map(sources.map(({ file, sf }) => [file, sf]));
const writers = new Set();
for (let changed = true; changed; ) {
  changed = false;
  for (const [name, defs] of functionsByName) {
    if (writers.has(name)) continue;
    const writes = defs.some(({ file, body }) =>
      someDescendant(
        body,
        (n) => isDirectWrite(n, sfOf.get(file)) || (ts.isCallExpression(n) && writers.has(calleeName(n))),
      ),
    );
    if (writes) {
      writers.add(name);
      changed = true;
    }
  }
}
// A writer "catches internally" if any definition has a try/catch around a write.
const catchingWriters = new Set(
  [...writers].filter((name) =>
    functionsByName.get(name).some(({ body }) =>
      someDescendant(body, (n) => ts.isTryStatement(n) && !!n.catchClause),
    ),
  ),
);

function isWriteOrWriterCall(n, sf) {
  return isDirectWrite(n, sf) || (ts.isCallExpression(n) && writers.has(calleeName(n)));
}

function loopBody(n) {
  if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n))
    return { kind: ts.SyntaxKind[n.kind].replace("Statement", ""), body: n.statement };
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && LOOP_METHODS.has(n.expression.name.text)) {
    const fn = n.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (fn) return { kind: `.${n.expression.name.text}()`, body: fn.body };
  }
  return undefined;
}

// Nearest enclosing router.<verb>("path", ...) or named function, for the report.
function context(n, sf) {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression)) {
      const verb = p.expression.name.text;
      const recv = p.expression.expression.getText(sf);
      if (/^(router|app|\w+Router)$/.test(recv) && ["get", "post", "put", "patch", "delete", "all"].includes(verb)) {
        const first = p.arguments[0];
        const route = first && ts.isStringLiteralLike(first) ? first.text : first?.getText(sf);
        return `${verb.toUpperCase()} ${route}`;
      }
      if (recv === "cron" && verb === "schedule") return `cron ${p.arguments[0]?.getText(sf)}`;
    }
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return `fn ${p.name.getText(sf)}`;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)))
      return `fn ${p.name.text}`;
  }
  return "module";
}

function insideTransaction(n) {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && calleeName(p) === "transaction") return true;
  }
  return false;
}

const lineOf = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

const rows = [];
let loopsSeen = 0;
for (const { file, sf } of sources) {
  const visit = (n) => {
    const loop = loopBody(n);
    if (loop) {
      loopsSeen++;
      const writeLines = [];
      const caughtLines = [];
      const helpers = new Set();
      const scan = (m) => {
        // Nested loops are reported on their own; still count their writes here.
        if (isWriteOrWriterCall(m, sf)) {
          writeLines.push(lineOf(sf, m));
          const name = calleeName(m);
          if (!isDirectWrite(m, sf) && name) helpers.add(name);
          // Caught inside this loop body?
          for (let p = m.parent; p && p !== loop.body.parent; p = p.parent) {
            if (ts.isBlock(p) && ts.isTryStatement(p.parent) && p.parent.tryBlock === p && p.parent.catchClause) {
              caughtLines.push(lineOf(sf, m));
              break;
            }
          }
        }
        ts.forEachChild(m, scan);
      };
      scan(loop.body);
      if (writeLines.length > 0) {
        const helperCatches = [...helpers].filter((h) => catchingWriters.has(h));
        const shape =
          caughtLines.length > 0
            ? "CAUGHT-IN-LOOP"
            : helperCatches.length > 0
              ? "HELPER-CATCHES"
              : "UNCAUGHT";
        rows.push([
          `${file}:${lineOf(sf, n)}`,
          loop.kind,
          shape,
          insideTransaction(n) ? "in-tx" : "no-tx",
          someDescendant(loop.body, (m) => ts.isCallExpression(m) && calleeName(m) === "shutdownCheckpoint")
            ? "checkpoint"
            : "no-checkpoint",
          context(n, sf),
          `writes@${[...new Set(writeLines)].join(",")}`,
          helpers.size ? `via ${[...helpers].join(",")}` : "",
          helperCatches.length ? `helper-catch ${helperCatches.join(",")}` : "",
        ]);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

for (const r of rows) console.log(r.filter(Boolean).join("\t"));
const byShape = rows.reduce((acc, r) => ((acc[r[2]] = (acc[r[2]] || 0) + 1), acc), {});
console.log(
  `SUMMARY files=${files.length} loops=${loopsSeen} write_loops=${rows.length} ` +
    Object.entries(byShape)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") +
    ` writers=${writers.size}`,
);
if (showAll) console.log(`WRITERS ${[...writers].sort().join(" ")}`);
