// Чистые функции без сети: разбор словника, разбор страниц скана, сопоставление, проверки.

export type Entry = {
  seq: number;
  title: string;      // название страницы без префикса БСЭ1/
  head: string;       // заглавное слово статьи, по нему ищется секция
  cols: string;
  colStart?: number;
  colEnd?: number;
  authors: string[];
  linked: boolean;    // false: в словнике нет ссылки, по инструкции проекта это обычно защищённая статья
};

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function parseCols(cols: string) {
  const m = cols.match(/(\d+)(?:\s*[—–-]\s*(\d+))?/);
  if (!m) return {};
  return { colStart: Number(m[1]), colEnd: Number(m[2] ?? m[1]) };
}

export function parseSlovnik(wikitext: string): { entries: Entry[]; unparsed: string[] } {
  const text = wikitext.replace(/<!--[\s\S]*?-->/g, "");
  // Элемент списка может занимать несколько строк: шаблон авторов переносится.
  const items: string[] = [];
  let open = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("*")) { items.push(line); open = true; continue; }
    if (open && (items.at(-1)!.split("{{").length > items.at(-1)!.split("}}").length)) { items[items.length - 1] += " " + line; continue; }
    open = false;
  }
  const entries: Entry[] = [];
  const unparsed: string[] = [];
  for (const raw of items) {
    const authors: string[] = [];
    const item = raw.replace(/\{\{\s*БСЭ1\/Автор статьи в словнике\s*\|([^{}]*)\}\}/g, (_, a: string) => {
      for (const part of a.split("|")) {
        const name = clean(part.replace(/^\s*автор\d*\s*=/, ""));
        if (name) authors.push(name);
      }
      return " ";
    }).replace(/^\*+\s*/, "").trim();

    let title = "", head = "", cols = "", linked = true;
    const tpl = item.match(/\{\{\s*Статья в словнике\d?\s*\|([^{}]*)\}\}/);
    const wikilink = item.match(/\[\[БСЭ1\/([^\]|]+)(?:\|([^\]]*))?\]\]\s*(?:''([^']*)'')?/);
    // Строка без ссылки. Встречаются «''164—168'» с опечаткой и пометка {{БСЭ1/АП-мини}} в начале.
    const plain = item.replace(/^\{\{\s*БСЭ1\/АП-мини[^{}]*\}\}\s*/, "").match(/^([^{}]*?)\s*''([^']*)'/);
    if (tpl) {
      const p = tpl[1].split("|").map(clean);
      title = p[0];
      head = p[1] && !/^\d/.test(p[1]) ? p[1] : "";
      cols = p.slice(1).find((x) => /^\d+(\s*[—–-]\s*\d+)?$/.test(x)) ?? "";
    } else if (wikilink) {
      title = clean(wikilink[1]);
      head = clean(wikilink[2] ?? "");
      cols = clean(wikilink[3] ?? "");
    } else if (plain) {
      title = clean(plain[1]);
      cols = clean(plain[2]);
      linked = false;
    } else {
      unparsed.push(raw);
      continue;
    }
    if (!title) { unparsed.push(raw); continue; }
    if (!head) head = title.split(",")[0];
    // «Радичевич1» в словнике: цифра — сноска или опечатка, в заголовке статьи её нет.
    head = clean(head).replace(/(?<=[а-яё»])\d+$/i, "");
    entries.push({ seq: entries.length + 1, title, head, cols, authors, linked, ...parseCols(cols) });
  }
  return { entries, unparsed };
}

// ---------- страницы скана ----------

export type Page = { file: string; n: number; content: string };
// weak: это не секция, а слово прописными в тексте. Так найдены статьи, которым секцию не поставили.
export type Section = { name: string; offset: number; weak?: boolean };
// Значок {{tq|3}} ставится после вычитанной статьи, вне секций, и в статью не включается.
const TQ_MARK = /[ \t]*\{\{\s*tq\s*\|\s*\d\s*\}\}/gi;
export type Stream = {
  text: string;
  sections: Section[];
  pageAt: { offset: number; file: string; n: number; quality: string }[];
};

// Склеивает страницы тома в один текст, запоминая начало каждой страницы и секции.
export function buildStream(pages: Page[]): Stream {
  let text = "";
  const sections: Section[] = [];
  const pageAt: Stream["pageAt"] = [];
  for (const p of pages) {
    const quality = p.content.match(/pagequality level="(\d)"/)?.[1] ?? "-";
    const body = p.content.replace(/<noinclude>[\s\S]*?<\/noinclude>/g, "").replace(TQ_MARK, "").trim();
    // Перенос слова между страницами: «фон-» + «ды» = «фонды».
    if (/[а-яё]-$/i.test(text) && /^[а-яё]/.test(body)) text = text.slice(0, -1);
    else if (text) text += " ";
    pageAt.push({ offset: text.length, file: p.file, n: p.n, quality });
    let last = 0;
    for (const m of body.matchAll(/<section\s+(begin|end)="([^"]*)"\s*\/>/g)) {
      text += body.slice(last, m.index);
      last = m.index! + m[0].length;
      if (m[1] === "begin") sections.push({ name: m[2], offset: text.length });
    }
    text += body.slice(last);
  }
  return { text, sections: withCapsHeadings(text, sections), pageAt };
}

// Часть статей не получила секцию, потому что заголовок распознан без жирного шрифта
// или слипся с соседним столбцом: «Лейпцигский универРАДИУС, расстояние...».
function withCapsHeadings(text: string, sections: Section[]): Section[] {
  const out = [...sections];
  const begins = sections.map((s) => s.offset);
  let k = 0;
  for (const m of text.matchAll(/«?[А-ЯЁ]{2}[А-ЯЁ-]+(?: +[А-ЯЁ]{2,}[А-ЯЁ-]*)*»?/g)) {
    while (k < begins.length && begins[k] < m.index - 6) k++;
    // Заголовок сразу за началом настоящей секции — это та же статья.
    if (k < begins.length && begins[k] <= m.index && m.index - begins[k] <= 6) continue;
    out.push({ name: m[0], offset: m.index, weak: true });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

export const norm = (s: string) =>
  s.toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z0-9]+/g, " ").trim();

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const MIN_SIMILARITY = 0.7;

export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const long = Math.max(a.length, b.length), short = Math.min(a.length, b.length);
  // Секция могла получить только первое слово заголовка, и наоборот.
  const prefix = short >= 4 && (a.startsWith(b + " ") || b.startsWith(a + " ")) ? 0.8 : 0;
  if (short / long < 0.5) return prefix;
  return Math.max(prefix, 1 - levenshtein(a, b) / long);
}

// Сопоставляет статьи словника с секциями с сохранением порядка (динамическое программирование).
// Лишние секции (жирный текст внутри статьи: «сша», «иус.») остаются частью текущей статьи.
// Возвращает для каждой статьи номер секции или -1.
export function align(entries: Entry[], sections: Section[]): number[] {
  const intern = (list: string[]) => {
    const ids = new Map<string, number>();
    return { ids: list.map((s) => ids.get(s) ?? (ids.set(s, ids.size), ids.size - 1)), uniq: [...ids.keys()] };
  };
  const E = intern(entries.map((e) => norm(e.head))), S = intern(sections.map((s) => norm(s.name)));
  const n = E.ids.length, m = S.ids.length, w = m + 1;
  const best = new Float64Array((n + 1) * w);
  const from = new Uint8Array((n + 1) * w); // 1 — пропуск статьи, 2 — пропуск секции, 3 — пара
  const memo = new Float32Array(E.uniq.length * S.uniq.length).fill(-1);
  // Секция, названная полным названием из словника («уде, фриц, фон»), — точное совпадение. Иначе короткий
  // заголовок («Уде», «Диц») не находит её: сравнение по началу имени разрешено только с 4 букв.
  const titles = entries.map((e) => norm(e.title));
  const score = (i: number, j: number) => {
    if (titles[i] && titles[i] === S.uniq[S.ids[j]] && !sections[j].weak) return 1;
    const k = E.ids[i] * S.uniq.length + S.ids[j];
    if (memo[k] < 0) memo[k] = similarity(E.uniq[E.ids[i]], S.uniq[S.ids[j]]);
    // Слишком слабое сходство не считается совпадением. Настоящая секция важнее слова прописными.
    return memo[k] >= MIN_SIMILARITY ? memo[k] * (sections[j].weak ? 0.9 : 1) : -1;
  };
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let v = best[(i - 1) * w + j], f = 1;
      if (best[i * w + j - 1] > v) { v = best[i * w + j - 1]; f = 2; }
      const s = score(i - 1, j - 1);
      if (s > 0 && best[(i - 1) * w + j - 1] + s > v) { v = best[(i - 1) * w + j - 1] + s; f = 3; }
      best[i * w + j] = v;
      from[i * w + j] = f;
    }
  }
  const out = new Array<number>(n).fill(-1);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const f = from[i * w + j];
    if (f === 3) { out[--i] = --j; }
    else if (f === 2) j--;
    else i--;
  }
  return out;
}

