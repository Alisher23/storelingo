# storelingo

AI localization for your Google Play and App Store listings. Works with fastlane metadata — no fastlane required.

> Status: v0.2, not yet published to npm. The commands below show the intended usage (`npx storelingo`). Until the first release, build from source (see [CONTRIBUTING.md](https://github.com/Alisher23/storelingo/blob/main/CONTRIBUTING.md)).

[Русская версия](README.ru.md)

## Why

- **Store limits are respected.** Every field has its character limit (counted in Unicode code points). If a translation is too long, storelingo asks the model to shorten it, up to 2 times. Text is never truncated mechanically; if it still does not fit, the file is not written and the run reports an error.
- **Keywords are localized for search, not translated literally.** App Store keywords are chosen for what people in the target market search for, then normalized (comma-separated, no spaces, no duplicates, no words already in the name or subtitle).
- **Your manual edits are protected.** If you edit a translated file by hand, storelingo notices and skips it (use `--force` to overwrite).
- **Incremental.** A lock file records what was translated, so only changed source fields are sent to the model.
- **Bring your own model.** Claude (default) or any OpenAI-compatible endpoint, including a local Ollama.

## Quick start

```bash
npx storelingo init
export ANTHROPIC_API_KEY=sk-ant-...
npx storelingo translate
git diff
npx storelingo check
```

`init` asks a few questions and creates `storelingo.config.json` plus the fastlane folders. Put your source-language texts into those folders, then run `translate`. Review the result with `git diff`, and commit `storelingo.lock.json` together with the translations.

Requires Node.js >= 22.13.

## Folder layout

storelingo reads and writes the standard fastlane trees (paths can be changed in `paths`):

```
fastlane/metadata/android/          # Google Play (fastlane supply)
  en-US/
    title.txt
    short_description.txt
    full_description.txt
    video.txt                       # not translated
    changelogs/<versionCode>.txt
  ru-RU/ ...

fastlane/metadata/                  # App Store (fastlane deliver)
  en-US/
    name.txt
    subtitle.txt
    description.txt
    keywords.txt
    promotional_text.txt
    release_notes.txt
    marketing_url.txt               # urls are not translated
    support_url.txt
    privacy_url.txt
  ru/ ...
```

The `android`, `default`, `review_information` and `trade_representative_contact_information` folders inside `fastlane/metadata` are not treated as App Store locales. Files are written as UTF-8 without BOM with `\n` line endings (line breaks in the model's reply are normalized before writing); the source's trailing newline is preserved.

The metadata paths and `storelingo.lock.json` are resolved against the current directory, so run storelingo from the project root. `paths.play` and `paths.appstore` must stay inside the project: absolute paths and `..` escapes are rejected with a config error (exit code 2). storelingo also refuses to follow symbolic links in the metadata folders and for the lock file (exit code 2), because the config and these files can come from someone else's repository.

For Google Play, the newest changelog (highest version code) of the source locale is the one that gets translated.

## Config reference

`storelingo.config.json` in the project root:

```json
{
  "sourceLocale": "en-US",
  "targetLocales": ["ru", "de", "tr", "ar", "uz"],
  "stores": {
    "play": { "packageName": "com.example.app" },
    "appstore": { "appId": "1234567890" }
  },
  "translator": {
    "provider": "anthropic",
    "model": "claude-opus-5-5",
    "effort": "medium",
    "concurrency": 4
  },
  "context": "Prayer times and Quran app for Muslims in Central Asia.",
  "glossary": {
    "doNotTranslate": ["Quran Widgets"],
    "terms": { "ru": { "prayer": "намаз" } }
  },
  "paths": {}
}
```

| Key | Required | Description |
|---|---|---|
| `sourceLocale` | yes | storelingo locale code of your source texts, e.g. `en-US`. |
| `targetLocales` | yes | Non-empty list of storelingo locale codes to translate into, without duplicates. |
| `stores.play.packageName` | one store required | Enables Google Play. |
| `stores.appstore.appId` | one store required | Enables the App Store. |
| `translator.provider` | yes | `anthropic` or `openai-compatible`. |
| `translator.model` | `anthropic`: no (default `claude-opus-5-5`); `openai-compatible`: yes | Model name. |
| `translator.effort` | no, `anthropic` only | `low`, `medium` (default), `high`, `xhigh` or `max`. |
| `translator.baseUrl` | `openai-compatible` only | API base URL. Must be `https://` unless it points to `localhost`, `127.0.0.1` or `[::1]`. |
| `translator.concurrency` | no (default `4`) | Locales translated in parallel, 1 to 16. |
| `context` | no | Short description of your app; added to every prompt. |
| `glossary.doNotTranslate` | no | Terms kept exactly as written (brand names). |
| `glossary.terms` | no | Preferred translations per target locale: `{ "<locale>": { "<source term>": "<translation>" } }`. |
| `paths.play` | no | Play metadata root (default `fastlane/metadata/android`). A relative path inside the project. |
| `paths.appstore` | no | App Store metadata root (default `fastlane/metadata`). A relative path inside the project. |

Unknown keys are rejected, so a typo such as `glossary.doNotTranslte` is reported instead of silently ignored.

### Translators and API keys

Keys come only from environment variables. They are never written to the config, the lock file or the logs.

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Claude (`provider: "anthropic"`). |
| `OPENAI_API_KEY` | OpenAI-compatible, **only** when the `baseUrl` host is `api.openai.com`. |
| `STORELINGO_TRANSLATOR_API_KEY` | Any other OpenAI-compatible host (OpenRouter, Gemini endpoint, ...). |
| `STORELINGO_TRANSLATOR_API_HOST` | The host the OpenAI-compatible provider may talk to. Required for every non-local host other than `api.openai.com`, even without a key; the only host that receives `STORELINGO_TRANSLATOR_API_KEY`. |
| `STORELINGO_PLAY_SERVICE_ACCOUNT` | Google Play `pull` / `push`: the path to the service account JSON key, or the JSON itself. See [Google Play](#google-play). |

Rules for `openai-compatible`:

- `api.openai.com`: uses `OPENAI_API_KEY`; no other variable is needed.
- Any other non-local host: `STORELINGO_TRANSLATOR_API_HOST` must equal the hostname of `baseUrl`, **even if no key is set**; otherwise storelingo stops with a config error (exit code 2) and sends nothing. `STORELINGO_TRANSLATOR_API_KEY`, if set, is sent only to that host.
- Local servers (`localhost`, `127.0.0.1`, `[::1]`, e.g. Ollama): no variable is needed. A `STORELINGO_TRANSLATOR_API_KEY` is sent to a local server only if `STORELINGO_TRANSLATOR_API_HOST` names it; if the key is set and the host does not match, storelingo stops with a config error.
- `baseUrl` must be `https://`; plain `http://` is allowed only for `localhost`, `127.0.0.1` and `[::1]`. Other schemes (`file:`, `data:`, ...) are rejected.

Why: a `storelingo.config.json` can come from someone else's repository. Without these rules, a malicious config could set `baseUrl` to its own server and collect whatever API key is in your environment, or your unreleased listing texts. Requests and keys can only travel to the host you explicitly allowed.

OpenRouter:

```json
{
  "translator": {
    "provider": "openai-compatible",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "anthropic/claude-sonnet-5-5"
  }
}
```

```bash
export STORELINGO_TRANSLATOR_API_KEY=sk-or-...
export STORELINGO_TRANSLATOR_API_HOST=openrouter.ai
npx storelingo translate
```

Local Ollama (no key):

```json
{
  "translator": {
    "provider": "openai-compatible",
    "baseUrl": "http://localhost:11434/v1",
    "model": "qwen3:32b"
  }
}
```

## Commands

```
storelingo [--config <path>] [--verbose] [--no-color] <command>
```

| Command | What it does |
|---|---|
| `init [--force]` | Interactive setup: creates `storelingo.config.json` and the fastlane folders. `--force` overwrites an existing config. |
| `translate [--locale <code...>] [--force]` | Translates changed fields into the target locales. `--locale` limits the run to some of `targetLocales`. `--force` re-translates everything, including files you edited manually. |
| `check` | Offline validation: character limits, missing required fields, keyword format. Makes no API calls. |
| `pull [--store <store>] [--force]` | Downloads the current store listings into the fastlane folders. Local files that differ from the store are kept unless you pass `--force`. Never changes the store. |
| `push [--store <store>] [--dry-run] [--yes]` | Runs `check`, shows the diff with the live listing and uploads after confirmation. `--dry-run` only shows the diff. Outside a terminal it needs `--yes` or `--dry-run`. |

`--store` accepts only `play` in v0.2 (the default). `--store appstore` stops with exit code 2 ("arrives in v0.3"). If `stores.play` is not configured, `pull` and `push` stop with a config error.

Global flags: `--config <path>` (default `storelingo.config.json`), `--verbose` (debug output), `--no-color`, `--version`, `--help`.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | `check` found errors, some translations failed, `push` was blocked by `check` errors or by a listing problem, or a runtime error (for example the source locale is not supported by a configured store, a file could not be read or written, Google Play denied access (`E_AUTH_PLAY`), changes are already in review (`E_IN_REVIEW`) or the Play API failed (`E_STORE`)). |
| `2` | Bad usage or config: invalid flag, `--locale` outside `targetLocales`, missing or invalid config, `paths` outside the project, a symbolic link in the metadata folders or at the lock file, a corrupt lock file, missing API key or a `baseUrl` host not allowed by `STORELINGO_TRANSLATOR_API_HOST`, a missing or invalid `STORELINGO_PLAY_SERVICE_ACCOUNT`, a Google Play 404 ("app not found or not accessible"), `stores.play` not configured, `--store appstore`, or `push` without `--yes` outside a terminal. |

## Google Play

`pull` and `push` use the Google Play Android Publisher API with a service account. Follow the [Google Play setup guide](https://github.com/Alisher23/storelingo/blob/main/docs/google-play-setup.md) once (Google Cloud project, service account key, access in Play Console), then:

```bash
export STORELINGO_PLAY_SERVICE_ACCOUNT=/path/to/play-service-account.json
npx storelingo pull
npx storelingo translate
npx storelingo check
npx storelingo push --dry-run
npx storelingo push
```

How it behaves:

- `push` validates the config, `--store` and the terminal rule (outside a terminal it needs `--yes` or `--dry-run`) before any network request. It then runs `check` and stops on errors (exit code 1).
- One Play edit per push: all changed listings are uploaded and committed together. The commit uses `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, so changes that are already in review are never cancelled; if there are any, `push` stops with `E_IN_REVIEW` (exit code 1) and changes nothing.
- If the final commit request gets no clear answer (a network error, a timeout, or an HTTP 429/5xx response), storelingo reports "commit status is unknown". Check Play Console, or run `push --dry-run` to see whether the listing already matches your files.
- Google reviews listing changes before they go live.
- Changelogs (release notes) are not uploaded yet; use `fastlane supply` for them.
- Languages that exist only in Google Play are never deleted. A new language needs `title`, `short_description` and `full_description`.
- `pull` never commits anything and never touches `storelingo.lock.json`. Pulled translations have no lock entry, so `translate` treats them as manual edits and skips them; re-translate them with `translate --force` (optionally with `--locale`).
- The service account key is read only from `STORELINGO_PLAY_SERVICE_ACCOUNT` (a path or the JSON itself). Tokens are requested from Google's fixed token endpoint; the `token_uri` inside the key file is ignored.

## How translation works

1. For every store and target locale, storelingo decides per field: skip if the source is empty or missing; translate if the target file is missing or empty (whitespace only); skip if you edited the translated file by hand; skip if the source has not changed since the last run; otherwise translate.
2. One request per store and locale carries all selected fields, together with your `context`, `doNotTranslate` list, the locale's `terms` and each field's character limit. The prompt asks for localized, idiomatic text and preserves line breaks and bullet lists.
3. The JSON reply is validated; an invalid reply is retried once.
4. A field over its limit is sent back for shortening, at most 2 times. If it still exceeds the limit, nothing is written for that field and it is reported as an error.
5. App Store `keywords` are normalized in code after the reply: trimmed, comma-separated without spaces, deduplicated, words from the name and subtitle removed (the newly translated ones, or the locale's current `name.txt` / `subtitle.txt` when those are not re-translated in this run).
6. Translations are written to the fastlane folders. `storelingo.lock.json` stores hashes of each source and written output. A target file whose hash no longer matches the lock was edited by you and is skipped, unless you pass `--force`. The lock is written atomically after each field; commit it to git.
7. The run continues past a single failure. At the end storelingo prints a summary (translated, unchanged, edited manually, unsupported, failed, tokens) and exits with code 1 if anything failed. Fields that succeeded are already saved.

## Locale codes

storelingo uses its own locale codes in `sourceLocale` and `targetLocales` (for example `ru`, `de`, `es-419`, `zh-Hans`) and maps them to each store's code: `ru` is `ru-RU` on Google Play and `ru` on the App Store, `es-419` is `es-MX` on the App Store, `zh-Hans` is `zh-CN` on Google Play. The fastlane folders use the store codes.

Some languages exist on only one store. For example `ky` (Kyrgyz), `kk` (Kazakh) and `uz` (Uzbek) are Google Play only. If a store does not support a target locale, that locale is skipped for that store with a warning and counted as "unsupported" in the summary; the other store is still translated. The source locale must be supported by every configured store.

## Cost

The default model is `claude-opus-5-5` with `effort: "medium"`. For cheaper runs set `"model": "claude-sonnet-5-5"` or `"claude-haiku-5-5"` in the `translator` block. Only changed fields are sent, so repeat runs are small. Input and output token totals are printed after each run, so you can estimate the cost with your provider's price list.

## Supported languages

Generated from `src/locales/table.ts`. "—" means the store does not support that language.

| Code | Language | Google Play | App Store |
|---|---|---|---|
| `ar` | Arabic | `ar` | `ar-SA` |
| `az` | Azerbaijani | `az-AZ` | — |
| `ca` | Catalan | `ca` | `ca` |
| `cs` | Czech | `cs-CZ` | `cs` |
| `da` | Danish | `da-DK` | `da` |
| `de` | German | `de-DE` | `de-DE` |
| `el` | Greek | `el-GR` | `el` |
| `en-AU` | English (Australia) | `en-AU` | `en-AU` |
| `en-CA` | English (Canada) | `en-CA` | `en-CA` |
| `en-GB` | English (United Kingdom) | `en-GB` | `en-GB` |
| `en-US` | English (United States) | `en-US` | `en-US` |
| `es-ES` | Spanish (Spain) | `es-ES` | `es-ES` |
| `es-419` | Spanish (Latin America) | `es-419` | `es-MX` |
| `fa` | Persian | `fa` | — |
| `fi` | Finnish | `fi-FI` | `fi` |
| `fr-CA` | French (Canada) | `fr-CA` | `fr-CA` |
| `fr-FR` | French (France) | `fr-FR` | `fr-FR` |
| `he` | Hebrew | `iw-IL` | `he` |
| `hi` | Hindi | `hi-IN` | `hi` |
| `hr` | Croatian | `hr` | `hr` |
| `hu` | Hungarian | `hu-HU` | `hu` |
| `id` | Indonesian | `id` | `id` |
| `it` | Italian | `it-IT` | `it` |
| `ja` | Japanese | `ja-JP` | `ja` |
| `kk` | Kazakh | `kk` | — |
| `ko` | Korean | `ko-KR` | `ko` |
| `ky` | Kyrgyz | `ky-KG` | — |
| `ms` | Malay | `ms` | `ms` |
| `nl` | Dutch | `nl-NL` | `nl-NL` |
| `no` | Norwegian | `no-NO` | `no` |
| `pl` | Polish | `pl-PL` | `pl` |
| `pt-BR` | Portuguese (Brazil) | `pt-BR` | `pt-BR` |
| `pt-PT` | Portuguese (Portugal) | `pt-PT` | `pt-PT` |
| `ro` | Romanian | `ro` | `ro` |
| `ru` | Russian | `ru-RU` | `ru` |
| `sk` | Slovak | `sk` | `sk` |
| `sv` | Swedish | `sv-SE` | `sv` |
| `th` | Thai | `th` | `th` |
| `tr` | Turkish | `tr-TR` | `tr` |
| `uk` | Ukrainian | `uk` | `uk` |
| `uz` | Uzbek | `uz` | — |
| `vi` | Vietnamese | `vi` | `vi` |
| `zh-Hans` | Chinese (Simplified) | `zh-CN` | `zh-Hans` |
| `zh-Hant` | Chinese (Traditional) | `zh-TW` | `zh-Hant` |

## Roadmap

- v0.2 (done): Google Play `pull` / `push`
- Next, v0.3: App Store `pull` / `push`
- v1.0: GitHub Action
- Later: screenshots, RuStore, Huawei AppGallery

## Contributing

See [CONTRIBUTING.md](https://github.com/Alisher23/storelingo/blob/main/CONTRIBUTING.md). To add a language or fix a character limit you usually only need to edit one data file. Repository: https://github.com/Alisher23/storelingo

## License

MIT
