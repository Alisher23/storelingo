# Google Play setup

How to let storelingo read (`pull`) and update (`push`) your Google Play store listings. You need to do this once per Google Play developer account.

[Русская версия](google-play-setup.ru.md)

storelingo talks to the Google Play Android Publisher API as a **service account**: a robot account with its own JSON key. The key never goes into the config file; storelingo reads it only from an environment variable.

## 1. Google Cloud project and API

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project, or pick an existing one. Any project works; it does not have to be linked to your app.
2. In that project, enable the **Google Play Android Developer API** (search for it in the API library).

## 2. Service account and JSON key

1. In the same project, create a **service account** (IAM and Admin, Service accounts). It does not need any Google Cloud role.
2. Open the service account, create a new key of type **JSON** and download it.
3. Keep the file out of git. `storelingo init` already adds `play-service-account*.json` to `.gitignore`, so a file named like `play-service-account.json` is ignored. Do not commit it, paste it into chats or store it in the repository.

Note the service account's e-mail address (it looks like `name@project-id.iam.gserviceaccount.com`); you need it in the next step.

## 3. Give the service account access in Play Console

1. Open Play Console and go to the **Users and permissions** section.
2. Invite the service account e-mail as a new user.
3. Give it access to your app, with the permission to edit the store listing. Grant only what is needed for the app you localize.
4. Save. Permissions can take a while to take effect (sometimes hours). If the first run fails with `E_AUTH_PLAY`, wait and try again.

The menu names in Play Console change from time to time; if you do not see these exact labels, look for the user management and app permissions pages.

## 4. Tell storelingo where the key is

`STORELINGO_PLAY_SERVICE_ACCOUNT` holds the path to the JSON key file, or the JSON itself (useful in CI secrets).

macOS / Linux:

```bash
export STORELINGO_PLAY_SERVICE_ACCOUNT=/path/to/play-service-account.json
```

Windows PowerShell:

```powershell
$env:STORELINGO_PLAY_SERVICE_ACCOUNT = "C:\path\play-service-account.json"
```

The package name goes into `storelingo.config.json` (`init` asks for it):

```json
{ "stores": { "play": { "packageName": "com.example.app" } } }
```

## 5. First run

```bash
npx storelingo pull            # download the current listings into fastlane/metadata/android
npx storelingo translate       # translate changed source fields
npx storelingo check           # offline validation of limits and required fields
npx storelingo push --dry-run  # show the diff with the live listing, change nothing
npx storelingo push            # show the diff, ask, then upload
```

Things to know:

- `pull` only writes files. It never changes the store and never touches `storelingo.lock.json`. It keeps local files that differ from the store unless you pass `--force`.
- Translations you pulled have no entry in `storelingo.lock.json`, so `translate` treats them as manual edits and skips them. To re-translate them, run `translate --force` (add `--locale <code>` to limit it to some locales).
- `push` runs `check` first and stops on errors (exit code 1). It makes one Google Play edit per push and commits it with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, so changes that are already in review are never cancelled.
- Outside an interactive terminal (CI, pipes) `push` needs `--yes` or `--dry-run`; this is checked before any network request.
- Google reviews listing changes before they go live.
- Changelogs (release notes) are not uploaded yet; use `fastlane supply` for them.
- Languages that exist only in Google Play are never deleted. A new language needs `title`, `short_description` and `full_description`.

## Troubleshooting

| Error | Likely cause | What to do |
|---|---|---|
| `E_AUTH_PLAY` | Google rejected the key, or the service account has no access to the app. Typical causes: the Google Play Android Developer API is not enabled in the key's Google Cloud project; the service account was not invited in Play Console or lacks permission to edit the store listing; the invitation was just made and has not taken effect yet. | Check the three steps above, wait a while after changing permissions, then retry. |
| `E_CONFIG` ("app not found or not accessible", or a message about `STORELINGO_PLAY_SERVICE_ACCOUNT`) | `stores.play.packageName` is wrong or the app is not visible to the service account; or the environment variable is not set, or the path/JSON is invalid. | Check the package name and the app access of the service account; check the variable and that the file is readable. |
| `E_IN_REVIEW` | Changes for this app are already in review in Play Console. storelingo never cancels them and changed nothing. | Wait for the review to finish, or send or discard the pending changes in Play Console, then push again. |
| `E_STORE` | Other Google Play API error (HTTP error, unexpected response, network failure after retries). | Read the message. If it says "commit status is unknown", the final request got no clear answer (network error, timeout, or HTTP 429/5xx): check Play Console, or run `push --dry-run` to see whether the listing already matches your files. |

Exit codes: `0` success; `1` runtime error, `check` errors or a blocked push; `2` bad usage or config (for example `E_CONFIG`, or `push` without `--yes` outside a terminal).