// ---------- проверки текста ----------

const NAME = "[А-ЯЁ][а-яё]+(?:-[А-ЯЁ]?[а-яё]+)?";
const INITIAL = "(?!С[мр]\\.)[А-ЯЁ][а-яё]?\\."; // «См. Глаз.» и «Ср. ...» — отсылки, а не подписи
const SIGNATURE_LINE = new RegExp(
  `^\\s*(?:(?:${INITIAL}\\s*){1,3}(?:${NAME})?|${NAME}\\s+(?:${INITIAL}\\s*){1,2})\\s*\\.?\\s*$`,
);
const SIGNATURE_TAIL = new RegExp(`[.)»!?…]\\s+((?:${INITIAL}\\s*){1,3}(?:${NAME})?)\\s*\\.?\\s*$`);

// Признак подписи автора. Шаблон — точный признак; остальное — похожее на подпись.
export function findSignature(text: string): { sure: boolean; sample: string } | null {
  const tpl = text.match(/\{\{\s*БСЭ1\/Автор[^{}]*\}\}/);
  if (tpl) return { sure: true, sample: tpl[0] };
  const ap = text.match(/\{\{\s*АП[- ][^{}]*\}\}/);
  if (ap) return { sure: true, sample: ap[0] };
  const right = text.match(/\{\{\s*right\|[^{}]*\}\}/);
  if (right) return { sure: false, sample: right[0] };
  for (const line of text.split("\n")) {
    if (line.trim() && line.length <= 60 && SIGNATURE_LINE.test(line)) return { sure: false, sample: line.trim() };
  }
  const tail = text.trimEnd().match(SIGNATURE_TAIL);
  if (tail) return { sure: false, sample: tail[0].trim() };
  return null;
}

