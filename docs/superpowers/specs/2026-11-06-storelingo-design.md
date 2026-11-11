# storelingo — дизайн v1

- **Дата:** 2026-11-06
- **Автор:** Alisher23
- **Статус:** на согласовании

## 1. Цель

`storelingo` — open-source CLI на TypeScript (npm). Он переводит тексты страниц приложений в Google Play и App Store на десятки языков с помощью ИИ, соблюдая лимиты символов магазинов, и заливает их через официальные API.

Позиционирование: «ИИ-локализация fastlane-метаданных, которой не нужен fastlane». Инструмент читает и пишет стандартную структуру папок `fastlane supply` / `fastlane deliver`, поэтому подключается к существующим проектам без переделок.

Побочная цель: вырастить проект до соответствия критериям Claude for Open Source (внешние контрибьюторы, Ecosystem Impact Track).

### Не входит в v1

- скриншоты и рамки устройств;
- ответы на отзывы, аналитика;
- ASO-подбор ключевых слов по данным поиска;
- заливка release notes в Google Play (переводятся, но не заливаются, см. §7.1);
- магазины кроме Google Play и App Store (архитектура готова к ним, см. §4).

## 2. Пользовательский сценарий

```
npx storelingo init       # один раз
npx storelingo pull       # если папок fastlane ещё нет
npx storelingo translate
git diff                  # человек смотрит переводы
npx storelingo check
npx storelingo push --dry-run
npx storelingo push
```

## 3. Команды

| Команда | Поведение | Сеть |
|---|---|---|
| `init` | Интерактивно спрашивает исходный язык, целевые языки, магазины, ID приложений, ИИ-провайдера. Создаёт `storelingo.config.json`, пустые папки, дописывает файлы ключей в `.gitignore`. Не перезаписывает существующий конфиг без `--force`. | нет |
| `pull` | Скачивает текущие тексты из магазинов во все локали, которые там есть. Существующие локальные файлы не перезаписывает без `--force`. | да |
| `translate` | Переводит изменившиеся поля исходного языка на целевые языки. Флаги: `--locale <код>` (повторяемый), `--force`. | да (ИИ) |
| `check` | Офлайн-проверка: лимиты, пустые обязательные поля, формат keywords, поддержка языка магазином. Код выхода 1 при ошибках. | нет |
| `push` | Показывает diff с живой страницей и после подтверждения заливает. Флаги: `--dry-run`, `--yes` (обязателен вне TTY), `--store play\|appstore`. Перед заливкой запускает `check` и останавливается при ошибках. | да |

Общие флаги: `--config <путь>`, `--verbose`, `--no-color`.

## 4. Архитектура

Node ≥ 22.13, ESM, TypeScript strict. Зависимости: `commander`, `zod`, `@anthropic-ai/sdk` (официальный SDK для адаптера Claude), `@inquirer/prompts` (только для `init` и подтверждений); с v0.2 — `jose`. Остальной HTTP — встроенный `fetch`. SDK Google/Apple не используются.

```
src/
  cli/          разбор аргументов → вызов сценариев; без логики
  commands/     init, pull, translate, check, push — сценарии, связывающие модули
  config/       схема (zod) и загрузка storelingo.config.json, чтение env
  fields/       реестр полей магазинов (данные): файл, лимит, правила
  locales/      таблица кодов языков и поддержки магазинами (данные)
  metadata/     чтение/запись папок fastlane
  lock/         storelingo.lock.json: хэши исходников и переводов
  translate/    интерфейс Translator, сборка промпта, контроль лимитов
    providers/  anthropic.ts, openai-compatible.ts
  stores/       интерфейс StoreClient
    google-play/
    app-store/
  util/         подсчёт символов, ретраи, логгер с маскировкой секретов
```

Интерфейсы ядра:

