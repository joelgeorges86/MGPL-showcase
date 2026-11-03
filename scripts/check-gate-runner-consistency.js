"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const files = {
  skill: path.join(root, ".agents", "skills", "mgpl-gate-runner", "SKILL.md"),
  powershell: path.join(root, ".agents", "skills", "mgpl-gate-runner", "scripts", "run-gates.ps1"),
  bash: path.join(root, ".agents", "skills", "mgpl-gate-runner", "scripts", "run-gates.sh"),
  shell: path.join(root, "gates", "run-all.sh"),
  pullRequestWorkflow: path.join(root, ".github", "workflows", "pull-request-validation.yml"),
  deployWorkflow: path.join(root, ".github", "workflows", "deploy-preprod.yml"),
  notificationsWorkflow: path.join(root, ".github", "workflows", "pr-notifications.yml"),
  lintGate: path.join(root, "gates", "q1-lint.sh"),
  changedFiles: path.join(root, "scripts", "lib", "changed-files.js"),
  eslintCheck: path.join(root, "scripts", "check-eslint-changed.js"),
  formatCheck: path.join(root, "scripts", "check-format-changed.js"),
};

// The exact shard step both workflows run: the shard total comes from the
// matrix, a stray test.only fails the run, and failures are annotated.
const SHARD_RUN =
  /^ {8}run: npm run test:e2e -- --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\} --forbid-only --reporter=list,github[ \t]*$/m;

function read(name) {
  const filePath = files[name];
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required gate-runner file is missing: ${path.relative(root, filePath)}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function count(text, pattern) {
  return (text.match(pattern) || []).length;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Splits a workflow's jobs section into one text block per job id.
function jobBlocks(workflow) {
  const start = workflow.search(/^jobs:[ \t]*$/m);
  assert(start !== -1, "workflow has no jobs section");
  const body = workflow.slice(start);
  const marks = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)];
  const blocks = new Map();
  marks.forEach((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].index : body.length;
    blocks.set(mark[1], body.slice(mark.index, end));
  });
  return blocks;
}

function job(blocks, workflowName, id) {
  const block = blocks.get(id);
  assert(block, `${workflowName} must define the ${id} job`);
  return block;
}