export function findComplex(text: string): string[] {
  const out: string[] = [];
  if (/\{\||<table/i.test(text)) out.push("таблица");
  if (/<math|<chem|<ce>|<f[ >]/i.test(text)) out.push("формула");
  if (/\[\[(Файл|Изображение|File|Image):|\{\{\s*(Img|Ifloat|Lfloat|Rfloat)\b/i.test(text)) out.push("иллюстрация");
  return out;
}

export const words = (s: string): string[] =>
  s.replace(/<[^>]+>/g, " ")
    .replace(/\{\{razr2?\|([^}]*)\}\}/g, "$1")
    .replace(/\{\{lsafe\|(?:[^|}]*\|)?([^}]*)\}\}/g, "$1")
    .toLowerCase().match(/[а-яёa-z0-9]+/g) ?? [];

function commonWords(a: string[], b: string[]): number {
  const count = new Map<string, number>();
  for (const w of b) count.set(w, (count.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of a) {
    const c = count.get(w) ?? 0;
    if (c > 0) { common++; count.set(w, c - 1); }
  }
  return common;
}

// Какая доля слов разошлась между исправленным и распознанным текстом.
export function changedShare(fixed: string, ocr: string): number {
  const a = words(fixed), b = words(ocr);
  if (!a.length || !b.length) return 1;
  return 1 - commonWords(a, b) / Math.max(a.length, b.length);
}

// ---------- включение вычитанных страниц через <pages> ----------

export type TranscludePlan = { index: string; from: number; to: number; section: string };
export type PlanResult = { plan: TranscludePlan; text: string } | {
  problem: string;
  code: "no_pages" | "multiple_indexes" | "nonconsecutive_pages" | "nested_section" | "invalid_section_tag"
    | "invalid_section_start" | "duplicate_section_end" | "section_end_mismatch" | "invalid_section_order" | "text_outside_section";
};

export const STRICT_TAG = /<section\s+(begin|end)="([^"]*)"\s*\/>/g;
const pageBody = (content: string) => content.replace(/<noinclude>[\s\S]*?<\/noinclude>/g, "");
const isBlank = (s: string) => !s.replace(STRICT_TAG, "").replace(TQ_MARK, "").replace(/\{\{\s*nop\s*\}\}/gi, "").trim();

// Тег <pages> берёт с первой страницы секцию целиком, а с последней всё до её конца. Если на странице
// нет закрывающего тега с тем же именем, в статью попадает текст до конца страницы, то есть начало
// следующей статьи. Секции с одним именем выводятся все сразу. Поэтому план составляется только
// при однозначной разметке, остальное остаётся человеку.
export function planTransclusion(section: string, pages: Page[], innerSections = 0): PlanResult {
  if (!pages.length) return { code: "no_pages", problem: "нет страниц" };
  if (new Set(pages.map((p) => p.file)).size > 1) return { code: "multiple_indexes", problem: "статья переходит в другой файл индекса" };
  if (pages.some((p, i) => i > 0 && p.n !== pages[i - 1].n + 1)) return { code: "nonconsecutive_pages", problem: "страницы идут не подряд" };
  if (innerSections > 0) return { code: "nested_section", problem: `внутри статьи есть другие секции: ${innerSections}` };

  const bodies = pages.map((p) => pageBody(p.content));
  const tags = bodies.map((b) => [...b.matchAll(STRICT_TAG)]);
  if (bodies.some((b, i) => (b.match(/<section\b/g) ?? []).length !== tags[i].length)) return { code: "invalid_section_tag", problem: "тег секции нестандартного вида" };
  const named = (kind: string) => tags.flatMap((list, page) => list.filter((m) => m[1] === kind && m[2] === section).map((m) => ({ page, m })));
  const begins = named("begin"), ends = named("end");
  if (begins.length !== 1 || begins[0].page !== 0) return { code: "invalid_section_start", problem: "секция начинается не один раз или не на первой странице" };
  if (!ends.length) return { code: "section_end_mismatch", problem: "нет закрывающего тега с тем же именем" };
  if (ends.length !== 1) return { code: "duplicate_section_end", problem: "секция закрывается несколько раз" };
  const beginTag = begins[0].m, endTag = ends[0].m, last = ends[0].page;
  if (last === 0 && endTag.index! < beginTag.index!) return { code: "invalid_section_order", problem: "закрывающий тег стоит раньше открывающего" };

  const between = last === 0
    ? tags[0].filter((m) => m.index! > beginTag.index! && m.index! < endTag.index!).length
    : tags[0].filter((m) => m.index! > beginTag.index!).length
      + tags.slice(1, last).reduce((s, list) => s + list.length, 0)
      + tags[last].filter((m) => m.index! < endTag.index!).length;
  if (between) return { code: "nested_section", problem: "между началом и концом секции есть другие теги" };

  const afterEnd = bodies[last].slice(endTag.index! + endTag[0].length);
  const nextBegin = afterEnd.search(/<section\s+begin=/);
  if (!isBlank(nextBegin >= 0 ? afterEnd.slice(0, nextBegin) : afterEnd)) return { code: "text_outside_section", problem: "после конца секции есть текст вне секций" };
  for (const body of bodies.slice(last + 1)) {
    const firstBegin = body.search(/<section\s+begin=/);
    if (!isBlank(firstBegin >= 0 ? body.slice(0, firstBegin) : body)) return { code: "text_outside_section", problem: "после конца секции есть текст вне секций" };
  }

  const start = beginTag.index! + beginTag[0].length;
  const pieces = last === 0
    ? [bodies[0].slice(start, endTag.index!)]
    : [bodies[0].slice(start), ...bodies.slice(1, last), bodies[last].slice(0, endTag.index!)];
  let text = "";
  for (const piece of pieces.map((s) => s.trim())) {
    if (/[а-яё]-$/i.test(text) && /^[а-яё]/.test(piece)) text = text.slice(0, -1);
    else if (text) text += " ";
    text += piece;
  }
  return { plan: { index: pages[0].file, from: pages[0].n, to: pages[last].n, section }, text };
}

export const renderPagesTag = (p: TranscludePlan) =>
  `<pages index="${p.index}" from=${p.from} to=${p.to} fromsection="${p.section}" tosection="${p.section}" />`;

// Слова текста, как их увидит читатель: разворачивает шаблоны, ссылки и служебные сущности.
// Разметка таблиц читателю не видна: атрибуты ячеек (style, colspan) и служебные строки убираются.
const dropTableMarkup = (s: string) =>
  s.replace(/^\s*\{\|.*$|^\s*\|\}\s*$|^\s*\|-.*$/gm, " ")
    .replace(/(?:^|\|\||!!|^[|!])\s*[a-z-]+="[^"\n]*"(?:\s+[a-z-]+="[^"\n]*")*\s*\|(?!\|)/gm, " ")
    .replace(/\|\||!!/g, " ")
    .replace(/^[|!]/gm, " ");