```ts
type StoreId = "play" | "appstore";

interface FieldDef {
  store: StoreId;
  key: string;            // "title", "keywords", …
  file: string;           // относительный путь внутри папки локали
  maxChars: number;
  translatable: boolean;  // URL-поля — false
  kind: "text" | "keywords" | "url";
}

interface Translator {
  translate(req: TranslateRequest): Promise<TranslateResult>;
}

interface StoreClient {
  pull(): Promise<Listing[]>;              // все локали из магазина
  diff(local: Listing[]): Promise<Diff[]>;
  push(diff: Diff[]): Promise<PushReport>;
}
```

Новый магазин (RuStore, Huawei AppGallery) = новый `StoreClient` + записи в `fields/` и `locales/`. Новый ИИ-провайдер = новый файл в `translate/providers/`. Остальной код не меняется.

## 5. Файлы

### 5.1 Структура fastlane (по умолчанию)

- **Android** (`fastlane supply`): `fastlane/metadata/android/<locale>/`
  - `title.txt`, `short_description.txt`, `full_description.txt`, `video.txt`
  - `changelogs/<versionCode>.txt`
- **iOS** (`fastlane deliver`): `fastlane/metadata/<locale>/`
  - `name.txt`, `subtitle.txt`, `description.txt`, `keywords.txt`, `promotional_text.txt`, `release_notes.txt`
  - `marketing_url.txt`, `support_url.txt`, `privacy_url.txt`
  - При чтении iOS-локалей игнорируются папки `android`, `default`, `review_information`, `trade_representative_contact_information`.

Пути переопределяются в конфиге (`paths.play`, `paths.appstore`) и обязаны оставаться внутри проекта: абсолютные пути и выход через `..` отклоняются (`E_CONFIG`). Пути и lock-файл считаются от текущей папки (cwd). Инструмент не следует по символическим ссылкам при чтении и записи метаданных и lock-файла (`E_CONFIG`), так как конфиг и файлы могут прийти из чужого репозитория. Файлы пишутся в UTF-8 без BOM, с `\n` (переводы строк из ответа модели нормализуются до записи и хэширования). Хвостовой перевод строки сохраняется таким, каким был в исходнике.

### 5.2 Лимиты (данные в `fields/`)

