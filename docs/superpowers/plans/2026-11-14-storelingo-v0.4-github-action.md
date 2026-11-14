# storelingo v0.4 (GitHub Action + follow-ups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let projects run storelingo in GitHub Actions (`uses: Alisher23/storelingo@<ref>`) to translate and check store listings on push / pull requests, and close the most useful v0.3 follow-ups.

**Architecture:** A composite action (`action.yml` at the repo root) that builds storelingo from the action's own checkout (no npm package needed) and runs `translate` and/or `check` in the user's working directory, optionally committing the translated files back to the branch. A tiny OpenAI-compatible mock server in `test/fixtures/` lets a self-test workflow exercise the real CLI end to end without secrets.

**Spec:** `docs/superpowers/specs/2026-11-06-storelingo-design.md` §10 ("После v1.0: GitHub Action-обёртка (`storelingo translate` + `check` в PR)"), §5.4, §7.2.

## Global Constraints

- All v0.1–v0.3 constraints hold (strict TS, no new runtime deps, secrets only from env and never logged, BOM only as `﻿`, byte-check escapes you write — this tooling has eaten backslashes before).
- **Workflow security:** in `action.yml` never interpolate `${{ inputs.* }}` or `${{ github.* }}` user-controlled values directly inside `run:` scripts — pass them through `env:` and reference `"$VAR"`. Document that the action must not be used with `pull_request_target` + checking out PR code, and that secrets are not available to pull requests from forks (so `translate` there will fail; `check` needs no secrets).
- The action never pushes unless `commit: "true"`; it commits only files changed by storelingo (fastlane metadata folders and `storelingo.lock.json` inside `working-directory`), as `github-actions[bot]`, and pushes to the current branch name.
- Commit trailers name the authoring model.

---

### Task 1: The GitHub Action, an end-to-end self-test, and docs

**Files:** create `action.yml`, `test/fixtures/mock-llm.mjs`, `test/fixtures/action-project/**`, `.github/workflows/action-selftest.yml`, `docs/github-action.md`, `docs/github-action.ru.md`; modify `README.md`, `README.ru.md`.

