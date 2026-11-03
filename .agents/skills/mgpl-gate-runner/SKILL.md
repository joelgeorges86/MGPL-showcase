---
name: mgpl-gate-runner
description: Run and report MGPL's complete local quality gate chain through Doppler before a pull request, merge, or completion claim. Use for MGPL validation and release-readiness checks; do not use it to deploy or mutate production.
---

# MGPL Gate Runner

Run the repository helper from the MGPL root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/mgpl-gate-runner/scripts/run-gates.ps1
```

The helper stops on the first failed gate and preserves the failing command's exit code. Do not skip, reinterpret, or mark a failed gate as passing.

The reduced local chain runs, in order:

1. AGENTS.md integrity.
2. Environment doctor.
3. TypeScript validation through Doppler.
4. Client JavaScript syntax validation through Doppler.
5. CSpell through Doppler.
6. Vitest through Doppler.
7. Security and quality gates through `gates/run-all.sh` via Doppler.

When every gate passes, the helper records gate evidence for the current commit in `.mgpl/gate-evidence.json`.

Playwright is CI-owned. The hosted workflows run the full E2E suite separately and must retain that coverage.

## Windows prerequisites

The helper runs on Windows through PowerShell. Check these before the first run in a new shell or a new worktree.

1. **Entry point.** Start the gates with the PowerShell command above, or with `npm run gates`, which runs the same command. Do not run `bash .agents/...` or `bash gates/...` from a Windows shell: bare `bash` resolves to the WSL launcher (`C:\Windows\System32\bash.exe`), which cannot run these scripts. `run-gates.sh` is not a Windows entry point. Git for Windows must be installed; the helper finds Git Bash itself and refuses the WSL launcher.
2. **Node.js 22.15 or a later 22.x release.** `node --version` must print `v22.15.0` or a later `v22` release, because the helper adds `--use-system-ca` (item 3), which earlier releases reject. The operator workstation uses 22.23.2. If the version is outside that range, run `nvm use 22.23.2` (nvm-windows), then check again. The helper stops before the first gate if node or npm is not on PATH, or if the version is outside that range.
3. **`NODE_OPTIONS=--use-system-ca`.** Where TLS traffic is intercepted, as on the operator workstation, Node rejects the npm registry certificate (`unable to verify the first certificate`) unless it uses the Windows certificate store. The flag adds the certificates in the Windows store, including a locally installed interception root, to the roots Node trusts; certificate validation stays on. The helper adds `--use-system-ca` to `NODE_OPTIONS` for its own gate processes. Outside the helper, set it in the shell before any command that contacts the npm registry, such as `npm audit` or `npm ci`:

   ```powershell
   $env:NODE_OPTIONS = "--use-system-ca"
   ```

   A User-scope `NODE_OPTIONS` setting reaches only shells opened after it was set.

4. **New worktree: Doppler binding and dependencies.** Doppler stores its project and config binding per directory, so a new worktree starts unbound, and the Environment doctor reports `Run doppler setup --project mgpl --config dev in this directory`. With `NODE_OPTIONS` set as in item 3, run the setup script from the worktree root through Git Bash, by full path:

   ```powershell
   & 'C:\Program Files\Git\bin\bash.exe' scripts/setup-worktree.sh
   ```

   The script binds the directory to `mgpl`/`dev` when it is unbound, confirms that Doppler injects secrets, installs dependencies when they are missing or inconsistent, verifies the database or creates it when it is missing, and runs the Environment doctor. A new worktree has no shorter manual equivalent: `doppler setup --project mgpl --config dev` and `npm ci` cover only the binding and the dependencies, not the database, and the helper cannot record gate evidence without one. For a worktree that is otherwise set up and fails only the Doppler binding check, `doppler setup --project mgpl --config dev` in that directory restores the binding.

5. **Norton Behavioral Protection.** Tests that create git repositories create them under the repository's git-ignored `.tmp_*` directories rather than `%TEMP%`. Behavioral Protection has still blocked writes to `.git/objects` in those repositories from time to time (#146, Finding C). Agents never change Norton settings. If a test reports `Permission denied` on `.git/objects`, stop and report it. The operator decides whether Behavioral Protection is on during gate runs.
6. **Doppler connectivity and the fallback file.** Run `doppler me` before a gate run. If the Doppler API cannot be reached, for example with `x509: certificate signed by unknown authority` under TLS interception, `doppler run` may continue from its encrypted fallback file, if an earlier successful fetch wrote one. It prints `Unable to fetch secrets from the Doppler API` and `Reading secrets from fallback file`, but the gates then run against values that may be stale. Stop and report the failure rather than gating on the fallback.

Before running, confirm the working directory is the MGPL repository and Doppler is configured for its local development environment. Never print secret values. If Doppler reports missing access or configuration, stop and report the problem rather than running bare commands.

Report each gate with its command and pass/fail result. Include the end-of-turn JSON required by `AGENTS.md`. A complete run is evidence for review readiness; it does not authorize a merge, deployment, production write, or infrastructure change.
