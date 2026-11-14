// Правки Markdown вокруг выделения или курсора. Чистые функции без DOM:
// на вход текст и выделение, на выход — какой участок заменить и что выделить после.

export type Edit = {
  /** Заменить value.slice(from, to) на insert. */
  from: number;
  to: number;
  insert: string;
  /** Выделение после правки, в координатах нового текста. */
  selStart: number;
  selEnd: number;
};

export type FormatAction = "heading" | "bold" | "italic" | "strike" | "bullet" | "ordered" | "quote" | "code" | "link";

/** Обернуть выделение маркерами; повторное нажатие снимает их. Без выделения — заготовка. */
function wrap(value: string, start: number, end: number, mark: string, placeholder: string): Edit {
  const sel = value.slice(start, end);
  const m = mark.length;
  // Маркеры уже вокруг выделения — снимаем.
  if (start >= m && value.slice(start - m, start) === mark && value.slice(end, end + m) === mark) {
    return { from: start - m, to: end + m, insert: sel, selStart: start - m, selEnd: end - m };
  }
  // Маркеры внутри выделения — тоже снимаем.
  if (sel.length >= 2 * m && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(m, sel.length - m);
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length };
  }
  // Пробелы по краям выделения остаются снаружи: «**слово** », а не «**слово **».
  const lead = sel.length - sel.trimStart().length;
  const core = sel.trim();
  const trail = sel.length - lead - core.length;
  const body = core || placeholder;
  const insert = sel.slice(0, lead) + mark + body + mark + (trail ? sel.slice(sel.length - trail) : "");
  const s = start + lead + m;
  return { from: start, to: end, insert, selStart: s, selEnd: s + body.length };
}

/** Строки, которых касается выделение: [начало первой, конец последней). */
function lineSpan(value: string, start: number, end: number): [number, number] {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  // Выделение до начала следующей строки эту строку не захватывает.
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nl = value.indexOf("\n", last);
  return [from, nl === -1 ? value.length : nl];
}

const PREFIX: Record<"heading" | "bullet" | "ordered" | "quote", RegExp> = {
  heading: /^#{1,6} /,
  bullet: /^[-*+] /,
  ordered: /^\d+[.)] /,
  quote: /^> ?/,
};

/** Префикс в начале каждой затронутой строки; если он уже у всех — снять. */
function linePrefix(value: string, start: number, end: number, kind: keyof typeof PREFIX): Edit {
  const [from, to] = lineSpan(value, start, end);
  const lines = value.slice(from, to).split("\n");
  const re = PREFIX[kind];
  const content = lines.filter((l) => l.trim());
  const remove = content.length > 0 && content.every((l) => re.test(l));
  let n = 0;
  const out = lines.map((line) => {
    if (remove) return line.replace(re, "");
    if (!line.trim() && lines.length > 1) return line;
    // Другой маркер списка/заголовка заменяем, а не наслаиваем: «- » → «1. ».
    const bare = kind === "quote" ? line : line.replace(PREFIX.bullet, "").replace(PREFIX.ordered, "").replace(PREFIX.heading, "");
    n += 1;
    const p = kind === "heading" ? "## " : kind === "bullet" ? "- " : kind === "ordered" ? `${n}. ` : "> ";
    return p + bare;
  });
  const insert = out.join("\n");
  // Курсор без выделения остаётся в конце строки; иначе выделены все затронутые строки.
  if (start === end && lines.length === 1) {
    const caret = from + insert.length;
    return { from, to, insert, selStart: caret, selEnd: caret };
  }
  return { from, to, insert, selStart: from, selEnd: from + insert.length };
}

function code(value: string, start: number, end: number): Edit {
  const sel = value.slice(start, end);
  if (!sel.includes("\n")) return wrap(value, start, end, "`", "код");
  // Несколько строк — блок кода; ограды на отдельных строках.
  const before = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
  const body = sel.endsWith("\n") ? sel : sel + "\n";
  const insert = `${before}\`\`\`\n${body}\`\`\`` + (value[end] && value[end] !== "\n" ? "\n" : "");
  const s = start + before.length + 4;
  return { from: start, to: end, insert, selStart: s, selEnd: s + body.length - 1 };
}

function link(value: string, start: number, end: number): Edit {
  const sel = value.slice(start, end).trim();
  if (/^(https?:\/\/|mailto:)\S+$/i.test(sel)) {
    const label = "текст ссылки";
    return { from: start, to: end, insert: `[${label}](${sel})`, selStart: start + 1, selEnd: start + 1 + label.length };
  }
  const text = sel || "текст ссылки";
  const url = "https://";
  const insert = `[${text}](${url})`;
  const s = start + text.length + 3;
  return { from: start, to: end, insert, selStart: s, selEnd: s + url.length };
}

export function formatEdit(action: FormatAction, value: string, start: number, end: number): Edit {
  switch (action) {
    case "bold": return wrap(value, start, end, "**", "текст");
    case "italic": return wrap(value, start, end, "_", "текст");
    case "strike": return wrap(value, start, end, "~~", "текст");
    case "code": return code(value, start, end);
    case "link": return link(value, start, end);
    default: return linePrefix(value, start, end, action);
  }
}

export function applyEdit(value: string, e: Edit): string {
  return value.slice(0, e.from) + e.insert + value.slice(e.to);
}
