# App Store setup

How to let storelingo read (`pull`) and update (`push`) your App Store listings. You need to do this once per App Store Connect team.

[Русская версия](app-store-setup.ru.md)

storelingo talks to the App Store Connect API with a **team API key**: a `.p8` private key plus two identifiers (Key ID and Issuer ID). The credentials (Key ID, Issuer ID and the key) come only from environment variables and are never written to the config file; only the app's Apple ID (`stores.appstore.appId`) lives in the config. Individual keys (without an Issuer ID) are not supported.

## 1. Create a team API key

1. Sign in to App Store Connect with an account that is allowed to manage API keys.
2. Open **Users and Access**, then **Integrations**, then **App Store Connect API**, and create a **team** key.
3. Give it the **App Manager** role. This is enough to edit localizations; do not use a broader role than you need.
4. Download the `.p8` file. **Apple lets you download it only once.** If you lose it, revoke the key and create a new one.
5. Note the **Key ID** (shown next to the key) and the **Issuer ID** (shown on the same page).

Keep the `.p8` out of git. `storelingo init` already adds `*.p8` to `.gitignore`. Do not commit the file, paste it into chats or store it in the repository.

The menu names in App Store Connect change from time to time; if you do not see these exact labels, look for the API keys page under user management.

## 2. Find the app's Apple ID

Open your app in App Store Connect and look at **App Information**: the numeric **Apple ID** (for example `1234567890`) is what storelingo needs. It is not the bundle ID.

## 3. Tell storelingo

Three environment variables:

| Variable | Value |
|---|---|
| `STORELINGO_ASC_ISSUER_ID` | The Issuer ID. |
| `STORELINGO_ASC_KEY_ID` | The Key ID. |
| `STORELINGO_ASC_PRIVATE_KEY` | The path to the `.p8` file, or the key contents themselves (useful in CI secrets). If you store the contents on one line, literal `\n` sequences are accepted as line breaks. |

macOS / Linux:

```bash
export STORELINGO_ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
export STORELINGO_ASC_KEY_ID=ABC123DEFG
export STORELINGO_ASC_PRIVATE_KEY=/path/to/AuthKey_ABC123DEFG.p8
```

Windows PowerShell:

```powershell
$env:STORELINGO_ASC_ISSUER_ID = "00000000-0000-0000-0000-000000000000"
$env:STORELINGO_ASC_KEY_ID = "ABC123DEFG"
$env:STORELINGO_ASC_PRIVATE_KEY = "C:\path\AuthKey_ABC123DEFG.p8"
```

The app goes into `storelingo.config.json` (`init` asks for the Apple ID):

```json
{ "stores": { "appstore": { "appId": "1234567890" } } }
```

`stores.appstore.platform` is optional: `IOS` (default), `MAC_OS`, `TV_OS` or `VISION_OS`. It selects which platform's version storelingo works with; one platform per config.

```json
{ "stores": { "appstore": { "appId": "1234567890", "platform": "MAC_OS" } } }
```

## 4. First run

```bash
npx storelingo pull --store appstore            # download the current listings into fastlane/metadata
npx storelingo translate                        # translate changed source fields
npx storelingo check                            # offline validation of limits and required fields
npx storelingo push --store appstore --dry-run  # show the diff, change nothing
npx storelingo push --store appstore            # show the diff, ask, then upload
```

Without `--store`, `pull` and `push` run every configured store, Google Play first and then the App Store, each with its own diff and its own confirmation. The credentials of every selected store are loaded first, before any store is touched, so a missing App Store key stops the run before Google Play is pushed. A failure (an API error, `E_NO_EDITABLE_VERSION`) stops the run. A blocked push (`check` errors or listing problems) is reported and the run continues with the next store; the exit code is then 1.

Things to know:

- `pull` only writes files. It never changes the store and never touches `storelingo.lock.json`. It keeps local files that differ from the store unless you pass `--force`. Translations you pulled have no lock entry, so `translate` skips them as manual edits; use `translate --force` to re-translate them.
- `push` runs `check` first and stops on errors (exit code 1). Outside an interactive terminal it needs `--yes` or `--dry-run`.
- storelingo never submits anything for review, never deletes a language and never touches prices, builds, screenshots or categories.

## How editable and live versions work

App Store Connect keeps the text of a version that is being prepared separately from the text of the version that is live. storelingo picks the resources like this:

- **Editable version**: a version of your platform in the state `PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED`, `REJECTED` or `METADATA_REJECTED`.
- **Editable app info**: an app info in the state `PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED` or `REJECTED`.
- **Live**: the version or app info in the state `READY_FOR_DISTRIBUTION`.

`pull` reads from the editable resources when they exist, otherwise from the live ones.

