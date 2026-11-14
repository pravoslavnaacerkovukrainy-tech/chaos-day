# Стабильные имена элементов интерфейса

Для браузерной приёмки (Kimi). Селектор `[data-testid="…"]`. Рядом есть роли и подписи:
кнопки строк имеют `aria-label` с текстом дела, например «Выполнить задачу: Купить батарейки».
Строки несут идентификатор объекта: `data-task-id`, `data-chaos-id`, `data-entry-id`, `data-project-id`.
Имена меняются только вместе с этим файлом.

## Общие

| testid | Что это |
|---|---|
| `nav` | Перечень разделов (`<nav aria-label="Разделы">`) |
| `nav-chaos`, `nav-plan`, `nav-projects`, `nav-waiting`, `nav-review`, `nav-tasks`, `nav-notes`, `nav-diary`, `nav-data` | Ссылки разделов; активная с `aria-current="page"`. Адрес — `#/<раздел>` |
| `nav-toggle` | Кнопка «Разделы» на узком окне (≤ 860 px), `aria-expanded` |
| `logout` | «Выйти» |
| `theme-switch`, `theme-dark`, `theme-light` | Переключатель «Тема: Тёмная / Светлая» (`role=radiogroup`, выбранная — `aria-checked="true"`): внизу перечня разделов (на узком окне — внутри «Разделы») и на экране входа. По умолчанию тёмная независимо от ОС; выбор хранится в браузере (`localStorage["chaos-day-theme"]`) и переживает обновление и выход. Светлая — `<html data-theme="light">` |
| `status` | Строка подтверждения (`role=status`), например «Записано в место хаоса» |
| `error`, `error-dismiss` | Красная строка ошибки (`role=alert`) и «Закрыть» |
| `area-filter`, `area-all`, `area-work`, `area-personal` | Фильтр «Все / Работа / Личное» |
| `empty` и `*-empty` | Пустой раздел; текст содержит «Сейчас здесь ничего нет» |
| `view-chaos`, `view-plan`, `view-projects`, `view-waiting`, `view-review`, `view-tasks`, `view-notes`, `view-diary`, `view-data` | Заголовок `h1` раздела |
| `capture-open` | Постоянная кнопка «Записать»: в боковой панели на широком окне, в верхней строке на узком (≤ 860 px). Одна на страницу |

## Окно «Записать» (`capture-dialog`, `<dialog>`)

Открывается из любого раздела, раздел не меняется. Строка уходит в «Место хаоса».

| testid | |
|---|---|
| `capture-input`, `capture-urgent-input` | Строка (фокус при открытии, Enter записывает), необязательная отметка «Не может ждать» |
| `capture-save`, `capture-cancel` | «Записать», «Отмена» (и Esc) — без записи. После закрытия фокус возвращается на кнопку, открывшую окно |
| `capture-dialog-error` | Ошибка записи внутри окна; введённая строка остаётся |

## Вход

| testid | |
|---|---|
| `setup-form` / `login-form` | Первый запуск / обычный вход |
| `login-password`, `login-password-repeat` | Пароль; повтор только при первом запуске |
| `login-submit`, `login-error` | Кнопка и ошибка («Неверный пароль.», «Пароли не совпадают.») |

## Место хаоса

| testid | |
|---|---|
| `chaos-input`, `chaos-urgent-input`, `chaos-save` | Поле записи (фокус при открытии, Enter записывает), «Не может ждать», «Записать» |
| `chaos-list`, `chaos-item`, `chaos-text`, `chaos-urgent` | Список, строка, текст, пометка «Не может ждать» |
| `chaos-to-task` | «Это задача» — открывает `task-editor` |
| `chaos-to-note` | «Это заметка» |
| `chaos-toggle-urgent` | «Не может ждать» / «Может подождать» |
| `chaos-remove` | «Снять» — мгновенно, без причины |

## Редактор задачи (`task-editor`, `<dialog>`)

| testid | |
|---|---|
| `task-text-input`, `task-area-personal`, `task-area-work` | Действие, сфера |
| `task-day-input`, `task-day-today`, `task-day-tomorrow`, `task-day-clear` | День работы |
| `task-extra` | «Дополнительно» (раскрывает остальное) |
| `task-project`, `task-status` | Проект, состояние |
| `task-deadline-input`, `task-review-input` | Срок результата, дата пересмотра |
| `task-waiting-input`, `task-promised-input`, `task-at-risk-input`, `task-details-input` | Ожидаю, «Кому обещано», «Обещание под угрозой», подробности |
| `task-save`, `task-cancel`, `task-editor-error` | Сохранить, Отмена (и Esc), ошибка сохранения внутри окна |
| `steps`, `steps-toggle`, `steps-list`, `step-row`, `step-text`, `step-done`, `step-delete`, `step-add`, `steps-save`, `steps-error` | «Разбить на шаги», «Сохранить правки шагов» |

## Строка задачи (`task-row`)