function main() {
  const skill = read("skill");
  const powershell = read("powershell");
  const bash = read("bash");
  const shell = read("shell");
  const pullRequestWorkflow = read("pullRequestWorkflow");
  const deployWorkflow = read("deployWorkflow");
  const notificationsWorkflow = read("notificationsWorkflow");
  const lintGate = read("lintGate");
  const changedFiles = read("changedFiles");
  const eslintCheck = read("eslintCheck");
  const formatCheck = read("formatCheck");

  assert(
    !/Playwright E2E|playwright["']?,\s*["']test/i.test(powershell),
    "run-gates.ps1 must not execute Playwright; CI owns E2E execution",
  );
  assert(
    !/Playwright E2E|playwright\s+test/i.test(bash),
    "run-gates.sh must not execute Playwright; CI owns E2E execution",
  );
  assert(
    !/playwright\s+test/i.test(shell),
    "gates/run-all.sh must not execute Playwright; test-e2e owns CI E2E execution",
  );
  assert(
    !/mgpl-gate-guard\.js["']?\s+record/.test(shell),
    "gates/run-all.sh must not record gate evidence",
  );
  assert(
    !/\/mnt\/c\/Users\/joelg/i.test(bash),
    "run-gates.sh must not use the WSL /mnt/c Doppler fallback",
  );
  assert(/WSL launchers are not supported/i.test(bash), "run-gates.sh must reject WSL launchers");
  assert(
    /Environment doctor/.test(skill) && /gates\/run-all\.sh/.test(skill),
    "SKILL.md must document the complete reduced local chain",
  );
  assert(
    !/local[^\n]*Playwright|Playwright[^\n]*local/i.test(skill),
    "SKILL.md must not assign Playwright to the local chain",
  );

  for (const [name, workflow] of [
    ["pull-request-validation.yml", pullRequestWorkflow],
    ["deploy-preprod.yml", deployWorkflow],
  ]) {
    assert(
      count(workflow, /name:\s*(?:Staging|Preprod )?Playwright E2E Suite/g) === 1,
      `${name} must define exactly one Playwright E2E job`,
    );
    assert(
      count(workflow, /run:\s*npm run test:e2e/g) === 1,
      `${name} must run npm run test:e2e exactly once`,
    );
    assert(
      count(workflow, /run:\s*bash gates\/run-all\.sh/g) === 1,
      `${name} must run gates/run-all.sh exactly once`,
    );
    const lintTestBlock = workflow.split(/\n\s{2}test-e2e:/, 1)[0];
    assert(
      !/playwright\s+test|npm run test:e2e/i.test(lintTestBlock),
      `${name} lint-test job must not execute Playwright`,
    );

    // E2E runs as a shard matrix; the lint checks get a base and full history.
    const jobs = jobBlocks(workflow);
    const e2e = job(jobs, name, "test-e2e");
    assert(
      /^ {6}matrix:[ \t]*\r?\n {8}shard: \[[0-9, ]+\][ \t]*$/m.test(e2e),
      `${name} test-e2e must be a shard matrix`,
    );
    assert(
      /^ {6}fail-fast: false[ \t]*$/m.test(e2e),
      `${name} test-e2e must let every shard finish (fail-fast: false)`,
    );
    assert(
      /^ {10}name: playwright-traces-shard-\$\{\{ matrix\.shard \}\}[ \t]*$/m.test(e2e),
      `${name} test-e2e must give each shard's trace artifact its own name`,
    );
    assert(
      SHARD_RUN.test(e2e),
      `${name} test-e2e must run npm run test:e2e with --shard=N/total, --forbid-only and the github reporter`,
    );
    const lintTest = job(jobs, name, "lint-test");
    const baseField = name === "deploy-preprod.yml" ? "before" : "pull_request.base.sha";
    assert(
      lintTest.includes(`      MGPL_LINT_BASE: \${{ github.event.${baseField} }}`),
      `${name} lint-test must set MGPL_LINT_BASE to github.event.${baseField}`,
    );
    assert(
      /^ {10}fetch-depth: 0[ \t]*$/m.test(lintTest),
      `${name} lint-test must check out full history for MGPL_LINT_BASE`,
    );
  }

  // The required Playwright E2E Suite check in the PR workflow is the result
  // job: it always runs, and it depends on change detection and the shards.
  const prJobs = jobBlocks(pullRequestWorkflow);
  const prName = "pull-request-validation.yml";
  const result = job(prJobs, prName, "e2e-result");
  assert(
    /^ {4}name: Playwright E2E Suite[ \t]*$/m.test(result),
    `${prName}: the Playwright E2E Suite check must be the e2e-result job`,
  );
  assert(
    /^ {4}if: always\(\)[ \t]*$/m.test(result),
    `${prName}: e2e-result must always run, so the required check is never skipped`,
  );
  assert(
    /^ {4}needs: \[changes, test-e2e\][ \t]*$/m.test(result),
    `${prName}: e2e-result must depend on changes and test-e2e`,
  );
  // Each condition must be bound to its own exit, in this order: a swapped
  // exit status would keep every string and count but change the result.
  const resultFlow = (result.match(/^ +(?:if \[ .* \]; then|exit [01])[ \t]*$/gm) || []).map(
    (line) => line.trim(),
  );
  assert(
    JSON.stringify(resultFlow) ===
      JSON.stringify([
        'if [ "$CHANGES_RESULT" != "success" ]; then',
        "exit 1",
        'if [ "$E2E_REQUIRED" = "false" ]; then',
        "exit 0",
        'if [ "$SHARDS_RESULT" = "success" ]; then',
        "exit 0",
        "exit 1",
      ]),
    `${prName}: e2e-result must fail when change detection did not succeed, and pass only when E2E was not required or every shard passed`,
  );
  assert(
    /^ {4}if: needs\.changes\.outputs\.e2e == 'true'[ \t]*$/m.test(job(prJobs, prName, "test-e2e")),
    `${prName}: test-e2e must run whenever change detection requires E2E`,
  );
  const changes = job(prJobs, prName, "changes");
  assert(
    /--no-renames/.test(changes) && /"\$BASE_REF" != "develop"/.test(changes),
    `${prName}: change detection must count renames as deletions and require E2E outside develop`,
  );
  assert(
    changes.includes(
      "other=$(awk 'NF && !/^DOCS\\// && !(/\\.md$/ && !/^(src|public|test)\\//) { n++ } END { print n + 0 }' \"$changed\")",
    ),
    `${prName}: change detection must skip E2E only for DOCS/ and Markdown outside src/, public/ and test/`,
  );
  assert(
    /^ {4}needs: \[lint-test, test-e2e\][ \t]*$/m.test(
      job(jobBlocks(deployWorkflow), "deploy-preprod.yml", "build-push"),
    ),
    "deploy-preprod.yml: build-push must wait for every E2E shard",
  );

  // Every CI job has a time limit, so a hung run cannot burn hours of minutes.
  for (const [name, workflow] of [
    ["pull-request-validation.yml", pullRequestWorkflow],
    ["deploy-preprod.yml", deployWorkflow],
    ["pr-notifications.yml", notificationsWorkflow],
  ]) {
    for (const [id, block] of jobBlocks(workflow)) {
      assert(
        /^ {4}timeout-minutes: \d+[ \t]*$/m.test(block),
        `${name} job ${id} must set timeout-minutes`,
      );
    }
  }

  // ESLint and Prettier examine the files a change touches (#97, #124).
  assert(
    /^export MGPL_LINT_BASE="\$\{MGPL_LINT_BASE:-auto\}"[ \t]*$/m.test(lintGate),
    "gates/q1-lint.sh must give the ESLint and Prettier checks a base",
  );
  assert(
    changedFiles.includes("return `:(glob)${pattern}`;") &&
      changedFiles.includes('"core.quotePath=false"') &&
      changedFiles.includes('"-z"') &&
      changedFiles.includes('"--diff-filter=ACMR"') &&
      changedFiles.includes("process.env.MGPL_LINT_BASE") &&
      changedFiles.includes("pickBaseBranch"),
    "scripts/lib/changed-files.js must select changed files by glob pathspec, NUL-separated, against MGPL_LINT_BASE",
  );
  for (const [name, text] of [
    ["check-eslint-changed.js", eslintCheck],
    ["check-format-changed.js", formatCheck],
  ]) {
    assert(
      /require\("\.\/lib\/changed-files"\)/.test(text),
      `${name} must select files through scripts/lib/changed-files.js`,
    );
    assert(
      !/"[^"\n]*\{[^"\n}]*,[^"\n}]*\}[^"\n]*"/.test(text),
      `${name} must not use {a,b} patterns; git pathspecs never expand them`,
    );
    assert(
      /"--", \.\.\.files\]/.test(text),
      `${name} must pass "--" before the file list, so a file named like an option is still checked`,
    );
  }

  console.log("Gate-runner consistency passed.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Gate-runner consistency failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };
