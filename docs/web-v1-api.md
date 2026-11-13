# Контракт HTTP-API «Хаос Дня», этап 1

Черновик 1 от 13 ноября 2026. Владелец контракта — Qwen (сервер и интеграция).
Клод (фронтенд) и Kimi (приёмка) — соавторы: расхождения решаются правкой этого файла,
а не молчаливым соглашением в коде. Всё, что здесь не описано, считается несовместимым изменением.

- Base URL (локально): `http://127.0.0.1:3000`
- Все пути API начинаются с `/api/`. Клиент живёт на том же origin, поэтому запросы относительные.
- Тело запросов и ответов — JSON в UTF-8, `Content-Type: application/json; charset=utf-8`.
- Язык сообщений об ошибках и всех строк интерфейса — русский.

## 1. Типизация данных

```ts
/** Календарный день владельца. Строго YYYY-MM-DD, без часового пояса и без времени. */
type DayKey = string;          // "2026-11-13"

/** Момент времени. ISO-8601 в UTC с миллисекундами. */
type Iso = string;             // "2026-11-13T09:30:00.000Z"

type Area = "work" | "personal";

/** «Можно делать» / «Ожидаю» / «Отложено» / «Снято» + унаследованный «Место хаоса». */
type TaskStatus = "inbox" | "ready" | "waiting" | "paused" | "removed";

type UUID = string;            // канонический нижний регистр, 36 знаков

interface TaskStep {
  id: UUID;
  text: string;
  completed_at: Iso | null;
}

interface Task {
  id: UUID;
  text: string;
  /** День работы. Пустая строка — день не выбран. */
  day: DayKey | "";
  /** Срок результата. Три даты независимы. */
  deadline: DayKey | null;
  /** Дата пересмотра. */
  review_date: DayKey | null;
  area: Area;
  project_id: UUID | null;
  status: TaskStatus;
  waiting_for: string | null;
  /** Свободная строка, не контакт. В дневник не копируется. */
  promised_to: string | null;
  /** Ставит и снимает только человек. */
  at_risk: boolean;
  /** Непустая только вместе со статусом "removed". */
  removal_reason: string | null;
  details: string | null;
  steps: TaskStep[];
  completed_at: Iso | null;
  /** Запись дневника, созданная отметкой выполнения. */
  entry_id: UUID | null;
  created_at: Iso;
  updated_at: Iso;
  /** Счётчик правок: растёт на каждое сохранение задачи. Нужен для base_revision. */
  revision: number;
  /** Сервисные производные поля — читать можно, присылать нельзя. */
  is_completed: boolean;
  is_removed: boolean;
  is_open: boolean;
  next_step: TaskStep | null;
}

interface Project {
  id: UUID;
  title: string;
  outcome: string;
  area: Area;
  uncertainty: string;         // «что нужно выяснить», пусто по умолчанию
  review_date: DayKey | null;
  next_action_id: UUID | null; // ровно один следующий шаг
  archived: boolean;
  created_at: Iso;
  updated_at: Iso;
}

interface ChaosItem {
  id: UUID;
  text: string;
  urgent: boolean;             // «Не может ждать»
  created_at: Iso;
}

interface DiaryEntry {
  id: UUID;
  text: string;
  context: string | null;      // «на чём остановился»
  timestamp: Iso;
  day: DayKey;                 // производное от timestamp в часовом поясе владельца
  plan_id: UUID | null;        // связь с задачей, создавшей запись
  created_at: Iso;
  updated_at: Iso;
}

interface Note {
  id: UUID;
  title: string;
  body: string;                // Markdown
  folder_id: UUID | null;      // null — «Без папки»
  pinned: boolean;
  created_at: Iso;
  updated_at: Iso;
}

interface NoteFolder {
  id: UUID;
  name: string;
  parent_id: UUID | null;
}

interface ReviewItem {
  kind: "task" | "project";
  id: UUID;
  /** Заголовок для показа: текст задачи или название проекта. */
  title: string;
  task: Task | null;
  project: Project | null;
}

interface ReviewGroup {
  /** Стабильный ключ, по нему фронтенд держит порядок и цвет. */
  key: "promised_with_deadline" | "promised_without_deadline" | "at_risk"
     | "today_and_next_steps" | "waiting" | "review";
  title: string;               // русский заголовок группы
  items: ReviewItem[];
  is_empty: boolean;
  empty_text: string;          // «Сейчас здесь ничего нет»
}

interface Snapshot {
  timezone: string;            // например "Europe/Kyiv"
  today: DayKey;
  now: Iso;
  chaos: ChaosItem[];
  tasks: Task[];
  projects: Project[];
  entries: DiaryEntry[];
  notes: Note[];
  note_folders: NoteFolder[];
}
```

