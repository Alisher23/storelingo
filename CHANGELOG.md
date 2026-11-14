# Changelog

## 0.4.0 — unreleased

- GitHub Action (`uses: Alisher23/storelingo@main`): runs `translate` and/or `check` in CI. Optional `commit` of the translated files: only storelingo output is committed, only on a push to a branch, and never after a failed `translate` or `check`. Setup guide in `docs/github-action.md`.
- Retry-After delays from servers are capped at 60 s, and the cap is configurable (thanks @yonash24, #10).
- App Store: promotional text without an editable version is sent only for languages that already exist on the live version; other languages are shown as skipped.
- The final "some changes were skipped" note is store-specific.

## 0.3.0 — unreleased

- **Breaking:** `stores.appstore.appId` must be the numeric Apple ID (for example `1234567890`), not the bundle ID.
- App Store `pull` / `push` (`--store appstore`) through the App Store Connect API with a team API key (`STORELINGO_ASC_ISSUER_ID`, `STORELINGO_ASC_KEY_ID`, `STORELINGO_ASC_PRIVATE_KEY`); setup guide in `docs/app-store-setup.md`.
- `pull` and `push` without `--store` now run every configured store (Google Play, then the App Store), each with its own diff and confirmation.
- App Store `push` is not atomic: it applies one language at a time, sends only the changed fields, and on a failure reports "already applied: ...; failed (may be partly applied): ...; not attempted: ..."; re-running only sends what still differs.
- `pull` and `push` load the credentials of every selected store before touching any of them, so a missing App Store key no longer shows up after Google Play was already pushed.
- Release notes are not sent for the first version of an app (Apple shows them only for updates); skipped lines name their real reason; several editable versions or app infos prefer `PREPARE_FOR_SUBMISSION` or fail with a clear `E_STORE`; paginated App Store Connect lists are capped and never silently truncated.
- Fields are routed to the resource that can take them: `name`, `subtitle`, `privacy_url` to the editable app info; `description`, `keywords`, `release_notes`, `marketing_url`, `support_url` to the editable version; `promotional_text` to the editable version or else the live one. Changes with no such resource are shown as skipped and never sent.
- Requests that create a localization are never retried; a lost response is reported as "status is unknown".
- New `stores.appstore.platform` option (`IOS` by default).
- Error codes `E_AUTH_ASC` and `E_NO_EDITABLE_VERSION` are now used.
- `STORELINGO_ASC_PRIVATE_KEY` is masked in logs and errors.

## 0.2.0 — unreleased

- `pull`: download the current Google Play listings into the fastlane folders. Never commits and never touches the lock file; keeps different local files unless `--force`.
- `push`: runs `check`, shows the diff with the live Google Play listing and uploads after confirmation (`--dry-run`, `--yes`; outside a terminal it needs one of them). One Play edit per push, committed with `ERROR_IF_IN_REVIEW` so changes already in review are never cancelled.
- `push` counts as interactive only when both input and output are a terminal: with output redirected or piped (e.g. `storelingo push > log.txt`, `storelingo push | tee log.txt`) it needs `--yes` or `--dry-run`.
- The `push` diff shows the part of a long value where it actually changes, with character counts.
- Google Play service account authentication via `STORELINGO_PLAY_SERVICE_ACCOUNT`; setup guide in `docs/google-play-setup.md`.
- New error codes `E_IN_REVIEW` and `E_STORE`.
- Hardening: the OpenAI-compatible translator no longer follows redirects.
- Hardening: `init` refuses symbolic links at `storelingo.config.json` and `.gitignore`.
- `--store appstore` is rejected until v0.3.

## 0.1.0 — unreleased

- `init`: create `storelingo.config.json` and fastlane folders.
- `translate`: AI localization with store limits, keyword rules, lock file and manual-edit protection.
- `check`: offline validation of limits, missing fields and keyword format.
- Translators: Claude API and any OpenAI-compatible endpoint.
