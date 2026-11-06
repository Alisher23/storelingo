# storelingo

ИИ-локализация карточек Google Play и App Store. Работает с метаданными fastlane — сам fastlane не нужен.

> Статус: v0.1, в npm пока не опубликован. Команды ниже показывают планируемое использование (`npx storelingo`). До первого релиза собирайте из исходников (см. [CONTRIBUTING.md](CONTRIBUTING.md)).

[English version](README.md)

## Зачем

- **Лимиты магазинов соблюдаются.** У каждого поля есть лимит символов (считаются кодовые точки Unicode). Если перевод длиннее, storelingo просит модель сократить его, до 2 раз. Текст никогда не обрезается механически; если он всё равно не помещается, файл не пишется, а в отчёте будет ошибка.
- **Ключевые слова локализуются под поиск, а не переводятся дословно.** Ключевые слова App Store подбираются так, как ищут люди на целевом рынке, затем нормализуются (через запятую, без пробелов, без дублей, без слов из названия и подзаголовка).
- **Ручные правки защищены.** Если вы отредактировали переведённый файл руками, storelingo это заметит и пропустит его (перезаписать можно через `--force`).
- **Инкрементально.** Lock-файл помнит, что уже переведено, поэтому в модель уходят только изменившиеся поля.
- **Своя модель.** Claude (по умолчанию) или любой OpenAI-совместимый endpoint, включая локальный Ollama.

## Быстрый старт

```bash
npx storelingo init
export ANTHROPIC_API_KEY=sk-ant-...
npx storelingo translate
git diff
npx storelingo check
```

`init` задаёт несколько вопросов и создаёт `storelingo.config.json` и папки fastlane. Положите исходные тексты в эти папки и запустите `translate`. Проверьте результат через `git diff` и закоммитьте `storelingo.lock.json` вместе с переводами.

Требуется Node.js >= 22.13.

## Структура папок

storelingo читает и пишет стандартные деревья fastlane (пути меняются через `paths`):

```
fastlane/metadata/android/          # Google Play (fastlane supply)
  en-US/
    title.txt
    short_description.txt
    full_description.txt
    video.txt                       # не переводится
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
    marketing_url.txt               # ссылки не переводятся
    support_url.txt
    privacy_url.txt
  ru/ ...
```

Папки `android`, `default`, `review_information` и `trade_representative_contact_information` внутри `fastlane/metadata` не считаются локалями App Store. Файлы пишутся в UTF-8 без BOM с переводами строк `\n` (переводы строк в ответе модели нормализуются до записи); завершающий перевод строки берётся из исходника.

Пути к метаданным и `storelingo.lock.json` считаются от текущей папки, поэтому запускайте storelingo из корня проекта. `paths.play` и `paths.appstore` обязаны оставаться внутри проекта: абсолютные пути и выход через `..` отклоняются с ошибкой конфигурации (код выхода 2). storelingo также не следует по символическим ссылкам в папках метаданных и для lock-файла (код выхода 2), потому что конфиг и эти файлы могут прийти из чужого репозитория.

Для Google Play переводится самый свежий changelog (с наибольшим номером версии) исходной локали.

## Конфигурация

`storelingo.config.json` в корне проекта:

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

| Ключ | Обязателен | Описание |
|---|---|---|
| `sourceLocale` | да | Код локали storelingo для исходных текстов, например `en-US`. |
| `targetLocales` | да | Непустой список кодов локалей storelingo, на которые переводить, без повторов. |
| `stores.play.packageName` | нужен хотя бы один магазин | Включает Google Play. |
| `stores.appstore.appId` | нужен хотя бы один магазин | Включает App Store. |
| `translator.provider` | да | `anthropic` или `openai-compatible`. |
| `translator.model` | `anthropic`: нет (по умолчанию `claude-opus-5-5`); `openai-compatible`: да | Название модели. |
| `translator.effort` | нет, только `anthropic` | `low`, `medium` (по умолчанию), `high`, `xhigh` или `max`. |
| `translator.baseUrl` | только `openai-compatible` | Базовый URL API. Должен быть `https://`, кроме `localhost`, `127.0.0.1` и `[::1]`. |
| `translator.concurrency` | нет (по умолчанию `4`) | Сколько локалей переводить параллельно, от 1 до 16. |
| `context` | нет | Короткое описание приложения; добавляется в каждый запрос. |
| `glossary.doNotTranslate` | нет | Термины, которые остаются без изменений (названия брендов). |
| `glossary.terms` | нет | Предпочитаемые переводы по целевым локалям: `{ "<локаль>": { "<исходный термин>": "<перевод>" } }`. |
| `paths.play` | нет | Корень метаданных Play (по умолчанию `fastlane/metadata/android`). Относительный путь внутри проекта. |
| `paths.appstore` | нет | Корень метаданных App Store (по умолчанию `fastlane/metadata`). Относительный путь внутри проекта. |