### Порядок шести групп обзора (фиксирован методикой)

| # | `key` | `title` |
|---|---|---|
| 1 | `promised_with_deadline` | Обещания со сроком |
| 2 | `promised_without_deadline` | Обещания без срока |
| 3 | `at_risk` | Под угрозой |
| 4 | `today_and_next_steps` | Сегодня и следующие шаги |
| 5 | `waiting` | Ожидания |
| 6 | `review` | Пересмотр |

Групп всегда шесть, пустые включены. Дело попадает только в первую подходящую группу —
выполненные задачи, снятые задачи и архивные проекты исключены. Строки места хаоса в обзор не входят.
Группа 3 «Под угрозой» — единственная, которая красится сигнальным `#A35A00`.

## 2. Ошибки

Любая ошибка — JSON одного вида и корректный HTTP-код:

```json
{ "error": { "code": "task_already_completed", "message": "Задача уже отмечена выполненной." } }
```

`message` — русский текст для человека, его можно показывать как есть. `code` — стабильная строка
для логики клиента. Неизвестный `code` клиент трактует по HTTP-коду.

| HTTP | `code` | Когда |
|---|---|---|
| 400 | `invalid_request` | Тело не JSON, нет обязательного поля, лишний неизвестный тип. |
| 400 | `empty_text` | Пустой или пробельный текст задачи, строки хаоса, записи дневника. |
| 400 | `invalid_date` | Дата не `YYYY-MM-DD` или несуществующий день (например `2026-02-30`). |
| 400 | `invalid_timezone` | Часовой пояс не принят `Intl`. |
| 400 | `invalid_password` | Пароль короче 8 знаков или длиннее 512. |
| 400 | `invalid_steps` | Шаги: больше 100, пустой текст, длиннее 500 знаков, повтор id или текста. |
| 401 | `unauthorized` | Нет сессии или она истекла. Отдаётся на любой `/api/*`, кроме `/api/health`, `/api/auth/state`, `/api/auth/setup`, `/api/auth/login` и `/api/dev/*`. |
| 403 | `setup_already_done` | Пароль уже задан, `POST /api/auth/setup` больше не работает. |
| 403 | `setup_required` | Вход до настройки пароля: сначала `POST /api/auth/setup`. |
| 403 | `forbidden` | Действие недоступно в этом режиме. |
| 404 | `not_found` | Нет объекта с таким id, или путь API не существует. |
| 405 | `method_not_allowed` | Метод не поддерживается этим путём. |
| 409 | `task_already_completed` | Повторная отметка выполнения. Вторая запись дневника не создаётся. |
| 409 | `task_not_completed` | «Вернуть в план» у невыполненной задачи. |
| 409 | `task_is_completed` | Выполненную задачу нельзя править, переносить, снимать и отмечать угрозой — сначала «Вернуть в план». |
| 409 | `task_is_removed` | Снятую задачу нельзя изменить или выполнить до возврата в работу. |
| 409 | `task_is_not_removed` | «Вернуть в работу» у задачи, которая не снята. |
| 409 | `removal_reason_required` | «Снять…» без непустой причины. Пустая причина проверяется раньше, чем существование задачи. |
| 409 | `parent_has_steps` | Удаление задачи, у которой есть шаги. |
| 409 | `conflicting_changes` | Список шагов изменился в другом месте; нужен `base_updated_at` свежее. |
| 409 | `invalid_next_action` | Следующим шагом проекта может быть только открытая задача этого проекта со статусом «Можно делать». |
| 409 | `project_has_open_tasks` | Архив проекта, у которого остались открытые задачи. |
| 409 | `duplicate_note_folder_name` | Папка с таким именем уже есть у этого родителя. |
| 409 | `invalid_note_folder_move` | Перенос папки внутрь собственного поддерева. |
| 413 | `payload_too_large` | Тело больше 8 МБ (импорт — больше 64 МБ). |
| 415 | `unsupported_media_type` | Импорт не JSON. |
| 422 | `unsupported_format` | Файл не `daylog`, версия меньше 1 или больше 9. `message` называет версию и потолок. |
| 422 | `unreadable_file` | JSON повреждён. |
| 422 | `invalid_note_folder_reference` | Заметка ссылается на несуществующую папку. |
| 429 | `too_many_attempts` | Превышен порог подбора пароля. |
| 500 | `save_failed` | Хранилище не смогло записать изменение. Операция откачена целиком. |