export const readerWords = (wikitext: string): string[] =>
  words(dropTableMarkup(wikitext)
    .replace(STRICT_TAG, " ")
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, " ")
    .replace(/\{\{\s*перенос2?\s*\|([^|{}]*)\|([^|{}]*)[^{}]*\}\}/gi, "$1$2")
    .replace(/\{\{\s*lsafe\s*\|(?:[^|{}]*\|)?(?:БСЭ1\/)?([^|{}]*)\}\}/gi, "$1")
    .replace(/\{\{[^|{}]*\}\}/g, " ")
    .replace(/\{\{[^|{}]*\|/g, " ")
    .replace(/\}\}/g, " ")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1"));

const htmlWords = (html: string): string[] =>
  words(html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<span class="[^"]*pagenumber[^"]*"[^>]*>.*?<\/span>/g, " ")
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, " "));

// Примечания редакторов Викитеки не часть текста БСЭ: в вики-тексте они стоят посреди статьи, а на сайте
// уходят в список в конце и сдвигают последние слова. При сверке их убирают с обеих сторон.
// Так же и сноски самой книги (<ref>): сайт сам дописывает их список в конец статьи (т. 43, «Октябрьская революция»).
const dropEditorNotes = (wikitext: string) =>
  wikitext
    .replace(/\{\{\s*Примечание ВТ\s*\|[^{}]*(?:\{\{[^{}]*\}\}[^{}]*)*\}\}/gi, " ")
    .replace(/\{\{\s*Примечания ВТ\s*\}\}/gi, " ")
    .replace(/<ref(?:\s[^>]*)?>[\s\S]*?<\/ref>/g, " ");
