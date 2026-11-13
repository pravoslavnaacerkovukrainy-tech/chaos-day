# Приёмка синхронизации нового Mac-клиента

Сценарий использует только вымышленную задачу, отдельные каталоги данных и сервер на `127.0.0.1`. Он не предназначен для установленного приложения или существующего хранилища.

## Подготовка

Переменные указывают на три изолированных worktree. Порт и корень временных данных выбираются заново для каждого прогона.

```bash
export QA_DIR="$HOME/Documents/ChatGPT/Веб-версия Хаоса дня/chaos-day-worktrees/mac-sync-qa"
export SERVER_DIR="$HOME/Documents/ChatGPT/Веб-версия Хаоса дня/chaos-day-worktrees/mac-sync-server"
export CLIENT_DIR="$HOME/Documents/ChatGPT/Веб-версия Хаоса дня/chaos-day-worktrees/mac-sync-client"
export RUN_DIR="$(mktemp -d /tmp/chaos-day-mac-sync.XXXXXX)"
export PORT=3310
export BASE_URL="http://127.0.0.1:$PORT"
export CHAOS_SYNC_PASSWORD='acceptance-only-2026'
export MAC_SYNC_CLI="$CLIENT_DIR/build/plan/chaos-sync"
```

Собрать новый клиент и его CLI:

```bash
cd "$CLIENT_DIR"
./plan-client/test.sh
```

Запустить сервер с пустой временной базой:

```bash
cd "$SERVER_DIR"
HOST=127.0.0.1 PORT="$PORT" \
CHAOS_DAY_DATA_DIR="$RUN_DIR/server" \
CHAOS_DAY_TIMEZONE=Europe/Kyiv CHAOS_DAY_TESTING=1 \
npm run dev
```

В другой оболочке создать тестовую учётную запись:

```bash
curl -sS -c "$RUN_DIR/cookies" -H 'Content-Type: application/json' \
  --data '{"password":"acceptance-only-2026","timezone":"Europe/Kyiv"}' \
  "$BASE_URL/api/dev/bootstrap"
```

Открыть `$BASE_URL` в обычном браузере и войти с паролем `acceptance-only-2026`. Этот пароль относится только к временной базе.

## Основной сценарий

1. В веб-интерфейсе открыть «Место хаоса», записать `Синтетическая задача Mac sync`, выбрать «Это задача», задать день `2026-11-14` и подробности `Исходные подробности`, сохранить.
2. Получить задачу на Mac и найти ровно одну запись с этим текстом:

   ```bash
   "$MAC_SYNC_CLI" --data "$RUN_DIR/mac-a" --server "$BASE_URL" pull
   "$MAC_SYNC_CLI" --data "$RUN_DIR/mac-a" list
   ```

   Сохранить UUID из JSON как `TASK_ID`.

3. Выключить связь в клиенте и изменить только день:

   ```bash
   "$MAC_SYNC_CLI" --data "$RUN_DIR/mac-a" offline on
   "$MAC_SYNC_CLI" --data "$RUN_DIR/mac-a" edit "$TASK_ID" --day 2026-11-15
   "$MAC_SYNC_CLI" --data "$RUN_DIR/mac-a" status
   ```

   Ожидание: локальный `list` показывает `2026-11-15`, очередь содержит одну правку, на сервере остаётся `2026-11-14`.

4. Остановить сервер. Завершить CLI, затем отдельными процессами снова выполнить `list` и `status`. Это перезапуск общего SyncCore с тем же каталогом данных; очередь и локальная дата должны сохраниться.
5. Разрешить отправку при остановленном сервере:

   ```bash
   "$MAC_SYNC_CLI" --data "$RUN_DIR/mac-a" offline off
   "$MAC_SYNC_CLI" --data "$RUN_DIR/mac-a" push
   "$MAC_SYNC_CLI" --data "$RUN_DIR/mac-a" status
   ```

   Ожидание: ошибка соединения, очередь не очищена.

