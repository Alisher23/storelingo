# GitHub Action

Run storelingo in CI: translate your store listings when the source texts change, and fail pull requests whose listings break store limits.

[Русская версия](github-action.ru.md)

Pin a release tag such as `Alisher23/storelingo@v0.4.0` (or a full commit SHA for maximum safety). `@main` follows the latest unreleased code.

## Quick start: translate on push to main

Create `.github/workflows/storelingo.yml`:

```yaml
name: Localize store listings
on:
  push:
    branches: [main]
    paths:
      - "fastlane/metadata/android/en-US/**"
      - "fastlane/metadata/en-US/**"
permissions:
  contents: write
concurrency:
  group: storelingo-${{ github.ref }}
  cancel-in-progress: false
jobs:
  storelingo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Alisher23/storelingo@v0.4.0
        with:
          command: translate-and-check
          commit: "true"
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action translates the changed fields, runs `check`, and, because `commit` is `"true"`, commits the changed files (fastlane metadata and `storelingo.lock.json` inside `working-directory`) as `github-actions[bot]` and pushes them to the current branch. The commit pushed with the default `GITHUB_TOKEN` does not start new workflow runs, so it cannot cause a loop.

Requirements for `commit: "true"`:

- `permissions: contents: write` on the job.
- `actions/checkout` with its default persisted credentials (do not set `persist-credentials: false`), because the action pushes with the credentials checkout stored.
- Branch protection can reject the push (for example when pull requests or status checks are required on the branch). Push to an unprotected branch or allow `github-actions[bot]` to bypass.
- Add a `concurrency:` group (as in the example) so that two runs do not push at the same time.

Only storelingo output is committed: the metadata folders from `paths` (defaults `fastlane/metadata/android` for Google Play and `fastlane/metadata` for the App Store, only for configured stores) and `storelingo.lock.json`. Nothing is committed or pushed if the build, `translate` or `check` failed or the run was cancelled. `commit: "true"` is accepted only on the `push`, `workflow_dispatch` and `schedule` events, and only on a branch; for any other event (such as `pull_request` or `pull_request_target`) or on a tag the action stops with an error before it builds or translates anything (for pull requests use `command: check`).

The action never pushes unless `commit` is `"true"`. With `commit: "false"` (the default) the files are only changed in the runner's workspace.

## Pull request check (no secrets)

`check` is offline: it validates character limits, required fields and keyword format and makes no API calls, so it needs no secrets and works for pull requests from forks.

```yaml
name: Check store listings
on:
  pull_request:
permissions:
  contents: read
jobs:
  storelingo-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Alisher23/storelingo@v0.4.0
        with:
          command: check
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `command` | `translate-and-check` | `translate`, `check` or `translate-and-check`. Any other value fails the job. |
| `working-directory` | `.` | Directory with `storelingo.config.json`. |
| `args` | empty | Extra arguments for `translate`, split on whitespace (for example `--locale ru --force`). Quotes are not honored, so an argument cannot contain spaces. |
| `commit` | `"false"` | `"true"` commits and pushes the changed files. |
| `commit-message` | `chore: update store listing translations (storelingo)` | Commit message. |
| `anthropic-api-key` | empty | Anthropic API key (`ANTHROPIC_API_KEY`). Pass a secret. |
| `openai-api-key` | empty | OpenAI API key (`OPENAI_API_KEY`), for `api.openai.com` only. Pass a secret. |
| `translator-api-key` | empty | Key for another OpenAI-compatible host (`STORELINGO_TRANSLATOR_API_KEY`). Pass a secret. |
| `translator-api-host` | empty | Host allowed to receive requests (`STORELINGO_TRANSLATOR_API_HOST`). |
| `node-version` | `22` | Node.js version used to build and run storelingo. Must be 22.13 or newer. The action's `setup-node` step changes the Node version for the later steps of the same job. |

## Outputs

| Output | Description |
|---|---|
| `changed` | `"true"` when the commit step found changed files and committed them, otherwise `"false"` (always `"false"` when `commit` is not `"true"`). |

## Secrets setup

1. Open the repository, then Settings, Secrets and variables, Actions.
2. Create a repository secret named `ANTHROPIC_API_KEY` with your key.
3. Pass it to the action as `anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}`.

Key inputs are masked in the log. For OpenRouter or another OpenAI-compatible provider use `translator-api-key` together with `translator-api-host`, and set `translator` in `storelingo.config.json` as described in the [README](https://github.com/Alisher23/storelingo#translators-and-api-keys).

## Limitations and security

- **Pull requests from forks have no secrets.** GitHub does not pass repository secrets to workflows triggered by fork PRs, so `translate` fails there. Use `command: check` for pull requests, and run `translate` only on `push` to your own branches.
- **Do not use `pull_request_target` and check out the pull request code.** `pull_request_target` runs with secrets and write access; combined with a checkout of untrusted PR code, a malicious `storelingo.config.json` or workflow change could read your secrets. Keep translation workflows on `push` or `pull_request` for trusted branches.
- **Pin the action.** A branch such as `main` can change; pin a release tag (for example `v0.4.0`) or a full commit SHA.
- The action builds storelingo from source on every run (`npm ci` and `npm run build`), so a run takes a little longer than `npx`.