`push` routes every field to the one resource that can take it:

| Field (file) | Goes to |
|---|---|
| `name`, `subtitle`, `privacy_url` | the editable app info only |
| `description`, `keywords`, `release_notes`, `marketing_url`, `support_url` | the editable version only |
| `promotional_text` | the editable version; if there is none, the live version |

So **without a new version only the promotional text can change**, and it goes live right away on the live version. Everything else needs a version in an editable state; create one in App Store Connect first. Changes to an editable version go live together with that version, when you submit it.

A field that has no resource to go to is never sent. It is shown in the diff as a skipped line instead, for example:

```
ru/description: skipped (no editable version in App Store Connect)
```

The reason depends on the field: "no editable version in App Store Connect" for version fields, "no editable app info in App Store Connect" for name, subtitle and privacy URL, and "Apple shows release notes only for updates" for release notes on the **first version of an app** (they are not sent; the note "First version of the app: release notes are not sent (Apple shows them only for updates)." is printed at the start). `push` also prints a note at the start when something is missing, for example "No editable App Store version: only promotional text can be updated. Create a new version in App Store Connect to change the rest." (with no version at all: "No App Store version yet: version texts can't be updated until a version exists."). If skipped lines are the only changes, `push` prints them and stops with `E_NO_EDITABLE_VERSION` (exit code 1); this also holds for `push --dry-run`, so a dry run can exit 1. If several versions (or app infos) are editable, storelingo uses the one in `PREPARE_FOR_SUBMISSION`; if that is still ambiguous it stops with `E_STORE` "Several editable App Store versions found; finish or remove the extra one in App Store Connect". If some changes can go through, they are pushed, and the final message says some changes were skipped.

A **new language** needs `name`, `description` and `keywords` locally, and both an editable app info and an editable version. Otherwise `push` reports it as a problem and sends nothing.

## Push is not atomic

The App Store Connect API has no transaction. `push` computes the diff first and then applies it one language at a time (each language needs one or two requests). If a request fails in the middle, languages already applied stay applied, and the language whose request failed may be partly applied (for example the app info was updated but the version was not). Only the changed fields are sent. The error message then lists three groups:

```
... — already applied: ru, de; failed (may be partly applied): tr; not attempted: fr
```

("none" is printed for an empty group.) This message appears for every failure of an App Store update, including one on the first language. The original error code is kept. The hint is "Re-run `storelingo push`: it only sends what still differs." Re-running is safe either way: storelingo reads the store again and sends only what still differs.

Requests that create a new localization are never retried. If such a request gets no clear answer (network error, timeout, HTTP 5xx), storelingo reports `E_STORE` "App Store Connect create request status is unknown"; run `storelingo push --dry-run` to see whether the localization was created. A 429 on such a request means nothing was created: you get `E_STORE` "App Store Connect rate limit (429): nothing was created; try again in a minute".

## Troubleshooting

| Error | Likely cause | What to do |
|---|---|---|
| `E_AUTH_ASC`, "rejected the API key (401)" | Wrong Issuer ID or Key ID, a wrong or damaged `.p8`, or the key was revoked. | Check `STORELINGO_ASC_ISSUER_ID`, `STORELINGO_ASC_KEY_ID` and the key file; create a new key if needed. |
| `E_AUTH_ASC`, "denied access (403)" | The key's role is too low, or it is not a team key. | Use a team key with the App Manager role (or Admin). |
| `E_CONFIG`, a message about `STORELINGO_ASC_*` or the `.p8` | A variable is not set, the `.p8` path is not readable, or the value is not a `.p8` private key. | Check the three variables and that the file exists. |
| `E_CONFIG`, "App Store app ... not found or not accessible" | `stores.appstore.appId` is wrong, or the key's team does not have the app. | Check the numeric Apple ID in App Information and that the key belongs to the right team. |
| `E_NO_EDITABLE_VERSION` | Every change needs an editable version and there is none. | Create a new version in App Store Connect, then push again. |
| `E_STORE`, "status is unknown" | A create request got no clear answer and was not retried. | Run `push --dry-run` to see whether the localization already exists, then push again if needed. |
| `E_STORE`, "refused the change (409)" | A state conflict, typically the version or app info is no longer editable (for example it was submitted for review while you were pushing). | Check the version in App Store Connect and re-run `push`; it only sends what still differs. |
| `E_STORE`, other API error | Apple returned another error, or the network failed after retries. | Read the message; retry later. |

Exit codes: `0` success; `1` runtime error, `check` errors or a blocked push (including `E_AUTH_ASC`, `E_NO_EDITABLE_VERSION` and `E_STORE`); `2` bad usage or config (including `E_CONFIG`, or `push` without `--yes` outside a terminal).
