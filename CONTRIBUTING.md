# Contributing to storelingo

Thanks for helping. Most contributions are small data changes: a new language, a corrected character limit.

## Setup

Requirements: Node.js >= 22.13 and npm.

```bash
git clone https://github.com/Alisher23/storelingo.git
cd storelingo
npm ci
npm test            # unit tests (vitest)
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
```

Before opening a PR, `npm run lint && npm run typecheck && npm test` must pass.

## Tests first

Write a failing test first, see it fail for the right reason, then make it pass. Bug fixes need a test that reproduces the bug. Tests live in `test/` and mirror `src/` (one `*.test.ts` per module). Tests must not call real APIs or need real keys.

## Common changes

### Add a locale

Add one row to `LOCALES` in `src/locales/table.ts`: storelingo's own `code`, English `name`, and the store codes (`play`, `appstore`) for the stores that support the language. Leave a store code out if that store does not support it. Add or extend a test in `test/locales/`. Mention the official source (Play Console / App Store Connect language list) in the PR.

### Update a character limit

Edit the field in `src/fields/registry.ts` and update the matching test. Link the official store documentation in the PR description.

### Add a translator provider

Implement the `LlmClient` interface (`src/translate/types.ts`) in a new file in `src/translate/providers/`, register it in `src/translate/providers/index.ts`, and add the provider to the config schema in `src/config/schema.ts`. Add tests with a fake `fetch`, no network. Keys must come only from environment variables and must never be sent to a host the user did not explicitly allow.

## Commit messages

Use a short imperative subject with a prefix: `feat:`, `fix:`, `docs:`, `chore:` (also `test:` and `refactor:` where they fit), for example `fix: keep trailing newline when writing fields`.

## Secrets

Never commit API keys, Play service-account JSON files, or App Store Connect `.p8` keys. Remove keys from logs and issue reports before pasting them.
