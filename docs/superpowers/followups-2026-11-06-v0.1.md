# storelingo v0.1 — follow-ups

Deferred minor findings and parked items from the v0.1 task and final reviews (branch feat/v0.1-core). Many are good first issues. Items fixed in the final fix wave are not listed here (see commits 4a0a285..728be20).

## Parked after final review
- openai-compatible fetch follows redirects (307/308 resend body to another host) — Ruling: real, defer to v0.2 hardening (set redirect: "error"); Authorization is dropped cross-origin by undici so keys are safe — cost if wrong: listing text could reach a redirect target on an allowed host.
- init writes config/.gitignore with plain writeFile (follows planted symlink) — Ruling: low risk (interactive, user's own project), defer — cost if wrong: init in a hostile clone could overwrite a symlink target.
- listLocales unused and not symlink-guarded; I4 gap when name translation fails in the same job — Ruling: defer.

## Deferred minors (per task; some were fixed in the final fix wave — re-check before working on one)
- Task 1: minor (deferred): test/util/chars.test.ts:15 combining mark is a raw invisible literal; prefer the "\u0301" escape (NFC-normalizing editors would flip it).
- Task 2: minor (deferred): src/log.ts mask order — sort secrets by length desc so a secret that is a substring of another can't leave fragments.
- Task 2: minor (deferred): test/log.test.ts masking only tested on info; test/errors.test.ts exit-code mapping not table-driven.
- Task 3: minor (deferred): FieldDef fields not readonly (shared mutable registry objects); uniqueness test covers only play.
- Task 4: minor (deferred): locale code naming mixes language-only (de) and region-qualified (es-ES, fr-FR) codes — document in README; add test that every row has play or appstore; table lacks bg/et/lt/lv/sl/sr/bn/ta/zh-HK.
- Task 5: minor (deferred): unknown config keys silently stripped (consider .strict()); literal invisible U+FEFF in load.ts BOM regex (use \uFEFF escape) + BOM path untested; duplicate targetLocales accepted; unknown-locale hint points at src/locales/table.ts which npm package does not ship; JSON parse error drops cause/position; EACCES/EISDIR rethrown raw; tmp dirs never cleaned.
- Task 6: minor (deferred): changelog name rebuilt from Number() (007.txt -> 7.txt); isNotFound derefs .code on unknown; writeField doesn't enforce no-BOM/LF (relies on callers); symlinked locale dirs skipped; trade_representative dir + non-ENOENT rethrow untested.
- Task 7: minor (deferred): invalid-JSON/empty lock file untested; saveLock not atomic (temp+rename); ENOENT cast unchecked.
- Task 8: minor (deferred): runPool concurrency<=0 silently runs nothing (config schema enforces min 1); on worker rejection other lanes keep going; retryAfterMs uncapped; jitter term not asserted by tests; no rejection-propagation test.
- Task 9: minor (deferred): keywords dedupe is whole-keyword only though prompt says 'no repeated words'; name/subtitle exclusion splits on whitespace only (weak for CJK); shorten prompt omits doNotTranslate and 'no spaces' rule; ZERO_USAGE mutable export; addUsage / maxChars:null / play-store prompt branch untested.
- Task 10: minor (deferred): malformed 200 JSON body throws bare SyntaxError (not E_TRANSLATOR); no fetch timeout/AbortSignal; APIConnectionError message shows 'error undefined'; other stop_reasons fall through as data undefined; auth/API error branches, OPENAI_API_KEY passthrough, 5xx exhaustion and network errors untested.
- Task 10: minor (deferred): redaction exact-string only (escaped/encoded echoes not caught); host-case/trailing-dot/userinfo/port cases unpinned by tests; non-http(s) schemes not rejected at config time.
- Task 11: minor (deferred): empty model reply accepted as '' (even for required name); malformed shorten reply silently burns an attempt; non-BMP/maxShortenAttempts/keyword-shortening tests missing; misleading test name 'E_LIMIT-style'; empty fields still calls LLM; unchecked cast.
- Task 10: minor (deferred): hostless baseUrl + empty host var returns key (guard with host &&); parseBaseUrl error echoes raw baseUrl (may include userinfo).
- Task 12: minor (deferred): resolveFieldPath/source re-read per locale (hoist); unsupported-source-locale error branch, URL fields, whitespace-only target untested; CheckIssue.locale mixes config vs store codes; 'missing' wording for whitespace-only file.
- Task 13: minor (deferred): fully failed job's usage dropped; no concurrent shared-lock test; failed-job test doesn't assert lock omits de-DE; multi-trailing-newline and skip-empty-source paths untested.
- Task 13: minor (deferred): readField on a path that is a directory throws EISDIR during planning (uncaught, aborts run before any work).
- Task 13: minor (deferred): no fsync before rename; stale .tmp left after failed save; Windows EPERM on rename over open file untested.
- Task 14: minor (deferred → partly carried to Task 15): init doesn't say which env var to set for openai-compatible hosts (carry: CLI init 'Next:' hint names env vars); exists()+writeFile TOCTOU; no validate callbacks on package name/app id; no test that invalid answers write nothing, gitignore partial/no-trailing-newline, single-store.
- Task 15: minor (deferred): check issue lines and commander writeOut/writeErr bypass masking; init-hint test asserts only one var; coverage gaps (unknown option exit 2, variadic --locale, init --force, --verbose, --no-color); .version duplicates package.json; Ctrl+C in init → exit 1 'error:'.
- Task 16: minor (deferred): exit-code table omits exit 1 for runtime errors (unsupported source locale, E_TRANSLATOR); --locale outside targetLocales error not documented; 'tokens' wording; illustrative Ollama/OpenRouter model names.
