# GitHub Action

Run storelingo in CI: translate your store listings when the source texts change, and fail pull requests whose listings break store limits.

[Русская версия](github-action.ru.md)

Until a release tag exists, use `Alisher23/storelingo@main`. After the first release, pin a tag or a full commit SHA instead of a branch.

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
jobs:
  storelingo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Alisher23/storelingo@main
        with:
          command: translate-and-check
          commit: "true"
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action translates the changed fields, runs `check`, and, because `commit` is `"true"`, commits the changed files (fastlane metadata and `storelingo.lock.json` inside `working-directory`) as `github-actions[bot]` and pushes them to the current branch. `permissions: contents: write` is required for the push. The commit pushed with the default `GITHUB_TOKEN` does not start new workflow runs, so it cannot cause a loop.

Only storelingo output is committed: the metadata folders from `paths` (defaults `fastlane/metadata/android` for Google Play and `fastlane/metadata` for the App Store, only for configured stores) and `storelingo.lock.json`. Nothing is committed or pushed if `translate` or `check` failed. `commit: "true"` is accepted only on `push` to a branch; on `pull_request`, `pull_request_target` or a tag the action stops with an error (for pull requests use `command: check`).

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
      - uses: Alisher23/storelingo@main
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
| `node-version` | `22` | Node.js version used to build and run storelingo. |

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
- **Pin the action.** A branch such as `main` can change; after the first release pin a tag or a full commit SHA.
- The action builds storelingo from source on every run (`npm ci` and `npm run build`), so a run takes a little longer than `npx`.
