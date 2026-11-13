/**
 * Ошибка с HTTP-кодом и стабильным кодом для клиента.
 * Сообщения на русском: их можно показывать человеку как есть.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export const MESSAGES = {
  emptyText: (what: string) => `Текст не может быть пустым: ${what}.`,
  invalidDate: (value: unknown) =>
    `Дата «${String(value)}» не подходит. Нужен формат ГГГГ-ММ-ДД и существующий день.`,
  invalidTimestamp: (value: unknown) => `Время «${String(value)}» не распознано.`,
  invalidTimezone: (value: unknown) => `Часовой пояс «${String(value)}» не распознан.`,
  notFound: (what: string) => `${what} не найден.`,
  invalidPassword: 'Пароль должен быть не короче 8 и не длиннее 512 знаков.',
  unauthorized: 'Нужно войти.',
  wrongPassword: 'Неверный пароль.',
  setupAlreadyDone: 'Пароль уже задан. Повторная настройка недоступна.',
  removalReasonRequired: 'Снятие задачи требует короткую причину.',
  taskAlreadyCompleted: 'Задача уже отмечена выполненной.',
  taskNotCompleted: 'Задача не отмечена выполненной.',
  taskIsCompleted: 'Сначала верните выполненную задачу в план.',
  taskIsRemoved: 'Снятую задачу нельзя изменить или выполнить. Сначала верните её в работу.',
  taskIsNotRemoved: 'Задача не снята.',
  parentHasSteps:
    'У задачи есть шаги. Сначала явно удалите их в редакторе шагов и сохраните список.',
  conflictingChanges:
    'Задача или её шаги изменились в другом месте. Загрузите список заново и проверьте шаги перед сохранением.',
  syncConflict: 'Задача изменилась в другом месте. Выберите, какую версию сохранить.',
  invalidSteps: 'Нужны непустые шаги до 500 знаков, не более 100 шагов, без повторов.',
  invalidNextAction:
    'Следующим шагом может быть открытая задача этого проекта со статусом «Можно делать».',
  projectHasOpenTasks: 'Сначала завершите или перенесите открытые задачи проекта.',
  duplicateNoteFolderName: 'Папка с таким именем уже есть у этого родителя.',
  invalidNoteFolderMove: 'Нельзя перенести папку внутрь самой себя.',
  unsupportedFormat: (version: unknown, max: number) =>
    `Файл не читается: версия ${String(version)}, приложение понимает версию до ${max}.`,
  unknownFormat: (format: unknown) => `Файл не читается: неизвестный формат «${String(format)}».`,
  unreadableFile: (reason: string) => `Файл повреждён или это не JSON дневника (${reason}).`,
  unsupportedMediaType: 'Импорт принимает только JSON.',
  payloadTooLarge: 'Файл слишком большой.',
  saveFailed: 'Не удалось сохранить изменение. Операция отменена целиком.',
  methodNotAllowed: (method: string) => `Метод ${method} здесь не поддерживается.`,
  tooManyAttempts: 'Слишком много попыток входа. Попробуйте позже.',
  forbidden: 'Действие недоступно в этом режиме.',
} as const;
