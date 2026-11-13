/**
 * Выборки методики: чистые функции над уже прочитанными данными.
 * Порядок и состав групп повторяют reviewGroups() Mac-выпуска 0.2.14.
 */
import {
  AT_RISK_STATUSES,
  EMPTY_GROUP_TEXT,
  REVIEW_GROUP_DEFS,
} from './types.ts';
import type {
  ChaosItem,
  DayKey,
  Project,
  ReviewGroup,
  ReviewItem,
  ReviewGroupKey,
  Task,
} from './types.ts';

/** Задача участвует в выборках: не выполнена и не снята. */
export function isOpen(task: Task): boolean {
  return task.completed_at === null && task.status !== 'removed';
}

function isAtRiskVisible(task: Task): boolean {
  return task.at_risk && (AT_RISK_STATUSES as readonly string[]).includes(task.status);
}

/** Каноничный порядок задач: день, затем время создания, затем id. */
export function planOrder(a: Task, b: Task): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return compareIds(a.id, b.id);
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sortPlans(list: readonly Task[]): Task[] {
  return [...list].sort(planOrder);
}

function byReviewDateThenPlan(a: Task, b: Task): number {
  const left = a.review_date;
  const right = b.review_date;
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return left < right ? -1 : 1;
  }
  return planOrder(a, b);
}

/**
 * «Сегодня»: назначенные на сегодня и оставшиеся с прошлых дней, с наступившим сроком
 * результата и отмеченные «Обещание под угрозой». Отложенное дело видно только с отметкой.
 */
export function tasksForToday(tasks: readonly Task[], today: DayKey): Task[] {
  return sortPlans(
    tasks.filter((task) => {
      if (!isOpen(task)) return false;
      if (isAtRiskVisible(task)) return true;
      if (task.status === 'paused') return false;
      if (task.day !== '' && task.day <= today) return true;
      if (task.deadline === null) return false;
      return task.deadline <= today;
    }),
  );
}

/** В другие дни видны назначенные задачи и сроки ровно на выбранную дату. */
export function tasksForDay(tasks: readonly Task[], day: DayKey, today: DayKey): Task[] {
  if (day === today) return tasksForToday(tasks, today);
  return sortPlans(
    tasks.filter((task) => {
      if (!isOpen(task)) return false;
      if (task.status === 'paused') return false;
      if (task.day === day) return true;
      return task.deadline !== null && task.deadline === day;
    }),
  );
}

/**
 * Выборка угрозы. Отметку ставит и снимает только человек: приложение её не вычисляет,
 * не меняет статус и даты и не ранжирует остальные дела.
 */
export function tasksAtRisk(tasks: readonly Task[]): Task[] {
  return sortPlans(tasks.filter((task) => isOpen(task) && isAtRiskVisible(task)));
}

export function waitingTasks(tasks: readonly Task[]): Task[] {
  return sortPlans(tasks.filter((task) => isOpen(task) && task.status === 'waiting'));
}

/** «Все задачи»: снятые и выполненные скрыты, пока человек не включит их показ. */
export function visibleTasks(
  tasks: readonly Task[],
  showCompleted = false,
  showRemoved = false,
): Task[] {
  return sortPlans(
    tasks.filter(
      (task) =>
        (showCompleted || task.completed_at === null) &&
        (showRemoved || task.status !== 'removed'),
    ),
  );
}

function taskItem(task: Task): ReviewItem {
  return { kind: 'task', id: task.id, title: task.text, task, project: null };
}

function projectItem(project: Project): ReviewItem {
  return { kind: 'project', id: project.id, title: project.title, task: null, project };
}

function isDue(day: DayKey | null, today: DayKey): boolean {
  return day !== null && day <= today;
}

/**
 * Порядок пересмотра: шесть групп, дело попадает только в первую подходящую.
 * Выполненные задачи, снятые задачи и архивные проекты исключены.
 * Групп всегда шесть: пустая остаётся на оси с пометкой «Сейчас здесь ничего нет».
 */