Ошибки never не содержат стек, SQL, путь к файлу данных и текст чужих дел.

## 3. Сессия и cookies

- Одна учётная запись владельца. Открытой регистрации нет.
- Пароль задаётся при первом запуске и хранится только как проверка: `scrypt` (N=16384, r=8, p=1),
  соль 16 байт, формат записи `scrypt$N$r$p$<salt-hex>$<hash-hex>`. Текст пароля не хранится и не логируется.
- Сессия — случайные 32 байта, в базе лежит только SHA-256 токена.
- Cookie: `chaos_day_session=<token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`.
  Флаг `Secure` добавляется автоматически, когда запрос пришёл по HTTPS (этап 2), и не добавляется на `http://127.0.0.1`.
- Время жизни сессии — 12 часов, скользящее: каждый успешный запрос продлевает её.
  Истёкшая или отозванная сессия даёт 401 на любой защищённый путь.
- Без входа клиент не получает ни одного названия раздела: `GET /api/auth/state` возвращает только два булевых поля.
- Подбор пароля ограничен: 5 неудач с одного адреса за 15 минут, дальше 429.
- CSRF: `SameSite=Strict` плюс требование, чтобы изменяющий запрос **с телом** объявлял
  `Content-Type: application/json`, иначе `415 unsupported_media_type`. Запросы без тела
  (например `POST /api/auth/logout`) этого не требуют.
- Смена пароля (`POST /api/auth/password`) отзывает все сессии, включая текущую.

## 4. Запуск и переменные окружения

```bash
npm ci                     # или npm install
npm run dev                # сервер на http://127.0.0.1:3000
npm test                   # автопроверки правил (node --test)
npm run typecheck          # tsc --noEmit
npm run build              # сборка клиента в client/dist (Vite)
npm start                  # сервер + раздача client/dist
```

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `3000` | Порт HTTP. |
| `HOST` | `127.0.0.1` | Адрес прослушивания. Только localhost на этапе 1. |
| `CHAOS_DAY_DATA_DIR` | `<repo>/.data` | Каталог файла `chaos-day.sqlite`. Зеркало `DAYLOG_DATA_DIR` Mac-версии. |
| `CHAOS_DAY_DB_FILE` | `<data-dir>/chaos-day.sqlite` | Полный путь к файлу базы. `:memory:` даёт базу в памяти. |
| `CHAOS_DAY_TIMEZONE` | `Europe/Kyiv` | Часовой пояс владельца при первом запуске; дальше хранится в базе. |
| `CHAOS_DAY_SESSION_TTL_SEC` | `43200` | Время жизни сессии. |
| `CHAOS_DAY_TESTING` | пусто | `1` включает `/api/dev/*` для приёмки. Без него эти пути отдают 403. |
| `CHAOS_DAY_ALLOW_FAULTS` | пусто | `1` разрешает управляемую ошибку сохранения. |

Приёмке нужен детерминированный изолированный запуск:

```bash
CHAOS_DAY_DATA_DIR=/tmp/chaos-day-acceptance CHAOS_DAY_TESTING=1 CHAOS_DAY_ALLOW_FAULTS=1 PORT=3100 npm run dev
```

## 5. Точки входа

### 5.1 Служебные

| Метод и путь | Доступ | Ответ |
|---|---|---|
| `GET /api/health` | без входа | `{"ok":true,"version":"1.0.0"}` |
| `GET /api/auth/state` | без входа | `{"setup_required":bool,"authenticated":bool}` |

`setup_required` — `true`, пока пароль не задан. `authenticated` — `true` при живой сессии.
Больше этот путь не отдаёт ничего, в том числе при активном входе.

### 5.2 Вход

