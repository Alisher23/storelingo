# GitHub Action

Запускайте storelingo в CI: переводите карточки магазинов, когда меняются исходные тексты, и проваливайте pull request'ы, в которых карточки нарушают лимиты магазинов.

[English version](github-action.md)

Пока нет релизного тега, используйте `Alisher23/storelingo@main`. После первого релиза закрепляйте тег или полный SHA коммита вместо ветки.

## Быстрый старт: перевод при push в main

Создайте `.github/workflows/storelingo.yml`:

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
      - uses: Alisher23/storelingo@main
        with:
          command: translate-and-check
          commit: "true"
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Action переводит изменившиеся поля, запускает `check` и, так как `commit` равен `"true"`, коммитит изменённые файлы (метаданные fastlane и `storelingo.lock.json` внутри `working-directory`) от имени `github-actions[bot]` и пушит их в текущую ветку. Коммит, отправленный через стандартный `GITHUB_TOKEN`, не запускает новые workflow, поэтому цикла не будет.

Требования для `commit: "true"`:

- `permissions: contents: write` у job.
- `actions/checkout` со стандартными сохраняемыми учётными данными (не задавайте `persist-credentials: false`), потому что action пушит с учётными данными, сохранёнными checkout.
- Защита ветки может отклонить push (например, если для ветки обязательны pull request'ы или проверки статуса). Пушьте в незащищённую ветку или разрешите `github-actions[bot]` обходить защиту.
- Добавьте группу `concurrency:` (как в примере), чтобы два запуска не пушили одновременно.

Коммитится только результат storelingo: папки метаданных из `paths` (по умолчанию `fastlane/metadata/android` для Google Play и `fastlane/metadata` для App Store, только для настроенных магазинов) и `storelingo.lock.json`. Если сборка, `translate` или `check` упали либо запуск отменён, ничего не коммитится и не пушится. `commit: "true"` допускается только для событий `push`, `workflow_dispatch` и `schedule` и только в ветке; для любого другого события (например `pull_request` или `pull_request_target`) или тега action останавливается с ошибкой до сборки и перевода (для pull request'ов используйте `command: check`).

Action никогда не пушит, если `commit` не равен `"true"`. При `commit: "false"` (по умолчанию) файлы меняются только в рабочей папке раннера.

## Проверка pull request'а (без секретов)

`check` работает офлайн: проверяет лимиты символов, обязательные поля и формат ключевых слов и не обращается к API, поэтому секреты не нужны и он работает для pull request'ов из форков.

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

## Входные параметры

| Параметр | По умолчанию | Описание |
|---|---|---|
| `command` | `translate-and-check` | `translate`, `check` или `translate-and-check`. Любое другое значение проваливает job. |
| `working-directory` | `.` | Папка с `storelingo.config.json`. |
| `args` | пусто | Дополнительные аргументы для `translate`, разбиваются по пробелам (например `--locale ru --force`). Кавычки не учитываются, поэтому аргумент не может содержать пробелы. |
| `commit` | `"false"` | `"true"` коммитит и пушит изменённые файлы. |
| `commit-message` | `chore: update store listing translations (storelingo)` | Сообщение коммита. |
| `anthropic-api-key` | пусто | Ключ Anthropic (`ANTHROPIC_API_KEY`). Передавайте секрет. |
| `openai-api-key` | пусто | Ключ OpenAI (`OPENAI_API_KEY`), только для `api.openai.com`. Передавайте секрет. |
| `translator-api-key` | пусто | Ключ для другого OpenAI-совместимого хоста (`STORELINGO_TRANSLATOR_API_KEY`). Передавайте секрет. |
| `translator-api-host` | пусто | Хост, которому разрешено получать запросы (`STORELINGO_TRANSLATOR_API_HOST`). |
| `node-version` | `22` | Версия Node.js для сборки и запуска storelingo. Должна быть 22.13 или новее. Шаг `setup-node` внутри action меняет версию Node для последующих шагов того же job. |

## Выходные параметры

| Параметр | Описание |
|---|---|
| `changed` | `"true"`, если шаг коммита нашёл изменённые файлы и закоммитил их, иначе `"false"` (всегда `"false"`, если `commit` не равен `"true"`). |

## Настройка секретов

1. Откройте репозиторий, затем Settings, Secrets and variables, Actions.
2. Создайте секрет репозитория `ANTHROPIC_API_KEY` со своим ключом.
3. Передайте его в action: `anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}`.

Ключи из входных параметров маскируются в логе. Для OpenRouter или другого OpenAI-совместимого провайдера используйте `translator-api-key` вместе с `translator-api-host` и настройте `translator` в `storelingo.config.json`, как описано в [README](https://github.com/Alisher23/storelingo/blob/main/README.ru.md#переводчики-и-api-ключи).

## Ограничения и безопасность

- **В pull request'ах из форков секретов нет.** GitHub не передаёт секреты репозитория в workflow, запущенные из форков, поэтому `translate` там упадёт. Для pull request'ов используйте `command: check`, а `translate` запускайте только при `push` в свои ветки.
- **Не используйте `pull_request_target` вместе с checkout кода из pull request'а.** `pull_request_target` работает с секретами и правом записи; в сочетании с checkout недоверенного кода вредоносный `storelingo.config.json` или правка workflow могут прочитать ваши секреты. Держите workflow с переводом на `push` или `pull_request` для доверенных веток.
- **Закрепляйте версию action.** Ветка вроде `main` может измениться; после первого релиза закрепите тег или полный SHA коммита.
- Action собирает storelingo из исходников при каждом запуске (`npm ci` и `npm run build`), поэтому запуск чуть дольше, чем через `npx`.
