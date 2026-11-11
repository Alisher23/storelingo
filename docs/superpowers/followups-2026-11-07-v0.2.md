# v0.2 follow-ups (recorded 2026-11-07, not fixed in v0.2)

- E_IN_REVIEW detection relies on details[].reason CHANGES_ALREADY_IN_REVIEW; also match the message text and verify against a real in-review app.
- An edit-level 404 (expired edit) is reported as "app not found" (E_CONFIG).
- A 2xx non-JSON commit response should be "status unknown", not E_STORE non-JSON.
- Google's "changes cannot be sent for review automatically... changesNotSentForReview" error: document it or add a flag.
- A retried insertEdit after a 5xx can orphan an edit (it expires; harmless).
- A relative STORELINGO_PLAY_SERVICE_ACCOUNT path resolves against process.cwd(), not deps.cwd.
- Token provider: body-read abort or non-JSON is reported as "rejected (HTTP n)"; no in-flight dedupe; expires_in is not validated.
- Retry-After is uncapped (cap at about 60 s); the invalid-segment message does not name the segment; "error 400: " appears with an empty message.
- computeDiff writes an empty local value (unreachable via readLocalListings); add duplicate-locale tests.
- pull: unknown field keys from a future adapter throw a plain Error; thin unsafe-locale test; Windows reserved names.
- push: possible double abort (harmless); shared `yes` mock; the E_IN_REVIEW test does not assert that updates were sent.
- CLI coverage gaps: invalid --store, appstore info line, pull --force, deps.confirm yes, CLI-level E_AUTH_PLAY/E_STORE; the default-store notice is undocumented.
- npm audit: 9 moderate issues, in dev dependencies only.

## Noted at the final re-review
- Diff window is cut by code point, so it can split grapheme clusters (ZWJ emoji, combining marks); display only.
- Inline STORELINGO_PLAY_SERVICE_ACCOUNT JSON is masked only as a whole string; a fragment quoted in an error would not be masked (no error quotes the key today).
- (done) push non-TTY stdout rule documented in CHANGELOG.