| Метод и путь | Тело | Успех | Ошибки |
|---|---|---|---|
| `POST /api/auth/setup` | `{"password":string}` | `200 {"ok":true,"authenticated":true}` + cookie | 400 `invalid_password`, 403 `setup_already_done` |
| `POST /api/auth/login` | `{"password":string}` | `200 {"ok":true,"authenticated":true}` + cookie | 401 `unauthorized`, 429 `too_many_attempts` |
| `POST /api/auth/logout` | — | `200 {"ok":true,"authenticated":false}` + очистка cookie | — |
| `POST /api/auth/password` | `{"current_password":string,"next_password":string}` | `200 {"ok":true,"authenticated":false}`, все сессии отзываются | 400 `invalid_password`, 401 `unauthorized`, 403 `setup_required` |

Неудачный вход отдаёт тот же `unauthorized` с нейтральным `message` «Неверный пароль.» —
сервер не сообщает, существует ли учётная запись.

### 5.3 Снимок и выборки

| Метод и путь | Параметры | Ответ |
|---|---|---|
| `GET /api/state` | — | `{"ok":true,"data":Snapshot}` |
| `GET /api/meta` | — | `{"ok":true,"data":{"timezone":string,"today":DayKey,"now":Iso}}` |
| `PATCH /api/meta` | `{"timezone":string}` | `{"ok":true,"data":{"timezone":string,"today":DayKey}}`; пересчитывает `day` у всех записей дневника |
| `GET /api/day` | `?date=DayKey` (по умолчанию сегодня) | `{"ok":true,"data":{"date":DayKey,"is_today":bool,"tasks":Task[]}}` |
| `GET /api/review` | `?date=DayKey` | `{"ok":true,"data":{"date":DayKey,"groups":ReviewGroup[6]}}` |
| `GET /api/search` | `?q=&include_completed=&include_removed=` | `{"ok":true,"data":{"tasks":Task[],"projects":Project[],"chaos":ChaosItem[]}}` |

`GET /api/day` без `date` или с сегодняшней датой возвращает «Сегодня»: назначенные на сегодня,
оставшиеся с прошлых дней, задачи с наступившим сроком и отмеченные «Обещание под угрозой».
Отложенная задача видна только с отметкой угрозы. Другая дата возвращает открытые задачи
с днём работы или сроком ровно на эту дату; совпадение двух дат даёт одну строку.

`GET /api/search` ищет в одном разделе дел: текст задачи, подробности, ожидание и «Кому обещано»;
название, результат и неопределённость неархивных проектов; текст строк места хаоса.
Регистр и диакритика не учитываются. Пустой `q` отдаёт пустые списки.

### 5.4 Место хаоса

| Метод и путь | Тело | Успех |
|---|---|---|
| `GET /api/chaos` | — | `{"ok":true,"data":{"chaos":ChaosItem[]}}` — срочные выше, затем новые раньше, добор по id |
| `POST /api/chaos` | `{"text":string,"urgent"?:bool}` | `201 {"ok":true,"data":{"chaos":ChaosItem}}` |
| `PATCH /api/chaos/:id` | `{"text"?:string,"urgent"?:bool}` | `{"ok":true,"data":{"chaos":ChaosItem}}` |
| `POST /api/chaos/:id/urgent` | `{"urgent":bool}` | `{"ok":true,"data":{"chaos":ChaosItem}}` |
| `POST /api/chaos/:id/to-task` | черновик задачи (см. ниже) | `201 {"ok":true,"data":{"task":Task,"removed_chaos_id":UUID}}` |
| `POST /api/chaos/:id/to-note` | `{"title"?:string}` | `201 {"ok":true,"data":{"note":Note,"removed_chaos_id":UUID}}` |
| `DELETE /api/chaos/:id` | — | `{"ok":true,"data":{"removed_chaos_id":UUID}}` |

Черновик задачи для `to-task`: `{"text":string,"area":Area,"project_id"?:UUID|null,"status"?:TaskStatus,
"day"?:DayKey|"","deadline"?:DayKey|null,"review_date"?:DayKey|null,"waiting_for"?:string|null,
"promised_to"?:string|null,"at_risk"?:bool,"details"?:string|null}`.

Три правила разбора строки, которые сервер гарантирует одной транзакцией:

1. **Атомарность.** Строка удаляется только вместе с успешно сохранённой задачей или заметкой.
   Любая ошибка оставляет строку на месте с прежним `id`; клиент при отмене просто ничего не вызывает.
2. **Срочность переходит в угрозу.** Если `urgent === true`, новая задача получает `at_risk: true`,
   и ни одна из трёх дат не назначается, даже если черновик их не содержит. Переданные даты при этом
   сохраняются как есть — сервер их не выдумывает и не подставляет.
