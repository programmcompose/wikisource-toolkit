// Черновая разметка томов МСЭ1 и МСЭ2 по OCR archive.org (djvu.xml). На сайте ничего не меняет.
// bun mse/extract.ts            — все скачанные тома
// bun mse/extract.ts 2-11 1-01  — выбранные тома
// Вход: mse/ocr/xml/E-VV.xml (bun mse/tools/get-xml.ts).
// Выход: mse/vols/E-VV/{pages.tsv,headwords.tsv,report.md}, mse/drafts/словник-E-VV.wiki
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;

export const VOLS: Record<string, { range: string; year: string; ia: string }> = {
  "1-01": { range: "Аа — Ваниль", year: "1928", ia: "mre-1" },
  "1-02": { range: "Ванини — Дротик", year: "1929", ia: "mre_2" },
  "1-03": { range: "Дрофы — Ковалик", year: "1929", ia: "mre_3" },
  "1-04": { range: "Ковальская — Массив", year: "1929", ia: "mre_4" },
  "1-05": { range: "Массикот — Огнев", year: "1930", ia: "mre_5" },
  "1-06": { range: "Огневки — Пряжа", year: "1931", ia: "mre_6" },
  "1-07": { range: "Прямая — Скулы", year: "1930", ia: "mre_7" },
  "1-08": { range: "Скульптура — Тугарин", year: "1930", ia: "mre_8" },
  "1-09": { range: "Тугендбунд — Шверник", year: "1931", ia: "mre_9" },
  "1-10": { range: "Швеция — Яя", year: "1932", ia: "mre_10" },
  "2-01": { range: "Аа — Болгары", year: "1937", ia: "2-.-11-1947" },
  "2-02": { range: "Болдуин — Гарнец", year: "1939", ia: "2-.-11-1947" },
  "2-03": { range: "Гарни — Днепр", year: "1936", ia: "2-.-11-1947" },
  "2-04": { range: "Днепровская низменность — Ислам", year: "1936", ia: "2-.-11-1947" },
  "2-05": { range: "Исландия — Кумы", year: "1937", ia: "2-.-11-1947" },
  "2-06": { range: "Кумыки — Модика", year: "1937", ia: "2-.-11-1947" },
  "2-07": { range: "Модильяни — Партнер", year: "1938", ia: "2-.-11-1947" },
  "2-08": { range: "Парторг — Революционный трибунал", year: "1939", ia: "2-.-11-1947" },
  "2-09": { range: "Революция — Срочные", year: "1941", ia: "2-.-11-1947" },
  "2-10": { range: "СССР — Ульяновск", year: "1940", ia: "2-.-11-1947" },
  "2-11": { range: "Ульяновская область — Яя", year: "1947", ia: "2-.-11-1947" },
};

type Word = { t: string; l: number; b: number; r: number; top: number };
type Line = { words: Word[]; para: number };
type Page = { scan: number; W: number; H: number; lines: Line[] };

// Латинские и прочие двойники заглавных кириллических букв в OCR.
const LOOK: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У", "І": "І" };
export function normCaps(s: string): string {
  return s.replace(/[ABCEHKMOPTXY]/g, (c) => LOOK[c] ?? c).replace(/Ѣ/g, "Е");
}

export function parsePages(xml: string): Page[] {
  const pages: Page[] = [];
  // порядок атрибутов у тега OBJECT в разных файлах разный
  const objRe = /<OBJECT ([^>]*)>([\s\S]*?)<\/OBJECT>/g;
  let m: RegExpExecArray | null;
  let para = 0;
  while ((m = objRe.exec(xml))) {
    const attr = (n: string) => m![1].match(new RegExp(`${n}="([^"]*)"`))?.[1] ?? "";
    const H = +attr("height"), W = +attr("width"), scan = +(attr("usemap").match(/_(\d+)\.djvu$/)?.[1] ?? -1);
    const lines: Line[] = [];
    for (const p of m[2].split("<PARAGRAPH>").slice(1)) {
      para++;
      for (const ln of p.split("<LINE>").slice(1)) {
        const words: Word[] = [];
        // в части файлов у WORD есть x-confidence, а в тексте слова — хвостовые пробелы
        const wRe = /<WORD coords="(\d+),(\d+),(\d+),(\d+)[^"]*"[^>]*>([^<]*)<\/WORD>/g;
        let w: RegExpExecArray | null;
        while ((w = wRe.exec(ln))) { const t = decode(w[5]).trim(); if (t) words.push({ l: +w[1], b: +w[2], r: +w[3], top: +w[4], t }); }
        if (words.length) lines.push({ words, para });
      }
    }
    pages.push({ scan, W, H, lines });
  }
  return pages;
}
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export type Gap = { fromScan: number; toScan: number; fromCol: number; toCol: number; missing: number };
export type PageInfo = {
  scan: number; kind: "text" | "plate" | "blank"; words: number; header: string;
  numL: number | null; numR: number | null; split: number; colL: number | null; colR: number | null; colSrc: "header" | "interp" | "";
};