export function reviewGroups(
  tasks: readonly Task[],
  projects: readonly Project[],
  today: DayKey,
): ReviewGroup[] {
  const open = sortPlans(tasks.filter(isOpen));
  const activeProjects = projects.filter((project) => !project.archived);
  const placed = new Set<string>();
  const buckets = new Map<ReviewGroupKey, ReviewItem[]>();
  for (const def of REVIEW_GROUP_DEFS) buckets.set(def.key, []);

  /** Кладёт задачи в группу, пропуская уже занятые: первое совпадение побеждает. */
  const into = (key: ReviewGroupKey) => {
    const items = buckets.get(key);
    return (list: readonly Task[]): void => {
      for (const task of list) {
        if (placed.has(task.id)) continue;
        placed.add(task.id);
        items?.push(taskItem(task));
      }
    };
  };

  const promised = open.filter((task) => task.promised_to !== null && task.promised_to !== '');

  // 1. Обещания со сроком: ближайшие раньше.
  into('promised_with_deadline')(
    [...promised]
      .filter((task) => task.deadline !== null)
      .sort((a, b) => {
        const left = a.deadline as string;
        const right = b.deadline as string;
        if (left !== right) return left < right ? -1 : 1;
        return planOrder(a, b);
      }),
  );

  // 2. Обещания без срока: дату не выдумываем.
  into('promised_without_deadline')(promised.filter((task) => task.deadline === null));

  // 3. Остальные дела под угрозой.
  into('at_risk')(open.filter(isAtRiskVisible));

  // 4. Дела на сегодня и следующий шаг проектов.
  const scheduled = open.filter(
    (task) => task.status !== 'paused' && task.day !== '' && task.day <= today,
  );
  const nextStepIds = new Set(
    activeProjects.map((project) => project.next_action_id).filter((id): id is string => id !== null),
  );
  into('today_and_next_steps')(scheduled);
  into('today_and_next_steps')(open.filter((task) => nextStepIds.has(task.id)));

  // 5. Ожидания с названным условием продолжения.
  into('waiting')(
    open
      .filter(
        (task) =>
          task.status === 'waiting' && task.waiting_for !== null && task.waiting_for !== '',
      )
      .sort(byReviewDateThenPlan),
  );

  // 6. Наступившая дата пересмотра и проекты без следующего шага.
  into('review')(
    open.filter((task) => isDue(task.review_date, today)).sort(byReviewDateThenPlan),
  );
  const dueProjects = activeProjects
    .filter((project) => project.next_action_id === null || isDue(project.review_date, today))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'))
    .map(projectItem);
  buckets.get('review')?.push(...dueProjects);

  return REVIEW_GROUP_DEFS.map((def) => {
    const items = buckets.get(def.key) ?? [];
    return {
      key: def.key,
      title: def.title,
      items,
      is_empty: items.length === 0,
      empty_text: EMPTY_GROUP_TEXT,
    };
  });
}

/** Приводит строку к виду, в котором регистр и диакритика не мешают поиску. */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function hits(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack || haystack === '') return false;
  return fold(haystack).includes(needle);
}

export interface OrganizerSearchResults {
  tasks: Task[];
  projects: Project[];
  chaos: ChaosItem[];
}

/**
 * Один поиск по делам: открытые задачи (текст, подробности, ожидание, адресат обещания),
 * неархивные проекты (название, результат, неопределённость) и строки места хаоса.
 * Выполненные и снятые задачи попадают в выдачу только по явному переключателю.
 */
export function searchOrganizer(
  query: string,
  tasks: readonly Task[],
  projects: readonly Project[],
  chaos: readonly ChaosItem[],
  includeCompleted = false,
  includeRemoved = false,
): OrganizerSearchResults {
  const trimmed = query.trim();
  if (trimmed === '') return { tasks: [], projects: [], chaos: [] };
  const needle = fold(trimmed);

  const foundTasks = sortPlans(
    tasks.filter((task) => {
      if (!includeCompleted && task.completed_at !== null) return false;
      if (!includeRemoved && task.status === 'removed') return false;
      return (
        hits(task.text, needle) ||
        hits(task.details, needle) ||
        hits(task.waiting_for, needle) ||
        hits(task.promised_to, needle)
      );
    }),
  );

  const foundProjects = projects
    .filter(
      (project) =>
        !project.archived &&
        (hits(project.title, needle) ||
          hits(project.outcome, needle) ||
          hits(project.uncertainty, needle)),
    )
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));

  const foundChaos = chaos.filter((item) => hits(item.text, needle));

  return { tasks: foundTasks, projects: foundProjects, chaos: foundChaos };
}