3. **Снятие строки мгновенное.** `DELETE` не требует причины и не создаёт запись дневника.
   Это не снятие задачи.

### 5.5 Задачи

| Метод и путь | Тело / параметры | Успех |
|---|---|---|
| `GET /api/tasks` | `?show_completed=&show_removed=&area=&project_id=&status=` | `{"ok":true,"data":{"tasks":Task[]}}` |
| `POST /api/tasks` | черновик задачи | `201 {"ok":true,"data":{"task":Task}}` |
| `GET /api/tasks/:id` | — | `{"ok":true,"data":{"task":Task}}` |
| `PATCH /api/tasks/:id` | частичный черновик | `{"ok":true,"data":{"task":Task}}` |
| `POST /api/tasks/:id/reschedule` | `{"day":DayKey\|""}` | `{"ok":true,"data":{"task":Task}}` — **меняет только день работы** |
| `POST /api/tasks/:id/complete` | — | `{"ok":true,"data":{"task":Task,"entry":DiaryEntry}}` |
| `POST /api/tasks/:id/reopen` | — | `{"ok":true,"data":{"task":Task,"outcome":"removed_entry"\|"kept_entry"\|"no_entry","entry":DiaryEntry\|null}}` |
| `POST /api/tasks/:id/remove` | `{"reason":string}` | `{"ok":true,"data":{"task":Task}}` |
| `POST /api/tasks/:id/return-to-work` | — | `{"ok":true,"data":{"task":Task}}` |
| `POST /api/tasks/:id/at-risk` | `{"at_risk":bool}` | `{"ok":true,"data":{"task":Task}}` |
| `POST /api/tasks/:id/steps` | `{"steps":TaskStep[],"base_revision"?:number,"base_updated_at"?:Iso}` | `{"ok":true,"data":{"task":Task}}` |
| `DELETE /api/tasks/:id` | — | `{"ok":true,"data":{"removed_task_id":UUID}}` |

Гарантии правил:

- **`reschedule` — только день работы.** `deadline` и `review_date` не меняются. Это единственная
  точка, где календарь задачи двигается одной командой.
- **`complete`** атомарно создаёт ровно одну запись дневника с текущим временем, `plan_id` = id задачи,
  `context` = null, текст = текст задачи. Поле `promised_to` в запись не копируется.
  Повторный вызов — `409 task_already_completed`, второй записи не появляется.
  Снятую задачу выполнить нельзя: `409 task_is_removed`.
- **`reopen`** снимает отметку. Связанная запись удаляется, только если её не меняли
  (`text`, `timestamp`, отсутствие `context` и `updated_at === created_at` совпадают);
  изменённая запись остаётся в дневнике с `plan_id: null` — исход `kept_entry`.
  Записи уже нет — `no_entry`.
- **`remove`** требует непустую причину: `409 removal_reason_required`. Снятие не заполняет
  `completed_at`, не создаёт запись дневника и сохраняет шаги. Снятая задача скрыта из «Сегодня»,
  «Ожидаю», «Обзора» и выборки угрозы; в полном списке видна только с `show_removed=1`.
  Снятую задачу нельзя править и выполнять до возврата.
- **`return-to-work`** ставит `status: "ready"` и стирает прежнюю причину, чтобы она не выглядела текущей.
- **`at-risk`** не меняет статус и даты, ничего не уведомляет и не двигает остальные дела.
- **`steps`** заменяет весь список одним сохранением. Основание для оптимистичной блокировки —
  `base_revision` (счётчик правок задачи, который сервер отдаёт в `Task.revision`) либо, если его
  нет, `base_updated_at`. При расхождении — `409 conflicting_changes`, правки клиента не затираются.
  Счётчик надёжнее отметки времени: две правки в пределах одной секунды он всё равно различает.
  Если не прислано ни одно из двух полей, проверка конфликта не выполняется.
  Ограничения списка: не больше 100 шагов, текст непустой и не длиннее 500 знаков, без повторов id и текста.
  Выполненную задачу править нельзя — сначала `reopen`.
- **`DELETE`** отклоняется с `409 parent_has_steps`, пока шаги явно не удалены и список не сохранён.
  Каскадного удаления нет. Удаление задачи сохраняет запись дневника.
- **Проект задаёт сферу.** Если передан `project_id`, проект должен существовать и не быть в архиве
  (иначе `404 not_found`), а `area` задачи принудительно становится сферой проекта — переданная
  `area` в этом случае игнорируется. `reschedule` с тем же днём — холостая операция: `updated_at` не меняется.