// Колонтитул: верхние строки страницы, состоящие из номеров и заглавных слов. Номера столбцов — числа у левого и правого края.
// Строка вида «МЕДИЧИ, флорентийский род…» в полосе колонтитула — это уже текст, её не берём.
const headerLike = (l: Line) => {
  const ws = l.words.map((w) => w.t);
  const lower = ws.filter((t) => /[а-яё]{2,}/.test(t)).length;
  const startsArticle = ws.length > 1 && /^[А-ЯЁA-Z’'*^-]{2,},$/.test(ws[0]);
  return !startsArticle && lower * 3 <= ws.length;
};
const headerCache = new WeakMap<Page, ReturnType<typeof headerOf0>>();
function headerOf(p: Page) { let h = headerCache.get(p); if (!h) headerCache.set(p, (h = headerOf0(p))); return h; }
function headerOf0(p: Page): { header: string; numL: number | null; numR: number | null; bodyTop: number; lines: Set<Line> } {
  if (!p.lines.length) return { header: "", numL: null, numR: null, bodyTop: 0, lines: new Set() };
  const first = Math.min(...p.lines.map((l) => Math.min(...l.words.map((w) => w.top))));
  const lim = Math.min(first + p.H * 0.022, p.H * 0.12);
  const top = p.lines.filter((l) => Math.min(...l.words.map((w) => w.top)) < lim && headerLike(l));
  let numL: number | null = null, numR: number | null = null;
  const caps: string[] = [];
  for (const l of top) for (const w of l.words) {
    const n = w.t.replace(/[^0-9]/g, "");
    if (/^\d{1,4}$/.test(w.t.replace(/[.,]/g, "")) && n.length) {
      if (w.r < p.W * 0.3) numL = +n;
      else if (w.l > p.W * 0.7) numR = +n;
    } else caps.push(w.t);
  }
  const bodyTop = top.length ? Math.max(...top.flatMap((l) => l.words.map((w) => w.b))) : 0;
  return { header: normCaps(caps.join(" ")), numL, numR, bodyTop, lines: new Set(top) };
}

// Запасная граница столбцов: середина текстового поля (поля у сканов бывают несимметричными).
function textCenter(p: Page, bodyTop: number): number {
  const ws = p.lines.flatMap((l) => l.words).filter((w) => w.b > bodyTop);
  if (!ws.length) return Math.round(p.W / 2);
  const ls = ws.map((w) => w.l).sort((a, b) => a - b), rs = ws.map((w) => w.r).sort((a, b) => a - b);
  return Math.round((ls[Math.floor(ls.length * 0.02)] + rs[Math.floor(rs.length * 0.98)]) / 2);
}

// Граница столбцов: самый широкий вертикальный просвет в средней трети страницы.
function gutter(p: Page, bodyTop: number): number {
  const lo = Math.floor(p.W * 0.33), hi = Math.ceil(p.W * 0.67);
  const cover = new Int32Array(hi - lo);
  for (const l of p.lines) for (const w of l.words) {
    if (w.b <= bodyTop) continue;
    for (let x = Math.max(lo, w.l); x < Math.min(hi, w.r); x++) cover[x - lo]++;
  }
  let best = -1, bestLen = 0, cur = -1;
  for (let i = 0; i <= cover.length; i++) {
    if (i < cover.length && cover[i] <= 1) { if (cur < 0) cur = i; }
    else if (cur >= 0) { if (i - cur > bestLen) { bestLen = i - cur; best = cur; } cur = -1; }
  }
  return best >= 0 && bestLen > p.W * 0.008 ? lo + best + Math.floor(bestLen / 2) : 0;
}

export type Head = { title: string; caps: string; scan: number; side: "L" | "R"; col: number | null; doubt: string[]; snippet: string };

const CAPS_TOKEN = /^[«"„(]?[A-ZА-ЯЁІ][A-ZА-ЯЁІ'’\-¬]*[A-ZА-ЯЁІ]\)?[»"]?[,.:;]?$|^[A-ZА-ЯЁ][,.]?$/;
const ROMAN = /^(I{1,3}|IV|V|VI{1,3}|IX|X{1,3}|XI{1,3}|XIV|XV|XX|І{1,3})[.,]?$/;

function titleCase(caps: string): string {
  const low = caps.toLowerCase();
  return low.replace(/^([«"„(]?)(.)/, (_, q, c) => q + c.toUpperCase()).replace(/-(.)/g, (m, c, off) => {
    // «АБАС-ТУМАН» → «Абас-Туман»: в топонимах после дефиса заглавная, у терминов строчная — оставляем на сверку
    return "-" + c.toUpperCase();
  });
}

// Чистка заглавных слов OCR МСЭ2: знак ударения (’ ' * ^ `) внутри слова и отдельным токеном,
// «ІѴІ» вместо «М», цифра 0 вместо «О», «І» вместо «И», тире, приклеенное к слову.
const ACC = /[’'*^`´]/g;
export function cleanTokens(words: string[]): string[] {
  const out: string[] = [];
  for (let w of words) {
    w = w.replace(/ІѴІ|ІѴ[»!]?|Ѵ[ІЛ]/g, "М");
    const glued = w.match(/^(.*[A-ZА-ЯЁІ’'*^`´])([—–]|--)$/);
    const pieces = glued ? [glued[1], "—"] : [w];
    for (let p of pieces) {
      // «ЭБОНИ ’Т»: обрывок, начинающийся со знака ударения, приклеиваем к предыдущему заглавному слову (проверка до чистки)
      const accentTail = /^[’'*^`´]+[A-ZА-ЯЁІ]*[,]?$/.test(p) && out.length > 0 && /[А-ЯЁ]$/.test(out[out.length - 1]);
      if (/[A-ZА-ЯЁІ]/.test(p) && !/[a-zа-яё]/.test(p)) p = p.replace(ACC, "").replace(/0/g, "О").replace(/І/g, "И").replace(/Ѳ/g, "Ф");
      if (accentTail) {
        out[out.length - 1] += p.replace(ACC, "");
        continue;
      }
      if (!p.replace(ACC, "")) continue;
      out.push(p);
    }
  }
  return out;
}

// Частотный словарь строчных слов из текста всех томов издания: по нему склеиваются обрывки заголовков.
export type Vocab = Map<string, number>;
export function buildVocab(texts: string[]): Vocab {
  const v: Vocab = new Map();
  for (const t of texts) for (const m of t.toLowerCase().replace(/ё/g, "е").matchAll(/[а-я]+/g)) v.set(m[0], (v.get(m[0]) ?? 0) + 1);
  return v;
}

// «КОМ АНД АРМ» → «КОМАНДАРМ», «КЁЛЬНСКИЙ ПРОЦЕСС» остаётся двумя словами.
// Перебираем, какие пробелы OCR настоящие; слово из словаря стоит log(частоты), неизвестное — штраф по длине, каждое слово — штраф 6.
export function resegment(caps: string, vocab: Vocab): string {
  const toks = caps.split(" ").filter(Boolean);
  if (toks.length < 2 || toks.length > 12) return caps;
  const score = (w: string) => {
    const k = w.toLowerCase().replace(/ё/g, "е").replace(/[^а-я]/g, "");
    if (!k) return -6;
    const f = vocab.get(k) ?? 0;
    // короткие «слова» в OCR основного текста — чаще всего такие же обрывки, поэтому до 2 букв верим только предлогам и союзам
    const known = k.length >= 3 ? f >= (k.length === 3 ? 5 : 2) : /^(и|в|с|к|о|у|а|на|по|до|от|из|за|не|во|об|со|ус|ад|ар)$/.test(k);
    return (known ? Math.log(Math.max(f, 2)) : -8 - 0.5 * k.length) - 8;
  };
  const isKnown = (w: string) => (vocab.get(w.toLowerCase().replace(/ё/g, "е").replace(/[^а-я]/g, "")) ?? 0) >= 2;
  const letters = (w: string) => w.replace(/[^А-ЯЁA-Z]/g, "").length;
  // Склеивать можно, если получилось известное слово или в каждом стыке хотя бы одна часть — обрывок до 3 букв,
  // а к известному слову из 4+ букв («КИТОВЫЙ УС») хвост не приклеиваем.
  const mergeable = (parts: string[]) =>
    isKnown(parts.join("")) ||
    parts.every((p, n) => {
      if (n === 0) return true;
      const a = parts[n - 1];
      if ((letters(a) >= 4 && isKnown(a)) || (letters(p) >= 4 && isKnown(p))) return false;
      return letters(a) <= 3 || letters(p) <= 3;
    });
  const best: { s: number; parts: string[] }[] = [{ s: 0, parts: [] }];
  for (let j = 1; j <= toks.length; j++) {
    let b = { s: -Infinity, parts: [] as string[] };
    for (let i = Math.max(0, j - 10); i < j; i++) {
      if (j - i > 1 && !mergeable(toks.slice(i, j))) continue;
      // дефис внутри названия («АБАС-ТУМАН») сохраняем, обрывки склеиваем без пробела
      const w = toks.slice(i, j).join("");
      const s = best[i].s + score(w);
      if (s > b.s) b = { s, parts: [...best[i].parts, w] };
    }
    best[j] = b;
  }
  return best[toks.length].parts.join(" ");
}

// Первая буква заголовка, расходящаяся с обоими соседями, — вероятная ошибка OCR («З’БРО» среди «Э…»).
// Меняем только на букву из пары, которую OCR путает.
const CONFUSE = new Set(["ЗЭ", "ЭЗ", "БВ", "ВБ", "ТГ", "ГТ", "ШЩ", "ЩШ", "НП", "ПН", "ИН", "НИ", "ЕЁ", "ЁЕ", "ОС", "СО"]);
export function fixFirstLetters(heads: Head[]) {
  for (let i = 1; i + 1 < heads.length; i++) {
    const a = heads[i - 1].title[0], b = heads[i + 1].title[0], c = heads[i].title[0];
    if (a === b && c !== a && CONFUSE.has(c + a) && heads[i].scan - heads[i - 1].scan <= 1 && heads[i + 1].scan - heads[i].scan <= 1) {
      heads[i].title = a + heads[i].title.slice(1);
      heads[i].doubt.push(`буква ${c}→${a}`);
    }
  }
}

// Разбор одной строки, с которой может начинаться статья.
function headFromLine(words: string[]): { caps: string; rest: string[]; ok: boolean } {
  words = cleanTokens(words);
  const caps: string[] = [];
  let i = 0;
  for (; i < words.length; i++) {
    let w = normCaps(words[i]);
    // Перенос слова заголовка на след. строку: «СЕМИ¬» + «ЛЕТКА,» → «СЕМИЛЕТКА,» (строки уже склеены в analyse).
    if (/(¬|-)$/.test(w) && i + 1 < words.length) {
      const cont = normCaps(words[i + 1]);
      if (/^[A-ZА-ЯЁІ]/.test(cont)) { w = w.slice(0, -1) + cont; i++; }
    }
    if (!CAPS_TOKEN.test(w) || /[a-zа-яё]/.test(w)) break;
    caps.push(w);
    // Запятая/точка после заголовка: дальше — описание, не часть названия («УЗБЕКСКАЯ ЛИТЕРАТУРА. В эпоху...»).
    if (/[,:.;]$/.test(w)) { i++; break; }
  }
  if (!caps.length) return { caps: "", rest: words, ok: false };
  const letters = caps.join("").replace(/[^A-ZА-ЯЁІ]/g, "");
  const ok = letters.length >= 2 && !(caps.length === 1 && ROMAN.test(caps[0]));
  return { caps: caps.join(" "), rest: words.slice(i), ok };
}

// Имя и отчество после фамилии: «ЭБЕР, Жак Рене (1757—1794)» → «Эбер, Жак Рене».
function personTail(rest: string[]): string {
  // берём имя, только если за ним скобка с годами: «АБЕЛЯР, Пьер (1079—1142)», но не «ААРА, Аар, р. в Швейцарии»
  const out: string[] = [];
  let k = 0;
  for (; k < rest.length; k++) {
    const w = rest[k];
    if (/^\(/.test(w)) break;
    const clean = w.replace(/[,;]$/, "");
    if (!/^[А-ЯЁA-Z][а-яёa-z'’\-]*\.?$/.test(clean) && !/^(де|фон|ван|дер|ле|ла|да|ди|дель|ибн|аль)$/.test(clean)) return "";
    out.push(clean);
    if (/[,;]$/.test(w) || out.length > 3) return "";
  }
  const nx = rest[k] ?? "";
  return out.length && /^\(\D{0,4}\d/.test(nx) ? out.join(" ") : "";
}

export function analyse(pages: Page[], vocab: Vocab = new Map(), firstWord = "") {
  const infos: PageInfo[] = [];
  const heads: Head[] = [];
  for (const p of pages) {
    const words = p.lines.reduce((s, l) => s + l.words.length, 0);
    const h = headerOf(p);
    const split = gutter(p, h.bodyTop);
    // страница с согласованной парой номеров — текстовая, даже если между столбцами нет просвета (карта, таблица)
    const pair = h.numL != null && h.numR === h.numL + 1;
    // на перекошенных сканах слова перекрывают просвет между столбцами: страницу с 400+ словами всё равно считаем текстовой
    const kind: PageInfo["kind"] = words < 40 ? "blank" : (split && words > 250) || (pair && words > 150) || words >= 400 ? "text" : "plate";
    infos.push({ scan: p.scan, kind, words, header: h.header, numL: h.numL, numR: h.numR, split: split || textCenter(p, h.bodyTop), colL: null, colR: null, colSrc: "" });
  }
  const gaps = assignColumns(infos);

  for (let k = 0; k < pages.length; k++) {
    const p = pages[k], info = infos[k];
    if (info.kind !== "text") continue;
    const hdr = headerOf(p).lines;
    const body = p.lines.filter((l) => !hdr.has(l));
    for (const side of ["L", "R"] as const) {
      const col = body.filter((l) => (side === "L" ? l.words[0].l < info.split : l.words[0].l >= info.split));
      if (!col.length) continue;
      // левый край столбца — 10-й перцентиль начал строк: устойчиво к перекосу и мусору на полях
      const starts = col.map((l) => l.words[0].l).sort((a, b) => a - b);
      const left = starts[Math.floor(starts.length * 0.1)];
      for (let i = 0; i < col.length; i++) {
        const l = col[i];
        const prev = col[i - 1];
        const paraStart = !prev || prev.para !== l.para;
        const prevEnds = !prev || /[.)»!?]$/.test(prev.words[prev.words.length - 1].t);
        let toks = l.words.map((w) => w.t);
        // Двухстрочный заголовок без переноса: «ФРАНЦУЗСКАЯ СОЦИАЛИСТИЧЕСКАЯ / ПАРТИЯ, см. ...» —
        // первая строка целиком заглавная без пунктуации, вторая начинается с заглавного слова + запятая/точка.
        const nextLine = col[i + 1];
        if (paraStart && nextLine) {
          const t0 = cleanTokens(toks).map(normCaps);
          const n0 = normCaps(cleanTokens(nextLine.words.map((w) => w.t))[0] ?? "");
          const allCaps = toks.length >= 2 && t0.every((w) => /^[A-ZА-ЯЁІ][A-ZА-ЯЁІ'’\-¬]*$/.test(w)) && !/[,.:;]$/.test(t0[t0.length - 1]);
          if (allCaps && /^[A-ZА-ЯЁІ][A-ZА-ЯЁІ'’\-¬]*[,.;]$/.test(n0)) toks = [...toks, ...nextLine.words.map((w) => w.t)];
        }
        const nextToks = cleanTokens(col[i + 1]?.words.map((w) => w.t) ?? []);
        const hf = headFromLine(toks);
        if (!hf.ok) continue;
        // колонтитул «МЕДИЧИ— МЕДНЫЙ ВЕК», не попавший в полосу колонтитула: вся строка заглавными, с тире
        const whole = cleanTokens(toks).join(" ");
        if (!/[а-яё]{2,}/.test(whole) && /[—–-]/.test(whole) && !/[,(]/.test(whole) && l.words.length <= 8) continue;
        // после заголовка нужна запятая, скобка или тире; иначе это строка таблицы или подзаголовок.
        // В МСЭ1 встречаются и заголовки с точкой («УРОЖАЙНОСТЬ.»), с оторванной в отдельный токен запятой
        // («ФАЦИИ , или...») и без пунктуации («ЧИСТКА ПАРТИИ от разложившихся...») — принимаем их только для новых абзацев OCR.
        const after = hf.rest[0] ?? nextToks[0] ?? "";
        const capsLetters = hf.caps.replace(/[^A-ZА-ЯЁІ]/g, "");
        // Отдельный токен-запятая после заголовка («ЧИБЧАСЫ , чибча...»); точка с запятой не считается — мусор на картах.
        const detachedComma = (hf.rest.length > 0 && /^,$/.test(cleanTokens([hf.rest[0]])[0] ?? "")) || (hf.rest.length === 0 && /^,$/.test(nextToks[0] ?? ""));
        const bareDesc = !/[,.:;]$/.test(hf.caps) && hf.rest.length > 0 && /^[a-zа-яё«(]/.test(hf.rest[0]) && (hf.caps.split(" ").length >= 2 || capsLetters.length >= 6);
        const dotTitle = /\.$/.test(hf.caps) && (capsLetters.length >= 6 || (hf.caps.split(" ").length >= 2 && capsLetters.length >= 8));
        const sep = /[,(]$/.test(hf.caps) || /^[(—–-]/.test(after) || /,$/.test(hf.caps.split(" ").pop()!) || paraStart && (dotTitle || detachedComma || bareDesc);
        if (!sep) continue;
        const doubt: string[] = [];
        if (!paraStart) {
          if (!prevEnds) continue;
          doubt.push("внутри абзаца OCR");
        }
        if (l.words[0].l - left > (p.W * 0.03)) doubt.push("отступ");
        let capsTitle = hf.caps.replace(/[,.:;]$/, "").replace(/¬/g, "");
        // перенос заголовка на следующую строку: «КОН¬» + «ГРЕСС»
        if (/[-¬]$/.test(capsTitle) && nextToks.length) { capsTitle = capsTitle.replace(/[-¬]$/, "") + normCaps(nextToks[0]).replace(/[,]$/, ""); doubt.push("перенос"); }
        let title = titleCase((vocab.size ? resegment(capsTitle, vocab) : capsTitle).replace(/^[«"„]|[»"]$/g, ""));
        if (vocab.size && title !== titleCase(capsTitle.replace(/^[«"„]|[»"]$/g, ""))) doubt.push("склейка");
        const pt = /,$/.test(hf.caps) ? personTail([...hf.rest, ...nextToks]) : "";
        if (pt) title += ", " + pt;
        if (/[^А-ЯЁа-яёІі \-,.'’]/.test(title)) doubt.push("знаки");
        if (title.split(",")[0].split(/[ -]/).some((w) => w.length <= 2 && !/^(и|в|с|к|о|у|а|на|по|до|от|из|за|не|во|об|со|ус|ад|ар|де|ди|да|ла|ле|фон|ван)$/i.test(w))) doubt.push("обрывок");
        if (/\bсм\.?$/.test(hf.rest.slice(0, 3).join(" ")) || /^—?\s*см\./.test(hf.rest.join(" "))) doubt.push("см.");
        const col_ = side === "L" ? info.colL : info.colR;
        heads.push({ title, caps: capsTitle, scan: p.scan, side, col: col_, doubt, snippet: toks.join(" ").slice(0, 90) });
      }
    }
  }
  fixFirstLetters(heads);
  // всё до первой статьи тома («Аа», «Ванини»…) — вводные страницы: список сокращений, состав редакции
  if (firstWord) {
    const fw = firstWord.toLowerCase().replace(/ё/g, "е");
    const i = heads.findIndex((h) => h.title.toLowerCase().replace(/ё/g, "е").startsWith(fw));
    if (i > 0 && i < 400) heads.splice(0, i);
  }
  return { infos, heads, gaps };
}

// Номера столбцов: из колонтитулов, проверка «правый = левый + 1», между опорами — по 2 на текстовую страницу.
export function assignColumns(infos: PageInfo[]): Gap[] {
  // Опора — текстовая страница с номером в колонтитуле. Позиции считаются по всем сканам:
  // между опорами могут быть полностраничные карты и рисунки, которые занимают номера, но не дают OCR.
  const raw: { pos: number; left: number }[] = [];
  infos.forEach((i, pos) => {
    if (i.kind !== "text") return;
    if (i.numL != null && i.numR === i.numL + 1 && i.numL % 2 === 1) raw.push({ pos, left: i.numL });
    // одна цифра испорчена OCR: берём уцелевшую, соседние опоры отсеют ошибку
    else if (i.numL != null && i.numL % 2 === 1) raw.push({ pos, left: i.numL });
    else if (i.numR != null && i.numR % 2 === 0) raw.push({ pos, left: i.numR - 1 });
  });
  const between = (pa: number, pb: number) => {
    let t = 0, n = 0;
    for (let p = pa + 1; p < pb; p++) infos[p].kind === "text" ? t++ : n++;
    return { t, n };
  };
  // согласованность двух опор: разница номеров = 2 × (текстовые страницы) + 2 × (часть нетекстовых)
  const fits = (a: { pos: number; left: number }, b: { pos: number; left: number }) => {
    const [x, y] = a.pos < b.pos ? [a, b] : [b, a];
    const { t, n } = between(x.pos, y.pos);
    const d = y.left - x.left - 2 * (t + 1);
    return d >= 0 && d <= 2 * n;
  };
  // Опора остаётся, если с ней согласна хотя бы половина из десяти ближайших опор.
  // Так отсеиваются серии одинаково испорченных цифр (585 → 685), а опора у настоящего пропуска в скане сохраняется.
  // Опора у края пропуска согласна только с одной стороной — её оставляем, если там согласны ≥4 из 5 соседей.
  const good = raw.filter((a, k) => {
    let agree = 0, total = 0;
    const side = [0, 0];
    for (let d = -5; d <= 5; d++) {
      const b = raw[k + d];
      if (!d || !b) continue;
      total++;
      if (fits(a, b)) { agree++; side[d < 0 ? 0 : 1]++; }
    }
    return total === 0 || agree * 2 >= total || Math.max(...side) >= 4;
  });
  const set = (p: number, left: number, src: PageInfo["colSrc"]) => { infos[p].colL = left; infos[p].colR = left + 1; infos[p].colSrc = src; };
  for (const a of good) set(a.pos, a.left, "header");
  const gaps: Gap[] = [];
  for (let k = 0; k + 1 < good.length; k++) {
    const a = good[k], b = good[k + 1];
    const { t, n } = between(a.pos, b.pos);
    const extra = (b.left - a.left - 2 * (t + 1)) / 2; // сколько нетекстовых страниц занимают номера
    if (extra === 0) {
      let left = a.left;
      for (let p = a.pos + 1; p < b.pos; p++) if (infos[p].kind === "text") set(p, (left += 2), "interp");
    } else if (extra === n) {
      let left = a.left;
      for (let p = a.pos + 1; p < b.pos; p++) set(p, (left += 2), "interp");
    } else gaps.push({ fromScan: infos[a.pos].scan, toScan: infos[b.pos].scan, fromCol: a.left + 2, toCol: b.left - 1, missing: extra > n ? 2 * (extra - n) : 2 * (extra - n) });
  }
  // до первой и после последней опоры — по текстовым страницам
  if (good.length) {
    let left = good[0].left;
    for (let p = good[0].pos - 1; p >= 0 && left > 2; p--) if (infos[p].kind === "text") set(p, (left -= 2), "interp");
    left = good[good.length - 1].left;
    for (let p = good[good.length - 1].pos + 1; p < infos.length; p++) if (infos[p].kind === "text") set(p, (left += 2), "interp");
  }
  return gaps;
}

function letterOf(t: string) { return t[0].toUpperCase().replace("Ё", "Е"); }

export function wordlist(key: string, heads: Head[]): string {
  const [ed, vol] = key.split("-");
  const v = VOLS[key];
  const n = +vol;
  const prev = VOLS[`${ed}-${String(n - 1).padStart(2, "0")}`];
  const next = VOLS[`${ed}-${String(n + 1).padStart(2, "0")}`];
  const out: string[] = [];
  out.push(`{{Отексте
|НАЗВАНИЕ = ${v.range}
|СОДЕРЖАНИЕ = [[../../|Словник]] № {{SUBPAGENAME}}
|ПРЕДЫДУЩИЙ = ${prev ? `[[../${String(n - 1).padStart(2, "0")}|${prev.range}]]` : ""}
|СЛЕДУЮЩИЙ = ${next ? `[[../${String(n + 1).padStart(2, "0")}|${next.range}]]` : ""}
|ВИКИПЕДИЯ =
|ДРУГОЕ = '''Малая советская энциклопедия''' (${ed} издание), т. ${roman(n)}: ${v.range} / Гл. ред. Н. Л. Мещеряков. — Москва, ${v.year}.
|НЕТ_АВТОРА =
}}__TOC__
<!-- ЧЕРНОВИК из OCR archive.org (${v.ia}), человеком не сверен. 4-й параметр — страница файла archive.org; в комментарии — пометки сомнений. -->

<div class=wordlist1>`);
  let letter = "";
  for (const h of heads) {
    const L = letterOf(h.title.replace(/^[«"„(]/, ""));
    if (L !== letter) { letter = L; out.push(`== ${L} ==`); }
    // 4-й параметр — страница файла archive.org (скан + 1), как в ручном словнике т. 11 МСЭ2
    const note = h.doubt.length ? ` <!-- ${h.doubt.join("; ")} -->` : "";
    out.push(`* {{Статья в словнике|${h.title}||${h.col ?? ""}|${h.scan + 1}}}${note}`);
  }
  out.push("</div>", "", `[[Категория:Малая советская энциклопедия/Словник|${vol}]]`);
  return out.join("\n");
}
const roman = (n: number) => ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"][n];

function report(key: string, infos: PageInfo[], heads: Head[], gaps: Gap[]): string {
  const v = VOLS[key];
  const text = infos.filter((i) => i.kind === "text");
  const nums = text.filter((i) => i.colSrc === "header").length;
  const interp = text.filter((i) => i.colSrc === "interp").length;
  const none = text.filter((i) => !i.colSrc);
  const cols = text.filter((i) => i.colR != null).map((i) => i.colR!);
  const doubt = heads.filter((h) => h.doubt.length).length;
  const L: string[] = [];
  L.push(`# МСЭ${key[0]}, т. ${+key.slice(2)} (${v.year}): ${v.range}`, "");
  L.push(`Источник: archive.org/details/${v.ia}. Черновик, человеком не сверен.`, "");
  L.push(`| Сканов | Текстовых | Вклейки и прочее | Пустые | Столбцы по колонтитулу | Интерполяция | Без номера | Последний столбец | Заголовков | С сомнением |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|`);
  L.push(`| ${infos.length} | ${text.length} | ${infos.filter((i) => i.kind === "plate").length} | ${infos.filter((i) => i.kind === "blank").length} | ${nums} | ${interp} | ${none.length} | ${cols.length ? Math.max(...cols) : "—"} | ${heads.length} | ${doubt} |`, "");
  if (none.length) L.push(`Текстовые страницы без номера столбца (сканы): ${none.map((i) => i.scan).join(", ")}`, "");
  if (gaps.length) {
    L.push("## Разрывы нумерации", "", "Число столбцов между опорами не совпадает с числом текстовых страниц. Плюс — в скане, вероятно, не хватает страниц; минус — лишняя страница (вклейка, принятая за текст, или повтор).", "");
    L.push("| Сканы | Столбцы | Расхождение |", "|---|---|---|");
    for (const g of gaps) L.push(`| ${g.fromScan}–${g.toScan} | ${g.fromCol}–${g.toCol} | ${g.missing > 0 ? "+" : ""}${g.missing} |`);
    L.push("");
  }
  // соответствие скан → столбец для модуля (map), каждые ~40 страниц и на вклейках
  const map: string[] = [];
  let last = -99;
  for (const i of text) if (i.colL != null && (i.scan - last > 40 || map.length === 0)) { map.push(`{ ${i.scan + 1}, ${i.colL} }`); last = i.scan; }
  L.push("Черновик `map` для модуля (номер страницы файла = скан + 1, проверить после загрузки файла):", "", "```", map.join(", "), "```");
  return L.join("\n");
}

if (import.meta.main) {
  const want = Bun.argv.slice(2);
  const keys = want.length ? want : Object.keys(VOLS).filter((k) => existsSync(join(ROOT, "ocr", "xml", `${k}.xml`)));
  const vocabs = new Map<string, Vocab>();
  const vocabOf = (ed: string) => {
    if (!vocabs.has(ed)) {
      const files = readdirSync(join(ROOT, "ocr")).filter((f) => f.startsWith(ed + "-") && f.endsWith(".txt"));
      vocabs.set(ed, buildVocab(files.map((f) => readFileSync(join(ROOT, "ocr", f), "utf8"))));
    }
    return vocabs.get(ed)!;
  };
  for (const key of keys) {
    const xml = readFileSync(join(ROOT, "ocr", "xml", `${key}.xml`), "utf8");
    const pages = parsePages(xml);
    const { infos, heads, gaps } = analyse(pages, vocabOf(key[0]), VOLS[key].range.split(" — ")[0]);
    const dir = join(ROOT, "vols", key);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(ROOT, "drafts"), { recursive: true });
    writeFileSync(join(dir, "pages.tsv"), ["скан\tвид\tслов\tколонтитул\tномер_л\tномер_п\tстолбец_л\tстолбец_п\tисточник", ...infos.map((i) => [i.scan, i.kind, i.words, i.header, i.numL ?? "", i.numR ?? "", i.colL ?? "", i.colR ?? "", i.colSrc].join("\t"))].join("\n"));
    writeFileSync(join(dir, "headwords.tsv"), ["название\tстолбец\tскан\tсторона\tсомнения\tOCR", ...heads.map((h) => [h.title, h.col ?? "", h.scan, h.side, h.doubt.join(", "), h.snippet].join("\t"))].join("\n"));
    writeFileSync(join(dir, "report.md"), report(key, infos, heads, gaps));
    writeFileSync(join(ROOT, "drafts", `словник-${key}.wiki`), wordlist(key, heads));
    const text = infos.filter((i) => i.kind === "text");
    console.log(`${key}: сканов ${infos.length}, текстовых ${text.length}, без столбца ${text.filter((i) => !i.colSrc).length}, заголовков ${heads.length}`);
  }
}
