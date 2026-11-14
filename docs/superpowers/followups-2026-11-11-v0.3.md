# v0.3 follow-ups (from the final review)

Not blocking the v0.3 merge; one line each.

- T1: the inline-vs-path check for the private key could use `/BEGIN [A-Z ]*PRIVATE KEY/`; the unreadable-file test should assert the path; no in-flight token de-duplication.
- T2: the pagination/request URL prefix is checked by string rather than URL origin (safe today); POST unknown-status is tested only for 503; the network-error scrub is untested; a 201 with a non-JSON body reads as a failure; the empty-title error message is awkward.
- (done in v0.4) T3: edge-case tests for the App Store store: no info or no version, one side only, whitespace-only remote values.
- T4: (done in v0.4: the redundant `abort()` removed) a `commit()` failure on a non-atomic store has no partial-progress message (open).
- (done in v0.4) T5: the "Some changes were skipped" final note is now store-specific; `--store foo` is tested on `push` too.
- T6: App Store Connect UI labels and whether the App Manager role is sufficient are unverified against Apple documentation.
- Verify against a real app: `whatsNew` on a first version (I3), the list of editable states, promotional text on the live version.
- Extra (from this fix wave): with versions present but none editable or live (for example only "in review"), the store note says "No editable or live App Store version"; the wording is untested against a real account.

## Noted at the final re-review
- (done in v0.4) M2 side effect: a locale present in app info localizations but missing on the live version, with only promotional_text changed and no editable version, shows as a pushable change; update() sends nothing yet push reports it as pushed. Filter such changes as skipped.
- (done in v0.4) Spec §7.2 bullet nesting fixed.