const dropRenderedNotes = (html: string) =>
  html
    .replace(/<sup[^>]*class="reference"[^>]*>[\s\S]*?<\/sup>/g, " ")
    .replace(/<div class="mw-heading[^"]*"><h2 id="Примечания_редакторов_Викитеки"[\s\S]*?<\/ol>/g, " ")
    .replace(/<ol class="references">[\s\S]*?<\/ol>/g, " ");

const MIN_PROOFREAD_LEVEL = 3;
const ALLOWED_WORD_DIFF = 2;
const ALLOWED_DIFF_SHARE = 0.02;

// Сверяет готовый HTML от action=parse с ожидаемым текстом и номерами страниц. Возвращает список расхождений.
export function checkRendered(expected: string, html: string, plan: TranscludePlan, minLevel = MIN_PROOFREAD_LEVEL): string[] {
  const problems: string[] = [];
  if (/class="[^"]*\berror\b/.test(html)) problems.push("сайт показал ошибку разметки");
  // Номер страницы файла берётся из data-page-index: data-page-number — подпись из разметки индекса,
  // в т. 53 там номера столбцов («75-76» для стр. 39). Старые ответы без data-page-index читаются по data-page-number.
  const shown = [...html.matchAll(/<span[^>]*data-page-number="([^"]*)"[^>]*data-page-quality="(\d)"[^>]*>/g)].map((m) => {
    const index = m[0].match(/data-page-index="(\d+)"/)?.[1];
    return { n: Number(index ?? m[1]), level: Number(m[2]) };
  });
  const want = Array.from({ length: plan.to - plan.from + 1 }, (_, i) => plan.from + i);
  if (shown.map((s) => s.n).join() !== want.join()) problems.push(`показаны страницы ${shown.map((s) => s.n).join(",") || "нет"} вместо ${want.join(",")}`);
  const low = shown.filter((s) => s.level < minLevel);
  if (low.length) problems.push(`уровень ниже ${minLevel}: ${low.map((s) => `стр. ${s.n}`).join(", ")}`);
  const e = readerWords(dropEditorNotes(expected)), r = htmlWords(dropRenderedNotes(html));
  if (!r.length) { problems.push("пустой результат"); return problems; }
  const edge = (w: string[]) => [w.slice(0, 2).join(" "), w.slice(-2).join(" ")];
  if (edge(e)[0] !== edge(r)[0]) problems.push(`другое начало: «${edge(r)[0]}» вместо «${edge(e)[0]}»`);
  if (edge(e)[1] !== edge(r)[1]) problems.push(`другой конец: «${edge(r)[1]}» вместо «${edge(e)[1]}»`);
  const diff = Math.max(e.length, r.length) - commonWords(e, r);
  if (diff > Math.max(ALLOWED_WORD_DIFF, e.length * ALLOWED_DIFF_SHARE)) problems.push(`расходится слов: ${diff} из ${e.length}`);
  return problems;
}