| testid | |
|---|---|
| `task-text`, `task-next-step` | Текст, следующий незавершённый шаг |
| `task-at-risk`, `task-day`, `task-deadline`, `task-review`, `task-promised`, `task-removed`, `task-completed`, `task-removal-reason` | Пометки строки |
| `task-complete` | Выполнить (круг слева) |
| `task-reopen` | «Вернуть в задачи» у выполненной (подтверждение `confirm-reopen-confirm`) |
| `task-reschedule` → `reschedule-today`, `reschedule-tomorrow`, `reschedule-date` + `reschedule-apply`, `reschedule-clear` | «Перенести»: меняется только день работы |
| `task-edit` | «Изменить» |
| `task-more` → `task-toggle-risk`, `task-remove`, `task-delete` | «Ещё»: угроза, «Снять…», «Удалить» |
| `task-return` | «Вернуть в работу» у снятой |
| `remove-dialog`, `remove-reason`, `remove-confirm`, `remove-cancel` | Окно «Снять задачу»; кнопка неактивна без причины |
| `confirm-complete-confirm`, `confirm-delete-confirm`, `confirm-delete-steps-confirm` | Подтверждения |

## План

`plan-today`, `plan-tomorrow`, `plan-prev`, `plan-next`, `plan-date`, `plan-day-title`, `plan-list`, `plan-empty`,
`plan-new-task`, `plan-urgent` / `plan-urgent-item` / `plan-urgent-to-task` (строки «Не может ждать» в «Сегодня»).
Неделя `plan-week`: семь кнопок `plan-week-day` с понедельника по воскресенье, у каждой `data-day="YYYY-MM-DD"`,
выбранная с `aria-pressed="true"`, сегодняшняя с `aria-current="date"`. `plan-review-link` — «Пересмотреть план»
в «Сегодня», ведёт на `#/review`.
Поиск по делам: `deals-search`, `deals-search-results`, `deals-search-count`, `deals-search-clear`,
`deals-search-completed`, `deals-search-removed`, `search-project`, `search-chaos`.

## Проекты, Ожидаю, Все задачи

`project-new`, `project-card`, `project-title`, `project-outcome`, `project-next`, `project-next-select`,
`project-add-task`, `project-edit`, `project-archive`, `project-delete`, `projects-show-archived`,
редактор `project-editor`: `project-title-input`, `project-outcome-input`, `project-uncertainty-input`,
`project-review-input`, `project-area-input`, `project-save`, `project-cancel`.
`waiting-list`, `waiting-empty`. `tasks-list`, `tasks-empty`, `tasks-new`, `tasks-show-completed`, `tasks-show-removed`.

## Обзор

`review-groups` — `<ol>` из шести `review-group-1` … `review-group-6` в порядке методики,
у каждой `data-review-key` из контракта, `review-group-title`, и либо список, либо `review-group-empty`
с текстом «Сейчас здесь ничего нет». Проект в группе — `review-project`. Охра только у `data-review-key="at_risk"`.

## Заметки

`note-new`, `notes-search`, `notes-list`, `note-item`, `note-editor`, `note-title-input`, `note-body-input`,
`note-mode-view`, `note-mode-edit`, `note-view`, `note-folder`, `note-pin`, `note-save`, `note-discard`, `note-delete`,
`folder-tree`, `folder-item`, `folder-new`, `folder-new-sub`, `folder-rename`, `folder-delete`,
окно `folder-dialog`: `folder-name-input`, `folder-save`, `folder-cancel`.

Markdown: `note-rendered` — отрисованный текст в Просмотре (HTML не интерпретируется, картинки — ссылки),
`note-unsaved` — пометка в Просмотре несохранённой заметки. Вкладки `note-mode-view` / `note-mode-edit` есть и у новой заметки.
Панель форматирования `note-format-bar` (`role=toolbar`, стрелки внутри): `note-format-heading`, `note-format-bold`,
`note-format-italic`, `note-format-bullet`, `note-format-ordered`, `note-format-quote`, `note-format-code`, `note-format-link`.
Клавиши в поле текста: ⌘/Ctrl+B, ⌘/Ctrl+I, ⌘/Ctrl+K.

## Дневник

`diary-input`, `diary-context-input`, `diary-time-input`, `diary-save`, `diary-prev`, `diary-today`, `diary-next`,
`diary-date`, `diary-days` (дни с записями), `diary-day-title`, `diary-list`, `diary-empty`, `diary-entry`, `diary-entry-text`, `diary-entry-context`,
`diary-entry-edit`, `diary-entry-delete`, `diary-search`, `diary-search-results`, `diary-search-count`,
окно `entry-editor`: `entry-text-input`, `entry-context-input`, `entry-save`, `entry-cancel`.

## Импорт и экспорт

`import-file`, `import-overwrite`, `import-submit`, `import-result`, `import-summary`, `import-report`
(строки `data-import-group="tasks|projects|chaos|entries|notes|note_folders"`, столбцы «Добавлено / Обновлено / Без изменений»),
`import-warnings`, `import-error`, `export-json`, `export-md`, `timezone-input`, `timezone-save`.
