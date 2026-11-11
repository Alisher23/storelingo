# Настройка App Store

Как разрешить storelingo читать (`pull`) и обновлять (`push`) карточки приложения в App Store. Настройка делается один раз для команды (team) в App Store Connect.

[English version](app-store-setup.md)

storelingo обращается к API App Store Connect с помощью **командного API-ключа**: закрытый ключ `.p8` плюс два идентификатора (Key ID и Issuer ID). Учётные данные (Key ID, Issuer ID и сам ключ) берутся только из переменных окружения и никогда не записываются в конфиг; в конфиге лежит только Apple ID приложения (`stores.appstore.appId`). Индивидуальные ключи (без Issuer ID) не поддерживаются.

## 1. Создайте командный API-ключ

1. Войдите в App Store Connect под учётной записью, которой разрешено управлять API-ключами.
2. Откройте **Users and Access** (Пользователи и доступ), затем **Integrations**, затем **App Store Connect API** и создайте **командный** ключ.
3. Назначьте ему роль **App Manager**. Для редактирования локализаций этого достаточно; не берите роль шире, чем нужно.
4. Скачайте файл `.p8`. **Apple даёт скачать его только один раз.** Если файл потерян, отзовите ключ и создайте новый.
5. Запишите **Key ID** (виден рядом с ключом) и **Issuer ID** (виден на той же странице).

Не добавляйте `.p8` в git. `storelingo init` уже дописывает `*.p8` в `.gitignore`. Не коммитьте файл, не вставляйте его в чаты и не храните в репозитории.

Названия пунктов меню в App Store Connect время от времени меняются; если вы не видите именно этих подписей, ищите страницу API-ключей в разделе управления пользователями.

## 2. Найдите Apple ID приложения

Откройте приложение в App Store Connect и посмотрите **App Information** (Информация о приложении): нужен числовой **Apple ID** (например, `1234567890`). Это не bundle ID.

## 3. Сообщите storelingo

Три переменные окружения:

| Переменная | Значение |
|---|---|
| `STORELINGO_ASC_ISSUER_ID` | Issuer ID. |
| `STORELINGO_ASC_KEY_ID` | Key ID. |
| `STORELINGO_ASC_PRIVATE_KEY` | Путь к файлу `.p8` или само содержимое ключа (удобно для секретов CI). Если содержимое хранится в одной строке, последовательности `\n` (буквально) принимаются как переводы строк. |

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

Приложение указывается в `storelingo.config.json` (`init` спрашивает Apple ID):

```json
{ "stores": { "appstore": { "appId": "1234567890" } } }
```

`stores.appstore.platform` необязателен: `IOS` (по умолчанию), `MAC_OS`, `TV_OS` или `VISION_OS`. Он выбирает, с версией какой платформы работает storelingo; в одном конфиге одна платформа.

```json
{ "stores": { "appstore": { "appId": "1234567890", "platform": "MAC_OS" } } }
```

## 4. Первый запуск

```bash
npx storelingo pull --store appstore            # скачать текущие тексты в fastlane/metadata
npx storelingo translate                        # перевести изменившиеся исходные поля
npx storelingo check                            # офлайн-проверка лимитов и обязательных полей
npx storelingo push --store appstore --dry-run  # показать diff, ничего не менять
npx storelingo push --store appstore            # показать diff, спросить, затем загрузить
```

Без `--store` `pull` и `push` обрабатывают все настроенные магазины: сначала Google Play, затем App Store, у каждого свой diff и своё подтверждение. Учётные данные всех выбранных магазинов загружаются в первую очередь, до обращения к любому магазину, поэтому отсутствие ключа App Store останавливает запуск ещё до загрузки в Google Play. Сбой (ошибка API, `E_NO_EDITABLE_VERSION`) останавливает запуск. Заблокированный push (ошибки `check` или проблемы карточек) сообщается, а запуск продолжается со следующим магазином; код выхода при этом 1.

Что важно знать:

- `pull` только записывает файлы. Он никогда не меняет магазин и не трогает `storelingo.lock.json`. Локальные файлы, отличающиеся от магазина, остаются, если не указан `--force`. У скачанных переводов нет записи в lock-файле, поэтому `translate` пропускает их как ручные правки; переведите их заново через `translate --force`.
- `push` сначала запускает `check` и останавливается при ошибках (код выхода 1). Вне интерактивного терминала нужен `--yes` или `--dry-run`.
- storelingo никогда не отправляет ничего на ревью, не удаляет языки и не трогает цены, билды, скриншоты и категории.

## Как работают редактируемая и живая версии

App Store Connect хранит тексты версии, которая готовится, отдельно от текстов версии, которая уже опубликована. storelingo выбирает ресурсы так:

- **Редактируемая версия**: версия вашей платформы в состоянии `PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED`, `REJECTED` или `METADATA_REJECTED`.
- **Редактируемый app info**: app info в состоянии `PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED` или `REJECTED`.
- **Живые**: версия или app info в состоянии `READY_FOR_DISTRIBUTION`.

`pull` читает из редактируемых ресурсов, если они есть, иначе из живых.

`push` направляет каждое поле в единственный ресурс, который может его принять:

| Поле (файл) | Куда попадает |
|---|---|
| `name`, `subtitle`, `privacy_url` | только в редактируемый app info |
| `description`, `keywords`, `release_notes`, `marketing_url`, `support_url` | только в редактируемую версию |
| `promotional_text` | в редактируемую версию; если её нет, в живую |