### 5.6 Проекты

| Метод и путь | Тело | Успех |
|---|---|---|
| `GET /api/projects` | `?show_archived=&area=` | `{"ok":true,"data":{"projects":Project[]}}` |
| `POST /api/projects` | `{"title":string,"outcome":string,"area":Area,"uncertainty"?:string,"review_date"?:DayKey\|null,"next_action_id"?:UUID\|null}` | `201 {"ok":true,"data":{"project":Project}}` |
| `PATCH /api/projects/:id` | частичное тело | `{"ok":true,"data":{"project":Project}}` |
| `POST /api/projects/:id/next-action` | `{"task_id":UUID\|null}` | `{"ok":true,"data":{"project":Project}}` |
| `POST /api/projects/:id/archive` | `{"archived":bool}` | `{"ok":true,"data":{"project":Project}}` |
| `DELETE /api/projects/:id` | — | `{"ok":true,"data":{"removed_project_id":UUID}}` |

`title` и `outcome` обязательны и непусты. Смена сферы проекта распространяется на все его задачи —
сфера задачи не живёт отдельно от проекта. Следующий шаг ровно один и проходит проверку
`409 invalid_next_action`: задача существует, принадлежит этому проекту, не выполнена и в статусе
«Можно делать». Архив возможен, только когда открытых задач проекта не осталось
(`409 project_has_open_tasks`); снятая задача считается закрытой так же, как выполненная,
и проект не держит. Удаление проекта обнуляет `project_id` его задач, сами задачи остаются.

### 5.7 Дневник

| Метод и путь | Тело / параметры | Успех |
|---|---|---|
| `GET /api/entries` | `?day=DayKey` или `?from=DayKey&to=DayKey` | `{"ok":true,"data":{"entries":DiaryEntry[]}}` — по времени, затем по id |
| `POST /api/entries` | `{"text":string,"context"?:string\|null,"timestamp"?:Iso}` | `201 {"ok":true,"data":{"entry":DiaryEntry}}` |
| `PATCH /api/entries/:id` | `{"text"?:string,"context"?:string\|null,"timestamp"?:Iso}` | `{"ok":true,"data":{"entry":DiaryEntry}}` |
| `DELETE /api/entries/:id` | — | `{"ok":true,"data":{"removed_entry_id":UUID}}` |

Запись можно создать задним числом: `timestamp` в прошлом допустим. Правка записи, связанной
с выполненной задачей, делает её «изменённой», и возврат задачи в работу её сохранит.
Удаление записи сохраняет отметку выполнения задачи, `entry_id` при этом обнуляется.

### 5.8 Заметки и папки

| Метод и путь | Тело / параметры | Успех |
|---|---|---|
| `GET /api/notes` | `?folder_id=&q=&include_body=` | `{"ok":true,"data":{"notes":Note[]}}` — закреплённые выше, затем по времени создания |
| `POST /api/notes` | `{"title":string,"body"?:string,"folder_id"?:UUID\|null,"pinned"?:bool}` | `201 {"ok":true,"data":{"note":Note}}` |
| `PATCH /api/notes/:id` | частичное тело | `{"ok":true,"data":{"note":Note}}` |
| `DELETE /api/notes/:id` | — | `{"ok":true,"data":{"removed_note_id":UUID}}` |
| `GET /api/note-folders` | — | `{"ok":true,"data":{"note_folders":NoteFolder[]}}` |
| `POST /api/note-folders` | `{"name":string,"parent_id"?:UUID\|null}` | `201 {"ok":true,"data":{"note_folder":NoteFolder}}` |
| `PATCH /api/note-folders/:id` | `{"name"?:string,"parent_id"?:UUID\|null}` | `{"ok":true,"data":{"note_folder":NoteFolder}}` |
| `DELETE /api/note-folders/:id` | — | `{"ok":true,"data":{"removed_folder_id":UUID,"moved_up":number}}` |

`folder_id` принимает строку `"none"` или `null` — оба означают «Без папки».
Удаление папки переносит её заметки и подпапки на уровень выше; у папки верхнего уровня
заметки остаются в «Без папки». Заметка хранит Markdown как есть, сервер его не разбирает.
Поиск `q` в заметках не выходит за пределы раздела.

### 5.9 Импорт и экспорт

