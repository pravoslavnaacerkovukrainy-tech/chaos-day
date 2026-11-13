// «Импорт и экспорт»: файл Mac v1–v9, выгрузка JSON и Markdown, часовой пояс.
import { api, EXPORT_JSON_URL, EXPORT_MD_URL } from "../api.ts";
import { run, snap } from "../app.ts";
import { button, field, h, setChildren } from "../dom.ts";
import type { ImportReport } from "../types.ts";
import { errorText } from "../ui.ts";
import { header } from "./common.ts";

let lastReport: ImportReport | null = null;
let lastError: string | null = null;

const GROUPS: [keyof ImportReport["added"], string][] = [
  ["tasks", "Задачи"], ["projects", "Проекты"], ["chaos", "Место хаоса"],
  ["entries", "Записи дневника"], ["notes", "Заметки"], ["note_folders", "Папки заметок"],
];

export function dataView(): HTMLElement {
  const s = snap();
  const file = h("input", { type: "file", accept: ".json,application/json", testid: "import-file", "aria-label": "Архив.json или entries.json" });
  const overwrite = h("input", { type: "checkbox", testid: "import-overwrite" });
  const result = h("div", { class: "import-result", "aria-live": "polite", testid: "import-result" });
  const submit = button("Импортировать", async () => {
    const f = file.files?.[0];
    if (!f) {
      lastError = "Выберите файл.";
      lastReport = null;
      render();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Импортирую…";
    const text = await f.text();
    lastError = null;
    lastReport = null;
    try {
      lastReport = await api.importFile(text, overwrite.checked ? "overwrite" : "merge");
    } catch (err) {
      lastError = errorText(err);
    }
    await run(async () => undefined, lastReport ? "Импорт завершён" : undefined);
  }, { class: "primary", testid: "import-submit" });

  const render = () => {
    if (lastError) {
      setChildren(result, h("p", { class: "form-error", role: "alert", testid: "import-error" }, lastError));
    } else if (lastReport) {
      const r = lastReport;
      setChildren(result, 
        h("p", { testid: "import-summary" }, `Файл формата v${r.source_version} прочитан. Режим: ${r.mode === "merge" ? "дополнить" : "перезаписать"}.`),
        h("table", { class: "report", testid: "import-report" },
          h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Добавлено"), h("th", null, "Обновлено"), h("th", null, "Без изменений"))),
          h("tbody", null, GROUPS.map(([k, label]) => h("tr", { "data-import-group": k },
            h("th", { scope: "row" }, label),
            h("td", null, String(r.added[k])), h("td", null, String(r.updated[k])), h("td", null, String(r.skipped[k])))))),
        r.warnings.length ? h("ul", { class: "warnings", testid: "import-warnings" }, r.warnings.map((w) => h("li", null, w))) : null,
      );
    } else setChildren(result, );
  };
  render();

  const tz = h("input", { type: "text", value: s.timezone, testid: "timezone-input", "aria-label": "Часовой пояс", list: "tz-list" });
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

  return h("section", { class: "view narrow", "aria-labelledby": "view-title" },
    header("Импорт и экспорт", "view-data"),
    h("section", { class: "panel", "aria-labelledby": "import-title" },
      h("h2", { id: "import-title" }, "Импорт из Mac"),
      h("p", { class: "quiet" }, "Архив.json из экспорта или entries.json, форматы v1–v9. Повторный импорт того же файла не создаёт копий. Более новый неизвестный формат не принимается."),
      field("Файл", file),
      h("label", { class: "check-field" }, overwrite, h("span", null, "Перезаписать совпадающие записи из файла")),
      h("p", { class: "quiet small" }, "Без отметки запись из файла заменяет сохранённую, только если в файле она новее. Импорт ничего не удаляет."),
      h("div", { class: "actions start" }, submit),
      result),
    h("section", { class: "panel", "aria-labelledby": "export-title" },
      h("h2", { id: "export-title" }, "Экспорт"),
      h("p", { class: "quiet" }, "Только сохранённое. Несохранённый текст в полях в файл не попадает."),
      h("div", { class: "actions start" },
        h("a", { class: "button", href: EXPORT_JSON_URL, download: "", testid: "export-json" }, "Скачать JSON"),
        h("a", { class: "button", href: EXPORT_MD_URL, download: "", testid: "export-md" }, "Скачать Markdown"))),
    h("section", { class: "panel", "aria-labelledby": "tz-title" },
      h("h2", { id: "tz-title" }, "Часовой пояс"),
      h("p", { class: "quiet" }, "От него зависит, какой день считается сегодняшним. Сроки — календарные даты и не сдвигаются."),
      h("div", { class: "inline-form" }, tz,
        h("datalist", { id: "tz-list" }, zones.map((z) => h("option", { value: z }))),
        button("Сохранить", () => void run(() => api.setTimezone(tz.value.trim()), "Часовой пояс сохранён"), { testid: "timezone-save" }))),
  );
}
