# Changelog

## 0.2.0 — unreleased

- `pull`: download the current Google Play listings into the fastlane folders. Never commits and never touches the lock file; keeps different local files unless `--force`.
- `push`: runs `check`, shows the diff with the live Google Play listing and uploads after confirmation (`--dry-run`, `--yes`; outside a terminal it needs one of them). One Play edit per push, committed with `ERROR_IF_IN_REVIEW` so changes already in review are never cancelled.
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