| Метод и путь | Тело / параметры | Успех |
|---|---|---|
| `POST /api/import` | сырой JSON файла Mac; `?mode=merge\|overwrite` | `{"ok":true,"data":ImportReport}` |
| `GET /api/export.json` | — | файл `chaos-day-export-<DayKey>.json`, `Content-Type: application/json` |
| `GET /api/export.md` | — | файл `chaos-day-export-<DayKey>.md`, `Content-Type: text/markdown; charset=utf-8` |

```ts
interface ImportReport {
  source_version: number;        // 1..9
  mode: "merge" | "overwrite";
  added: { tasks:number; projects:number; chaos:number; entries:number; notes:number; note_folders:number };
  updated: { tasks:number; projects:number; chaos:number; entries:number; notes:number; note_folders:number };
  skipped: { tasks:number; projects:number; chaos:number; entries:number; notes:number; note_folders:number };
  warnings: string[];            // русские пояснения, например про потерянную ссылку на папку
}
```

Правила импорта:

- Файл читается только как `format: "daylog"` с `version` от 1 до 9. Иначе `422 unsupported_format`
  с объяснением: неизвестная более новая версия отклоняется целиком, а не обрезается молча.
- Импорт идемпотентен по идентификаторам. UUID приводятся к нижнему регистру, поэтому файл Mac
  ( uppercase ) и повторный импорт дают те же объекты. Повторный прогон того же файла даёт
  `added: 0` во всех группах.
- `mode=merge` (по умолчанию): отсутствующий объект добавляется; существующий перезаписывается,
  только если импортированный `updatedAt` новее сохранённого, иначе считается `skipped`.
- `mode=overwrite`: существующие объекты перезаписываются из файла всегда.
- Импорт не удаляет то, чего в файле нет. Он не трогает пароль и сессии.
- Всё изменение проходит в одной транзакции: при любой ошибке хранилище остаётся прежним.
- Моменты времени `deadline` и `review_date` из файла пересчитываются в `DayKey`
  в часовом поясе владельца, а `day` переносится как есть.
- Экспорт JSON повторяет формат Mac: `format`, вычисленная `version` (1–9), `exportedAt`,
  `entries`, `plans`, `notes`, `projects`, `chaos`, `noteFolders`, даты ISO-8601.
  Пустые массивы не пишутся, версия не поднимается без данных — файл читается Mac-версией.
- Экспорт собирает только сохранённое: черновик несохранённого поля в него не попадает.

### 5.10 Пути для приёмки (только `CHAOS_DAY_TESTING=1`)

| Метод и путь | Тело | Назначение |
|---|---|---|
| `POST /api/dev/reset` | — | Полностью очищает хранилище, включая пароль и сессии. Ответ `{"ok":true,"data":{"reset":true,"setup_required":true}}`. |
| `POST /api/dev/bootstrap` | `{"password":string,"timezone"?:string}` | Сброс + задание пароля одним вызовом, чтобы сценарий не зависел от порядка. Сразу выдаёт cookie сессии, поэтому следующий запрос уже авторизован. |
| `POST /api/dev/fault` | `{"inject":"save","times":number}` | Следующие N записей в хранилище завершатся ошибкой `500 save_failed` и полным откатом. Нужно для проверки «ошибка сохранения» и атомарности разбора строки. |
| `GET /api/dev/now` | `?shift_days=number` | Не меняет данные; возвращает `{"ok":true,"data":{"today":DayKey,"now":Iso}}` для сверки календарной логики. |

Пути `/api/dev/*` не требуют сессии: приёмке нужно сбрасывать хранилище и задавать пароль до входа.
Вместо этого они доступны только при `CHAOS_DAY_TESTING=1`, иначе отдают `403 forbidden`.
Управляемая ошибка дополнительно требует `CHAOS_DAY_ALLOW_FAULTS=1` и живёт только в памяти
процесса — перезапуск её снимает.

## 6. Тесты и fixtures

`npm test` запускает `node --test "tests/**/*.test.ts"`. Проверки идут без браузера и без сети,
на вымышленных делах. Боевой `entries.json`, ключи и личные заметки не читаются и в репозиторий
не кладутся.