`action.yml` (composite):
- `name: storelingo`, `description: AI localization of Google Play and App Store listings (fastlane metadata)`, `branding: { icon: globe, color: blue }`.
- Inputs (all strings): `command` (`translate`, `check` or `translate-and-check`; default `translate-and-check`), `working-directory` (default `.`), `args` (extra arguments for `translate`, default empty), `commit` (`"true"`/`"false"`, default `"false"`), `commit-message` (default `chore: update store listing translations (storelingo)`), `anthropic-api-key`, `openai-api-key`, `translator-api-key`, `translator-api-host` (all optional, default empty), `node-version` (default `22`).
- Output: `changed` (`"true"` when the commit step found changed files, else `"false"`).
- Steps:
  1. `actions/setup-node@v4` with `node-version: ${{ inputs.node-version }}`.
  2. Validate `command` (env var; `case` statement; unknown → `::error::` and exit 1).
  3. Build: `working-directory: ${{ github.action_path }}`, `npm ci --no-audit --no-fund && npm run build`.
  4. Translate (when command includes translate): `working-directory: ${{ inputs.working-directory }}`; env `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `STORELINGO_TRANSLATOR_API_KEY`, `STORELINGO_TRANSLATOR_API_HOST` from inputs, `STORELINGO_ARGS` from `inputs.args`; run `set -f; node "$GITHUB_ACTION_PATH/dist/bin.js" translate $STORELINGO_ARGS` (word-splitting of args is intended; `set -f` disables globbing). Mask the key inputs with `::add-mask::` first (only when non-empty).
  5. Check (when command includes check): `node "$GITHUB_ACTION_PATH/dist/bin.js" check` in the working directory.
  6. Commit (always runs, id `commit`): if `inputs.commit` != `"true"` → `changed=false`. Else: `git status --porcelain -- .` in the working directory; if empty → `changed=false`; else configure `github-actions[bot]` (`41898099+github-actions[bot]@users.noreply.github.com`), `git add -A -- .`, commit with the message from env, push with `git push origin "HEAD:$BRANCH"` where `BRANCH` = `github.head_ref || github.ref_name` (via env); `changed=true`. Write the output to `$GITHUB_OUTPUT`.
  Translate and check failures must fail the job (non-zero exit), but the check step must still run after a translate failure only if command is `check` — keep it simple: steps run in order and stop on the first failure.

`test/fixtures/mock-llm.mjs`: a Node HTTP server on `127.0.0.1:<port from argv or 8787>` answering `POST /v1/chat/completions`. It reads the last user message, extracts the key list from the trailing line `Respond with a JSON object with keys: a, b.`, and returns `{ choices: [{ message: { content: JSON.stringify({ <key>: "<short value>" }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }` where each value is short enough for every store limit (e.g. `"Mock " + key` cut to 20 characters; for `keywords` use `"mock,test"`). Any other path → 404. It must work as `node test/fixtures/mock-llm.mjs 8787 &`.

`test/fixtures/action-project/`: `storelingo.config.json` (source `en-US`, targets `["ru","de"]`, `stores.play.packageName: "com.example.selftest"`, translator `{ "provider": "openai-compatible", "baseUrl": "http://127.0.0.1:8787/v1", "model": "mock" }`), plus `fastlane/metadata/android/en-US/{title,short_description,full_description}.txt` within limits. No lock file, no translations committed.

`.github/workflows/action-selftest.yml`: on `push` to main and `pull_request`; one job on `ubuntu-latest`: checkout; start the mock server in the background and wait until it answers; `uses: ./` with `command: translate-and-check`, `working-directory: test/fixtures/action-project`, `commit: "false"`; then a step that asserts `test/fixtures/action-project/fastlane/metadata/android/ru-RU/title.txt` and `.../de-DE/title.txt` exist and `storelingo.lock.json` was written. Permissions: `contents: read`.

Docs `docs/github-action.md` (+ `.ru.md` with the same meaning): quick start workflow (translate on push to main with `commit: "true"`, `permissions: contents: write`); a PR check-only workflow (no secrets needed); inputs/outputs table; secrets setup (`ANTHROPIC_API_KEY` as a repository secret); fork PR limitation; the `pull_request_target` warning; `uses: Alisher23/storelingo@main` until a release tag exists (then pin a tag or commit SHA). README/README.ru: short "GitHub Action" section linking the guide (absolute GitHub URLs), roadmap updated.

Verification: the self-test workflow can't run locally; instead run the same sequence locally in Git Bash: start the mock server, `npm run build`, `cd test/fixtures/action-project && node ../../../dist/bin.js translate && node ../../../dist/bin.js check`, verify files, then `git checkout -- . && git clean -fd test/fixtures/action-project` to discard generated files. Paste the output in the report. Also validate `action.yml` and the workflow are valid YAML (`node -e` with a tiny parse via `npx --yes yaml@2 valid` is NOT allowed — no new tooling; instead read them back carefully and keep them simple). Commit `feat: GitHub Action with end-to-end self-test`.

---

### Task 2: v0.3 follow-ups

**Files:** `src/stores/types.ts`, `src/stores/app-store/store.ts`, `src/commands/push.ts`, `src/cli/main.ts`, their tests, `docs/superpowers/followups-2026-11-11-v0.3.md`.

1. **M2 side effect (correctness).** `isWritable` becomes `isWritable?(field: string, locale?: string): boolean`. The App Store adapter returns false for `promotional_text` when there is no editable version and the live version has no localization for that locale (creating one on a live version is not allowed). `push` passes the locale. `skipReason?(field, locale?)` gives "skipped (this language doesn't exist on the live version yet)". Play unaffected. Tests: adapter + push (the change is skipped, not reported as pushed).
2. **T4:** remove the redundant explicit `abort()` before throwing `E_NO_EDITABLE_VERSION` (the outer catch aborts); keep the test that asserts `aborted: 1`.
3. **T5:** the CLI's final "Some changes were skipped…" note is store-specific: App Store → "create a new version in App Store Connect to push them"; other stores → "these fields can't be changed in <Store name>". Add a `--store foo` test for `push`.
4. **T3:** App Store store edge-case tests: no app info and no version (listings `[]`, nothing writable, notes present), info only, version only, whitespace-only remote values dropped.
5. Update the followups file: mark these items done.

TDD per code item. Commit `fix: v0.3 follow-ups (live-version promo per language, store-specific notes, edge-case tests)`.

---

### Task 3: Version 0.4.0

`package.json` (+ lock) version `0.4.0`; `CHANGELOG.md` `## 0.4.0 — unreleased` (GitHub Action, the follow-up fixes, contributor credit: "Retry-After delays are capped at 60 s (thanks @yonash24, #10)"). Gate: build, `node dist/bin.js --version` → 0.4.0. Commit `chore: version 0.4.0`.