| Магазин | Поле | Лимит | Переводится |
|---|---|---|---|
| Play | title | 30 | да |
| Play | short_description | 80 | да |
| Play | full_description | 4000 | да |
| Play | changelogs/* | 500 | да |
| Play | video | — | нет |
| App Store | name | 30 | да |
| App Store | subtitle | 30 | да |
| App Store | keywords | 100 | да (особые правила) |
| App Store | promotional_text | 170 | да |
| App Store | description | 4000 | да |
| App Store | release_notes | 4000 | да |
| App Store | *_url | — | нет |

Символы считаются по кодовым точкам Unicode (`[...str].length`).

### 5.3 `storelingo.config.json`

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

- `targetLocales` задаются в «общих» кодах. Перевод в коды каждого магазина делает `locales/`. Если магазин не поддерживает язык (например, App Store не поддерживает `ky`), язык пропускается для этого магазина с предупреждением.
- `provider: "openai-compatible"` дополнительно требует `baseUrl` (OpenAI, OpenRouter, Gemini OpenAI-endpoint, Ollama).
- **Защита ключа от чужого `baseUrl`** (конфиг может прийти из чужого репозитория): `OPENAI_API_KEY` отправляется только на хост `api.openai.com`. Для любого другого хоста ключ берётся только из явной `STORELINGO_TRANSLATOR_API_KEY`. Не-loopback `baseUrl` обязан быть `https://`; `http://` разрешён только для `localhost`, `127.0.0.1`, `[::1]`.
- Default для Claude: модель `claude-opus-5-5`, `effort: "medium"` (у этой модели thinking не отключается, глубину задаёт effort). Пользователь может указать любую модель, например `claude-sonnet-5-5` или `claude-haiku-5-5` для экономии.
- Адаптер Claude включает серверный fallback при отказе модели (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) и проверяет `stop_reason` (`refusal`, `max_tokens`) до чтения ответа. Ретраи 429/5xx делает сам SDK (`maxRetries`).
- JSON-ответ запрашивается через structured outputs: `output_config.format = { type: "json_schema", schema }`.

### 5.4 Секреты — только переменные окружения

| Переменная | Назначение |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API |
| `OPENAI_API_KEY` | только для `baseUrl` на `api.openai.com` |
| `STORELINGO_TRANSLATOR_API_KEY` | ключ для любого другого OpenAI-совместимого хоста (OpenRouter и т.п.); для Ollama не нужен |
| `STORELINGO_TRANSLATOR_API_HOST` | хост, которому разрешено отправлять запросы OpenAI-совместимого провайдера (например `openrouter.ai`). Для любого не-loopback хоста, кроме `api.openai.com`, он **обязателен и должен совпадать** с хостом `baseUrl` даже без ключа — иначе `E_CONFIG` (чужой конфиг не может отправить тексты на произвольный сервер). `STORELINGO_TRANSLATOR_API_KEY` отправляется только на этот хост. |
| `STORELINGO_PLAY_SERVICE_ACCOUNT` | путь к JSON сервисного аккаунта Google **или** сам JSON |
| `STORELINGO_ASC_ISSUER_ID`, `STORELINGO_ASC_KEY_ID` | App Store Connect API |
| `STORELINGO_ASC_PRIVATE_KEY` | путь к `.p8` **или** его содержимое |

Секреты не пишутся в конфиг, lock-файл и логи. Логгер маскирует известные значения.

### 5.5 `storelingo.lock.json`

```json
{
  "version": 1,
  "entries": {
    "appstore/de-DE/description": {
      "sourceHash": "sha256:…",
      "outputHash": "sha256:…"
    }
  }
}
```

Lock-файл коммитится в git, чтобы CI и соавторы разделяли состояние.

## 6. Перевод

### 6.1 Отбор полей

Для каждого (магазин, локаль, поле), где `translatable = true`, принимается одно решение:

- исходный файл пуст или отсутствует → пропустить;
- целевой файл отсутствует **или пуст (только пробелы)** → считается отсутствующим (переводить);
- целевой файл существует и его хэш ≠ `outputHash` → **изменён вручную**: пропустить, сообщить (кроме `--force`);
- `sourceHash` совпадает с текущим и целевой файл существует → без изменений: пропустить;
- иначе → перевести.

### 6.2 Запрос

- Один запрос на (магазин, локаль), со всеми отобранными полями. Вход и выход — JSON `{ "<fieldKey>": "<text>" }`.
- Ответ проверяется zod-схемой: ровно запрошенные ключи, строки. Невалидный ответ → один повтор, затем ошибка по всей локали.
- Промпт содержит:
  - `context`;
  - целевой язык;
  - лимит каждого поля;
  - `doNotTranslate`;
  - `terms` для этой локали;
  - правила: локализовать, а не переводить дословно; сохранять переносы строк и маркированные списки; не добавлять эмодзи и выдуманные факты.
- **keywords**: подобрать слова, которые ищут на целевом языке. Формат — через запятую без пробелов, без дублей и без слов из `name`/`subtitle`, ≤ 100 символов. После ответа формат нормализуется кодом: trim, удаление пробелов вокруг запятых, дедупликация.

### 6.3 Лимиты

- Поле длиннее лимита → отдельный запрос «сократи до N символов» только для него, максимум 2 попытки.
- Всё ещё длиннее → файл не пишется, ошибка в отчёте, `check` падает.
- **Механическое обрезание запрещено.**

### 6.4 Исполнение

- До `concurrency` локалей параллельно (по умолчанию 4).
- 429 и 5xx: экспоненциальная задержка с джиттером, до 5 попыток, `retry-after` уважается.
- Итоговый отчёт: переведено, пропущено (без изменений / вручную / не поддерживается), ошибки, токены вход/выход.
- Lock обновляется только для успешно записанных полей. Падение посередине не портит уже готовое.

## 7. Магазины

### 7.1 Google Play (Android Publisher API v3)

- **Авторизация:** сервисный аккаунт. JWT RS256 → OAuth2 токен (scope `androidpublisher`).
- **pull:** `edits.insert` → `edits.listings.list` → `edits.delete`.
- **push:** `edits.insert` → `edits.listings.update` для каждой изменённой локали → `edits.validate` → `edits.commit`. Любая ошибка → `edits.delete`, в магазине ничего не меняется.
- **v1:** только title / short_description / full_description / video. Changelogs не заливаются, это отмечается в выводе `push`.
- **API (проверено по документации Google, 2026-11):** база `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}`; `POST /edits` → `{ id }`; `GET /edits/{id}/listings` → `{ listings: [{ language, title, shortDescription, fullDescription, video }] }`; `PUT /edits/{id}/listings/{language}` с телом Listing (создаёт или обновляет); `POST /edits/{id}:validate`; `POST /edits/{id}:commit`; `DELETE /edits/{id}`.
- **Коммит:** всегда с `changesInReviewBehavior=ERROR_IF_IN_REVIEW`. По умолчанию Google **отменяет изменения, уже находящиеся на проверке**, и отправляет новые — storelingo так никогда не делает. Если на проверке уже есть изменения → `E_IN_REVIEW` с подсказкой, черновик удаляется. Изменения листинга в Play после коммита проходят обычную проверку Google — это свойство магазина, а не отдельная отправка на ревью.
- **Токен:** JWT RS256 с `iss` = `client_email`, `scope` = `https://www.googleapis.com/auth/androidpublisher`, `aud` = `https://oauth2.googleapis.com/token`, `exp - iat ≤ 3600`; обмен `POST https://oauth2.googleapis.com/token` (form: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion`). Эндпоинт токена фиксированный (`token_uri` из файла ключа не используется).
- **HTTP:** таймаут на запрос, ретраи 429/5xx, `redirect: "error"`; токен и ключ никогда не попадают в ошибки и логи.
- **pull (Play):** пишет все языки, которые вернул Play, в папки по коду Play (в т.ч. языки вне таблицы storelingo — с предупреждением, что их нельзя сделать целевыми). Пустые поля не пишутся. Существующий файл с другим содержимым не перезаписывается без `--force` (сообщается как «пропущено: отличается»). Lock-файл не трогает: скачанные переводы без записи в lock считаются ручными правками и защищены от `translate`.
- **push (Play):** локали = исходная + целевые, которые поддерживает Play и для которых есть локальные файлы. Для каждой: значения из файлов поверх текущих значений в Play (поля без локального файла не трогаются). Новая локаль в Play требует локальных title, short_description и full_description, иначе ошибка `E_MISSING` для этой локали. Сравнение без хвостовых переводов строк. Удалённые локали, которых нет локально, не удаляются.
- **`--store`:** в v0.2 поддерживался только `play`. С v0.3 — `play` или `appstore` (магазин должен быть настроен, иначе `E_CONFIG`); без `--store` — все настроенные магазины по очереди (см. §7.2).

### 7.2 App Store Connect API

- **Авторизация:** JWT ES256 из `.p8`, `aud: appstoreconnect-v1`, срок 20 минут, перевыпуск по истечении.
- **name, subtitle** → `appInfoLocalizations` у редактируемого `appInfo`.
- **description, keywords, promotional_text, release_notes** → `appStoreVersionLocalizations` у версии в редактируемом состоянии (`PREPARE_FOR_SUBMISSION` и аналогичные).
  - Нет такой версии → эти поля пропускаются с сообщением.
  - `promotional_text` заливается в текущую версию при любом состоянии, где Apple это разрешает.
- **Новая локаль** → POST локализации. Существующая → PATCH.
- Атомарности нет: diff считается заранее, применяется по одному ресурсу, отчёт о частичном успехе. Повторный запуск идемпотентен.
- **API (проверено по документации Apple, 2026-11):** база `https://api.appstoreconnect.apple.com`.
  - JWT: заголовок `alg: ES256`, `kid` = Key ID, `typ: JWT`; payload `iss` = Issuer ID, `iat`, `exp`, `aud: "appstoreconnect-v1"`; `exp - iat` ≤ 20 минут (storelingo берёт 15 и перевыпускает за минуту до истечения). Ключ `.p8` (PKCS8, EC P-256). Поддерживаются только командные ключи (с Issuer ID).
  - `GET /v1/apps/{id}/appInfos` → `AppInfo.attributes.state` ∈ ACCEPTED, DEVELOPER_REJECTED, IN_REVIEW, PENDING_RELEASE, PREPARE_FOR_SUBMISSION, READY_FOR_DISTRIBUTION, READY_FOR_REVIEW, REJECTED, REPLACED_WITH_NEW_INFO, WAITING_FOR_REVIEW.
  - `GET /v1/appInfos/{id}/appInfoLocalizations` → атрибуты `locale, name, subtitle, privacyPolicyUrl, privacyChoicesUrl, privacyPolicyText`; `POST /v1/appInfoLocalizations` (`data.type: "appInfoLocalizations"`, `attributes.locale` обязателен, `relationships.appInfo.data: { type: "appInfos", id }`), `PATCH /v1/appInfoLocalizations/{id}` (`data: { type, id, attributes }`).
  - `GET /v1/apps/{id}/appStoreVersions?filter[platform]=IOS|MAC_OS|TV_OS|VISION_OS&filter[appVersionState]=…` → `AppStoreVersion.attributes.appVersionState` ∈ ACCEPTED, DEVELOPER_REJECTED, IN_REVIEW, INVALID_BINARY, METADATA_REJECTED, PENDING_APPLE_RELEASE, PENDING_DEVELOPER_RELEASE, PREPARE_FOR_SUBMISSION, PROCESSING_FOR_DISTRIBUTION, READY_FOR_DISTRIBUTION, READY_FOR_REVIEW, REJECTED, REPLACED_WITH_NEW_VERSION, WAITING_FOR_EXPORT_COMPLIANCE, WAITING_FOR_REVIEW.
  - `GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations` → `locale, description, keywords, marketingUrl, promotionalText, supportUrl, whatsNew`; `POST /v1/appStoreVersionLocalizations` (relationship `appStoreVersion`), `PATCH /v1/appStoreVersionLocalizations/{id}`.
  - Ошибки: `{ errors: [{ status, code, title, detail }] }`; 401 — неверный токен, 403 — нет прав, 404, 409 (конфликт состояния), 422, 429.
- **Выбор ресурсов:**
  - Редактируемая версия — версия платформы `stores.appstore.platform` (по умолчанию `IOS`) в состоянии PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, REJECTED или METADATA_REJECTED. Живая — READY_FOR_DISTRIBUTION.
  - Редактируемый appInfo — в состоянии PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED или REJECTED. Живой — READY_FOR_DISTRIBUTION.
  - `pull` читает из редактируемых ресурсов, если они есть, иначе из живых.
  - `push`: name / subtitle / privacy_url — только в редактируемый appInfo; description / keywords / release_notes / marketing_url / support_url — только в редактируемую версию; promotional_text — в редактируемую версию, иначе в живую. Изменения полей без доступного ресурса показываются в diff как «пропущено: нет редактируемой версии» и не заливаются (`E_NO_EDITABLE_VERSION` только если не осталось ни одного изменения, которое можно залить).
  - Новая локаль: POST в appInfo и/или версию; требует `name, description, keywords` локально и обоих редактируемых ресурсов.
- **pull/push без `--store`** (с v0.3): обрабатываются все настроенные магазины по очереди (play, затем appstore), у каждого свой diff и своё подтверждение.
  - Первая версия приложения (единственная версия платформы, и она редактируемая): release_notes не заливаются («Apple показывает их только для обновлений»; по поведению распространённых инструментов, не проверено по документации Apple).
  - Не атомарный магазин получает только изменённые поля; при сбое ошибка перечисляет «already applied / failed (may be partly applied) / not attempted».
  - Несколько редактируемых версий или appInfo: берётся PREPARE_FOR_SUBMISSION, иначе `E_STORE` «Several editable App Store versions found…».
  - Причина пропуска зависит от поля: нет редактируемого appInfo / нет редактируемой версии / release_notes первой версии; без особой причины — «the store can't take this field».
- **Секреты:** `STORELINGO_ASC_ISSUER_ID`, `STORELINGO_ASC_KEY_ID`, `STORELINGO_ASC_PRIVATE_KEY` (путь к `.p8` или его содержимое). Ключ и токен не попадают в логи и ошибки; `STORELINGO_ASC_PRIVATE_KEY` добавлен в маскирование.

### 7.3 Инварианты безопасности

- `push` всегда показывает diff. Подтверждение в TTY, вне TTY нужен `--yes`.
- Никогда: отправка на ревью, удаление локалей, изменение цен, билдов, скриншотов, категорий.
- `push` без изменений → «нечего заливать», код 0.

## 8. Ошибки

Каждая ошибка имеет код, понятное сообщение и подсказку. Минимальный набор:

| Код | Ситуация | Подсказка |
|---|---|---|
| `E_CONFIG` | конфиг невалиден | путь к полю, ожидаемый тип |
| `E_AUTH_PLAY` | 401/403 от Google | проверить ключ и право «Edit store listing» в Play Console |
| `E_AUTH_ASC` | 401 от Apple | проверить Issuer ID, Key ID, роль ключа App Manager |
| `E_NO_EDITABLE_VERSION` | нет редактируемой версии в App Store | создать версию в App Store Connect |
| `E_LOCALE_UNSUPPORTED` | язык не поддерживается магазином | список поддерживаемых |
| `E_LIMIT` | перевод не уложился в лимит | поправить вручную или упростить исходник |
| `E_TRANSLATOR` | ошибка ИИ-провайдера | статус и текст ответа (без ключа) |
| `E_MISSING` | нет обязательного поля в исходном языке | какой файл создать |
| `E_FORMAT` | неверный формат keywords | пример правильного формата |
| `E_USAGE` | неверные аргументы команды | правильный вызов |
| `E_IN_REVIEW` | в Play уже есть изменения на проверке | дождаться проверки или отправить/отменить их в Play Console |
| `E_STORE` | прочая ошибка API магазина | HTTP-статус и сообщение магазина (без токена) |

Коды выхода: `0` — успех, `1` — ошибки валидации или частичный сбой, `2` — неверное использование или конфиг.

## 9. Тестирование

- **vitest.** Модульные тесты: `fields`, `locales`, `lock` (все ветки §6.1), сборка промпта, нормализация keywords, подсчёт символов (эмодзи, арабский, комбинируемые знаки).
- **Провайдеры и магазины:** тесты на подменённом `fetch` с фикстурами в формате документации API. Проверяются последовательность вызовов (`insert → update → validate → commit`, откат при ошибке), ретраи, обработка 401/403/429.
- **Круговой тест metadata:** чтение → запись → байтовое совпадение на фикстуре fastlane-проекта.
- **CI (GitHub Actions):** lint (eslint), `tsc --noEmit`, тесты; матрица Node 22/24 × ubuntu/windows/macos.
- **Перед v1.0:** ручная e2e-проверка на реальном приложении (Play internal track, App Store версия в подготовке).

## 10. Open-source оформление

- Лицензия MIT. README на английском, `README.ru.md`, `CONTRIBUTING.md`, шаблоны issue/PR, `CHANGELOG.md`, semver.
- Публикация в npm из GitHub Actions по тегу, с `--provenance`.
- `docs/`: пошаговые гайды «создать сервисный аккаунт Google Play» и «создать API-ключ App Store Connect».
- После v1.0: GitHub Action-обёртка (`storelingo translate` + `check` в PR).
- Метки `good first issue`: новые магазины, провайдеры, локали, поправки лимитов.

## 11. Вехи

1. **v0.1:** `init`, `translate`, `check` (без магазинов, полезно с fastlane).
2. **v0.2:** Google Play `pull`/`push`.
3. **v0.3:** App Store `pull`/`push`.
4. **v1.0:** e2e на реальном приложении, гайды, публичный анонс.