| Файл проверок | Что закрывает |
|---|---|
| `tests/dates.test.ts` | календарный день в часовом поясе владельца; срок не уезжает на соседний день при смене пояса; отклонение несуществующих дат |
| `tests/rules-tasks.test.ts` | три даты независимы; снятие не равно выполнению; выполнение создаёт одну запись; повтор не создаёт вторую; возврат в работу |
| `tests/rules-chaos.test.ts` | атомарность разбора строки; отмена и ошибка сохраняют прежний id; срочная строка даёт угрозу без дат |
| `tests/rules-review.test.ts` | шесть групп, порядок, первое совпадение побеждает, дублей нет, пустые группы остаются |
| `tests/rules-steps.test.ts` | шаги без своих сроков и дневника; удаление задачи с шагами отклоняется; конфликт списка |
| `tests/import-export.test.ts` | v1–v9 читаются; неизвестная версия отклоняется с объяснением; повторный импорт сохраняет идентификаторы; «Кому обещано» не в дневнике; экспорт JSON и Markdown |
| `tests/auth.test.ts` | пароль хранится как проверка; сессия истекает; без входа нет названий разделов; подбор пароля ограничен |
| `tests/http-api.test.ts` | сквозные запросы к приложению без прослушивания порта; коды ошибок и форма тела |

`fixtures/` — синтетические файлы Mac, все дела вымышленные:

| Файл | Содержимое |
|---|---|
| `fixtures/mac-v1-entries-only.json` | только записи дневника |
| `fixtures/mac-v3-notes.json` | записи, планы, заметки |
| `fixtures/mac-v5-steps.json` | задачи с шагами |
| `fixtures/mac-v6-chaos.json` | место хаоса |
| `fixtures/mac-v7-review.json` | «Кому обещано», угроза, «Снято» с причиной |
| `fixtures/mac-v9-note-folder-tree.json` | дерево папок заметок |
| `fixtures/mac-v10-unsupported.json` | версия 10 — должен отклоняться |
| `fixtures/mac-bad-format.json` | `format: "not-daylog"` — должен отклоняться |
| `fixtures/mac-corrupt.json` | обрезанный JSON — должен отклоняться |

## 7. Статика и same-origin

- Сервер раздаёт `client/dist`, если каталог существует; иначе отдаёт `client/index.html`
  и проксирует `/src/*` из `client/src` для разработки с Vite.
- Любой GET вне `/api` и вне статики отдаёт `client/dist/index.html` (SPA-fallback), кроме путей с расширением.
- `GET /api/*` никогда не отдаёт HTML: неизвестный путь API — `404 not_found` в JSON.
- Заголовки ответов: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store` на всех `/api/*`. Этап 2 добавит CSP, HSTS и `noindex` — на этапе 1 их нет.

## 8. Что уже согласовано с фронтендом

Предложения Claude из сообщения 131 приняты без изменений: статика из `client/dist` на том же origin,
API под `/api/*`, httpOnly cookie и 401 на любой `/api` без входа, `GET /api/auth/state`
с двумя булевыми полями, `POST /api/auth/setup|login|logout`, `GET /api/state` одним снимком,
`GET /api/review?date=` всегда шестью группами, атомарный `POST /api/chaos/:id/to-task`,
`POST /api/import` с отчётом `{added, updated, skipped}`, `GET /api/export.json` и `/export.md`,
ошибки `{error:{code,message}}` с русским `message`, календарные даты строками `YYYY-MM-DD` без UTC.

Отличия от черновика Claude, о которых нужно знать:

1. Мутации возвращают изменённые объекты в `data`, а не новый снимок. За полным снимком — `GET /api/state`.
2. Тело ошибки обёрнуто: `{"error":{...}}`, а успешное — `{"ok":true,"data":{...}}`.
3. `review` отдаёт `key` группы рядом с русским `title`, чтобы фронтенд не зависел от текста.
4. Разбор строки — `POST /api/chaos/:id/to-task` и `/to-note`, снятие строки — `DELETE /api/chaos/:id`.
5. Запрос Kimi закрыт разделом 5.10 и переменными `CHAOS_DAY_TESTING`, `CHAOS_DAY_ALLOW_FAULTS`,
   `CHAOS_DAY_DATA_DIR`; импорт синтетических v1/v9 — тот же `POST /api/import`.
6. У задачи есть счётчик правок `revision`. Сохранение шагов присылает его обратно как
   `base_revision` — это защита от затирания чужих правок двумя окнами.
7. Обёртка `{"ok":true,"data":…}` действует для данных. Служебные пути `/api/health` и
   `/api/auth/state|setup|login|logout|password` отвечают плоским JSON, как в черновике Claude.