Неизвестные ключи отклоняются, поэтому опечатка вроде `glossary.doNotTranslte` будет показана как ошибка, а не молча проигнорирована.

### Переводчики и API-ключи

Ключи берутся только из переменных окружения. Они никогда не попадают в конфиг, lock-файл и логи.

| Переменная | Для чего |
|---|---|
| `ANTHROPIC_API_KEY` | Claude (`provider: "anthropic"`). |
| `OPENAI_API_KEY` | OpenAI-совместимый провайдер, **только** если хост в `baseUrl` — `api.openai.com`. |
| `STORELINGO_TRANSLATOR_API_KEY` | Любой другой OpenAI-совместимый хост (OpenRouter, endpoint Gemini и т.д.). |
| `STORELINGO_TRANSLATOR_API_HOST` | Хост, к которому разрешено обращаться OpenAI-совместимому провайдеру. Обязателен для любого нелокального хоста, кроме `api.openai.com`, даже без ключа; единственный хост, который получает `STORELINGO_TRANSLATOR_API_KEY`. |

Правила для `openai-compatible`:

- `api.openai.com`: используется `OPENAI_API_KEY`; другие переменные не нужны.
- Любой другой нелокальный хост: `STORELINGO_TRANSLATOR_API_HOST` обязан совпадать с именем хоста из `baseUrl`, **даже если ключ не задан**; иначе storelingo остановится с ошибкой конфигурации (код выхода 2) и ничего не отправит. `STORELINGO_TRANSLATOR_API_KEY`, если задан, отправляется только на этот хост.
- Локальные серверы (`localhost`, `127.0.0.1`, `[::1]`, например Ollama): переменные не нужны. `STORELINGO_TRANSLATOR_API_KEY` отправляется на локальный сервер, только если `STORELINGO_TRANSLATOR_API_HOST` указывает на него; если ключ задан, а хост не совпадает, storelingo остановится с ошибкой конфигурации.
- `baseUrl` обязан быть `https://`; обычный `http://` разрешён только для `localhost`, `127.0.0.1` и `[::1]`. Другие схемы (`file:`, `data:` и т.п.) отклоняются.

Зачем это нужно: `storelingo.config.json` может прийти из чужого репозитория. Без таких правил вредоносный конфиг мог бы указать `baseUrl` на свой сервер и собрать любой API-ключ из вашего окружения или ещё не опубликованные тексты листинга. Запросы и ключи уходят только на тот хост, который вы явно разрешили.

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

Локальный Ollama (без ключа):

```json
{
  "translator": {
    "provider": "openai-compatible",
    "baseUrl": "http://localhost:11434/v1",
    "model": "qwen3:32b"
  }
}
```

## Команды

```
storelingo [--config <path>] [--verbose] [--no-color] <command>
```

| Команда | Что делает |
|---|---|
| `init [--force]` | Интерактивная настройка: создаёт `storelingo.config.json` и папки fastlane. `--force` перезаписывает существующий конфиг. |
| `translate [--locale <code...>] [--force]` | Переводит изменившиеся поля на целевые локали. `--locale` ограничивает запуск частью `targetLocales`. `--force` переводит всё заново, включая файлы, которые вы правили руками. |
| `check` | Офлайн-проверка: лимиты символов, отсутствующие обязательные поля, формат ключевых слов. API не вызывает. |

Глобальные флаги: `--config <path>` (по умолчанию `storelingo.config.json`), `--verbose` (отладочный вывод), `--no-color`, `--version`, `--help`.

Коды выхода:

| Код | Значение |
|---|---|
| `0` | Успех. |
| `1` | `check` нашёл ошибки, часть переводов не удалась или произошла ошибка во время работы (например, исходная локаль не поддерживается одним из магазинов или файл не удалось прочитать или записать). |
| `2` | Неверное использование или конфиг: неверный флаг, `--locale` вне `targetLocales`, нет или некорректный конфиг, `paths` за пределами проекта, символическая ссылка в папках метаданных или на месте lock-файла, повреждённый lock-файл, нет API-ключа или хост `baseUrl` не разрешён через `STORELINGO_TRANSLATOR_API_HOST`. |

## Как работает перевод

1. Для каждого магазина и целевой локали storelingo решает по каждому полю: пропустить, если исходник пуст или отсутствует; перевести, если целевой файл отсутствует или пуст (только пробелы); пропустить, если вы правили переведённый файл руками; пропустить, если исходник не изменился с прошлого запуска; иначе перевести.
2. Один запрос на магазин и локаль несёт все выбранные поля вместе с `context`, списком `doNotTranslate`, `terms` этой локали и лимитом каждого поля. В запросе просят естественный, идиоматичный текст и сохранение переносов строк и маркированных списков.
3. JSON-ответ проверяется; невалидный ответ повторяется один раз.
4. Поле длиннее лимита отправляется на сокращение, максимум 2 раза. Если оно всё ещё не помещается, для этого поля ничего не пишется, а в отчёте будет ошибка.
5. `keywords` App Store нормализуются кодом после ответа: trim, через запятую без пробелов, без дублей, без слов из названия и подзаголовка (только что переведённых или текущих `name.txt` / `subtitle.txt` локали, если они в этом запуске не переводятся).
6. Переводы записываются в папки fastlane. `storelingo.lock.json` хранит хэши исходника и записанного результата. Целевой файл, чей хэш не совпал с lock-файлом, считается отредактированным вами и пропускается, если не указан `--force`. Lock пишется атомарно после каждого поля; коммитьте его в git.
7. Запуск продолжается после отдельных сбоев. В конце storelingo печатает сводку (переведено, без изменений, правлено вручную, не поддерживается, ошибки, токены) и завершается с кодом 1, если что-то не удалось. Успешные поля уже сохранены.

## Коды локалей

В `sourceLocale` и `targetLocales` storelingo использует собственные коды локалей (например `ru`, `de`, `es-419`, `zh-Hans`) и сам сопоставляет их с кодами каждого магазина: `ru` — это `ru-RU` в Google Play и `ru` в App Store, `es-419` — `es-MX` в App Store, `zh-Hans` — `zh-CN` в Google Play. Папки fastlane используют коды магазинов.

Некоторые языки есть только в одном магазине. Например, `ky` (киргизский), `kk` (казахский) и `uz` (узбекский) есть только в Google Play. Если магазин не поддерживает целевую локаль, она пропускается для этого магазина с предупреждением и учитывается как «не поддерживается» в сводке; второй магазин переводится как обычно. Исходная локаль должна поддерживаться каждым настроенным магазином.

## Стоимость

Модель по умолчанию — `claude-opus-5-5` с `effort: "medium"`. Для более дешёвых запусков укажите в блоке `translator` `"model": "claude-sonnet-5-5"` или `"claude-haiku-5-5"`. Отправляются только изменившиеся поля, поэтому повторные запуски небольшие. После каждого запуска печатаются суммы входных и выходных токенов, по ним можно прикинуть стоимость по прайсу вашего провайдера.

## Поддерживаемые языки

Сгенерировано из `src/locales/table.ts`. «—» значит, что магазин этот язык не поддерживает.

| Код | Язык (English) | Google Play | App Store |
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

## Планы

- v0.2: Google Play `pull` / `push`
- v0.3: App Store `pull` / `push`
- v1.0: GitHub Action
- Позже: скриншоты, RuStore, Huawei AppGallery

## Участие в проекте

См. [CONTRIBUTING.md](CONTRIBUTING.md). Чтобы добавить язык или поправить лимит символов, обычно достаточно изменить один файл с данными. Репозиторий: https://github.com/Alisher23/storelingo

## Лицензия

MIT