// Разрядка по просьбе Vladis13 (4 ноября 2026): шаблон оборачивает слово целиком; перед пробелом {{razr}},
// перед знаком препинания и в конце текста {{razr2}}, который убирает конечный отступ.
const SPACE_NEXT = /^(?:'{2,}|\]\]|\}\})*(?:\s|&nbsp;|&#32;|&#160;)/;
export const fixRazr = (s: string) =>
  s.replace(/([\p{L}\p{M}]*)\{\{razr2?\|([^{}|]*)\}\}([\p{L}\p{M}]*)/gu, (match, pre: string, word: string, post: string, at: number) => {
    const before = /^[\p{L}\p{M}]/u.test(word) ? "" : pre;
    const after = /[\p{L}\p{M}]$/u.test(word) ? "" : post;
    const inner = `${before ? "" : pre}${word}${after ? "" : post}`;
    const rest = s.slice(at + match.length);
    return `${before}{{${!after && SPACE_NEXT.test(rest) ? "razr" : "razr2"}|${inner}}}${after}`;
  });

// Пустые поля для ручного присоединения статьи к Викиданным, по просьбе Wlbw68 (5 ноября 2026).
const LINK_FIELDS = ["ВИКИДАННЫЕ", "ВИКИТЕКА", "ВИКИСКЛАД", "ВИКИСЛОВАРЬ", "ВИКИЦИТАТНИК", "ВИКИУЧЕБНИК", "ВИКИНОВОСТИ", "ВИКИВИДЫ", "НЕОДНОЗНАЧНОСТЬ"].map((f) => `| ${f.padEnd(12)} =\n`).join("");

export function renderArticle(o: { title: string; body: string; quality: number; category: string }): string {
  return `{{БСЭ1\n| НАЗВАНИЕ     = ${o.title}\n| СПИСОК       = \n| ПРЕДЫДУЩИЙ   = \n| СЛЕДУЮЩИЙ    = \n| ВИКИПЕДИЯ    =\n${LINK_FIELDS}| КАЧЕСТВО     = ${o.quality}\n}}\n\n${fixRazr(o.body)}\n\n[[Категория:БСЭ1:${o.category}]]\n`;
}