Поэтому **без новой версии можно изменить только промо-текст**, причём на живой версии он вступает в силу сразу. Всё остальное требует версии в редактируемом состоянии; сначала создайте её в App Store Connect. Изменения редактируемой версии выходят вместе с ней, когда вы отправите её на ревью.

Поле, которому некуда попасть, не отправляется никогда. В diff оно показано строкой «skipped», например:

```
ru/description: skipped (no editable version in App Store Connect)
```

Причина зависит от поля: «no editable version in App Store Connect» для полей версии, «no editable app info in App Store Connect» для name, subtitle и privacy URL, «Apple shows release notes only for updates» для release notes в **первой версии приложения** (они не отправляются; в начале печатается примечание «First version of the app: release notes are not sent (Apple shows them only for updates).»). В начале `push` также печатает примечание, если чего-то не хватает, например «No editable App Store version: only promotional text can be updated. Create a new version in App Store Connect to change the rest.» (если версий нет вообще: «No App Store version yet: version texts can't be updated until a version exists.»). Если единственные изменения — пропущенные строки, `push` печатает их и останавливается с `E_NO_EDITABLE_VERSION` (код выхода 1); это верно и для `push --dry-run`, так что пробный запуск может завершиться с кодом 1. Если редактируемых версий (или app info) несколько, storelingo берёт ту, что в `PREPARE_FOR_SUBMISSION`; если и так неоднозначно, останавливается с `E_STORE` «Several editable App Store versions found; finish or remove the extra one in App Store Connect». Если часть изменений можно залить, они заливаются, а итоговое сообщение говорит, что часть изменений пропущена.

Для **нового языка** локально нужны `name`, `description` и `keywords`, а также и редактируемый app info, и редактируемая версия. Иначе `push` сообщит о проблеме и ничего не отправит.

## Push не атомарен

У API App Store Connect нет транзакций. `push` сначала считает diff, затем применяет его по одному языку (на язык уходит один-два запроса). Если запрос падает посреди работы, уже применённые языки остаются применёнными. Язык, на котором запрос упал, может быть применён частично (например, app info обновлён, а версия нет). Отправляются только изменённые поля. Сообщение об ошибке перечисляет три группы:

```
... — already applied: ru, de; failed (may be partly applied): tr; not attempted: fr
```

(для пустой группы печатается «none».) Это сообщение появляется при любом сбое обновления App Store, в том числе на первом языке. Исходный код ошибки сохраняется. Подсказка: «Re-run `storelingo push`: it only sends what still differs.» Повторный запуск безопасен в любом случае: storelingo заново читает магазин и отправляет только то, что ещё отличается.

Запросы, создающие новую локализацию, никогда не повторяются. Если такой запрос не получил внятного ответа (сетевая ошибка, тайм-аут, HTTP 5xx), storelingo сообщает `E_STORE` «App Store Connect create request status is unknown»; запустите `storelingo push --dry-run`, чтобы увидеть, создана ли локализация. Ответ 429 на такой запрос означает, что ничего не создано: вы получите `E_STORE` «App Store Connect rate limit (429): nothing was created; try again in a minute».

## Диагностика

| Ошибка | Вероятная причина | Что делать |
|---|---|---|
| `E_AUTH_ASC`, «rejected the API key (401)» | Неверный Issuer ID или Key ID, неверный или повреждённый `.p8`, либо ключ отозван. | Проверьте `STORELINGO_ASC_ISSUER_ID`, `STORELINGO_ASC_KEY_ID` и файл ключа; при необходимости создайте новый ключ. |
| `E_AUTH_ASC`, «denied access (403)» | Роль ключа слишком слабая или это не командный ключ. | Используйте командный ключ с ролью App Manager (или Admin). |
| `E_CONFIG`, сообщение про `STORELINGO_ASC_*` или `.p8` | Переменная не задана, путь к `.p8` не читается или значение не является закрытым ключом `.p8`. | Проверьте три переменные и что файл существует. |
| `E_CONFIG`, «App Store app ... not found or not accessible» | Неверный `stores.appstore.appId` или у команды ключа нет этого приложения. | Проверьте числовой Apple ID в App Information и что ключ принадлежит нужной команде. |
| `E_NO_EDITABLE_VERSION` | Всем изменениям нужна редактируемая версия, а её нет. | Создайте новую версию в App Store Connect и повторите `push`. |
| `E_STORE`, «status is unknown» | Запрос создания не получил внятного ответа и не повторялся. | Запустите `push --dry-run`, чтобы увидеть, существует ли локализация, затем при необходимости повторите `push`. |
| `E_STORE`, «refused the change (409)» | Конфликт состояния, как правило версия или app info перестали быть редактируемыми (например, их отправили на ревью, пока шёл `push`). | Проверьте версию в App Store Connect и повторите `push`; он отправит только то, что ещё отличается. |
| `E_STORE`, другая ошибка API | Apple вернул другую ошибку или сеть отказала после повторов. | Прочитайте сообщение; повторите позже. |

Коды выхода: `0` успех; `1` ошибка во время работы, ошибки `check` или заблокированный `push` (включая `E_AUTH_ASC`, `E_NO_EDITABLE_VERSION` и `E_STORE`); `2` неверное использование или конфиг (включая `E_CONFIG`, либо `push` без `--yes` вне терминала).
