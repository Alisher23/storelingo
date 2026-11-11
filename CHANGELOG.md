# Changelog

## 0.3.0 — unreleased

- App Store `pull` / `push` (`--store appstore`) through the App Store Connect API with a team API key (`STORELINGO_ASC_ISSUER_ID`, `STORELINGO_ASC_KEY_ID`, `STORELINGO_ASC_PRIVATE_KEY`); setup guide in `docs/app-store-setup.md`.
- `pull` and `push` without `--store` now run every configured store (Google Play, then the App Store), each with its own diff and confirmation.
- App Store `push` is not atomic: it applies one language at a time and reports partial progress ("already applied ... not applied ..."); re-running only sends what still differs.
- Fields are routed to the resource that can take them: `name`, `subtitle`, `privacy_url` to the editable app info; `description`, `keywords`, `release_notes`, `marketing_url`, `support_url` to the editable version; `promotional_text` to the editable version or else the live one. Changes with no such resource are shown as skipped and never sent.
- Requests that create a localization are never retried; a lost response is reported as "status is unknown".
- New `stores.appstore.platform` option (`IOS` by default).
- New error codes `E_AUTH_ASC` and `E_NO_EDITABLE_VERSION`.
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