6. Запустить сервер с прежним `$RUN_DIR/server`, повторить `push`. Обновить браузер и открыть день `2026-11-15`.
7. Проверить результат независимо через протокол:

   ```bash
   curl -sS -b "$RUN_DIR/cookies" \
     "$BASE_URL/api/tasks?show_completed=1&show_removed=1"
   curl -sS -b "$RUN_DIR/cookies" "$BASE_URL/api/tasks/$TASK_ID"
   ```

   Ожидание: тот же UUID, день `2026-11-15`, исходные текст и подробности, ровно одна задача в Mac и браузере. Повторный `push` без новых изменений не увеличивает `revision`.

## Независимые поля

1. Создать вторую синтетическую задачу и выполнить `pull` в два разных каталога: `mac-a` и `mac-b`.
2. В `mac-b` выполнить `edit ID --text 'Правка браузерной стороны'`, затем `push`.
3. В `mac-a` без нового `pull` выполнить `edit ID --day 2026-11-15 --details 'Правка Mac'`, затем `push`.
4. Ожидание: HTTP 200; текст от второго клиента сохранён, день и подробности применены от первого. Ни одно поле не потеряно.

## Конфликт одного поля

Для каждого варианта разрешения использовать новую задачу и два каталога с одинаковым исходным `pull`.

**Моя версия:**

1. В `mac-a`: `edit ID --day 2026-11-15`.
2. В `mac-b`: `edit ID --day 2026-11-16`, `push`.
3. В `mac-a`: `push` должен завершиться кодом 3 и конфликтом `day`; серверная задача и остальные поля не меняются.
4. `resolve ID day mine`, затем `push`.
5. Ожидание: локальное значение `2026-11-15` записано с базой, полученной из конфликта; очередь очищена, копий нет.

**Версия сервера:**

1. Повторить конфликт на поле `text` с разными значениями.
2. В проигравшем клиенте: `resolve ID text server`.
3. Ожидание: локальная правка `text` удалена, видно значение сервера, соответствующая очередь и конфликт очищены. Другие независимые локальные поля, если они были, сохраняются.

## Очередь при других ошибках

- При неверном `CHAOS_SYNC_PASSWORD` `push` получает 401; последующий `status` обязан показывать прежнюю правку. После восстановления пароля она отправляется без повторного ввода.
- Если задачу удалили на сервере, `push` получает 404; правка остаётся в очереди до `discard ID` или другого явного решения.
- При 409 конфликт и локальная правка сохраняются до `resolve`; автоматического затирания нет.

## Тёмная и светлая темы Mac

После появления команды запуска UI использовать тот же изолированный каталог, что и CLI. По очереди выбрать тёмную и светлую темы, проверить читаемость основного списка и редактора, полностью завершить и заново запустить приложение. Выбранная тема должна сохраниться. Этот пункт относится к Mac UI; успешные CLI-проверки его не заменяют.

## Автоматический прогон

Когда коммиты клиента и сервера готовы, основной сценарий, конфликты и ошибки очереди запускаются одной командой. Тест сам создаёт новый временный каталог и управляет отдельным серверным процессом; заранее запущенный сервер на выбранном порту не нужен.

```bash
cd "$QA_DIR/acceptance"
ACCEPTANCE_EXTERNAL_SERVER=1 ACCEPTANCE_BASE_URL="$BASE_URL" \
MAC_SYNC_CLI="$MAC_SYNC_CLI" MAC_SYNC_SERVER_DIR="$SERVER_DIR" \
npx playwright test tests/mac-sync.spec.ts --project=chrome
```

Отдельная проверка HTTP-контракта без Mac CLI:

```bash
cd "$QA_DIR/acceptance"
ACCEPTANCE_BASE_URL="$BASE_URL" ACCEPTANCE_SERVER_DIR="$SERVER_DIR" \
CHAOS_DAY_DATA_DIR="$RUN_DIR/api" \
npx playwright test tests/sync-api.spec.ts --project=chrome
```
