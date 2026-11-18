// Замер точности ИИ на страницах, вычитанных участниками. На сайте ничего не меняет.
//   bun pipeline/eval.ts sample --n 30 --seed 20261104   выборка: eval/sample.jsonl, gold/, ocr/, scans/
//   bun pipeline/eval.ts score                           сравнение: eval/report.md, eval/diffs.md
// Рабочий порядок: модель получает скан и ocr/ID.txt и пишет model/ID.txt, не видя gold/ID.txt.
// Эталон: последняя правка страницы уровня 3–4. OCR: последняя правка уровня 1 перед первой вычитанной.
import { existsSync, readdirSync } from "fs";
import { mkdir } from "fs/promises";
import { resolve } from "path";
import { Client, arg, sleep, USER_AGENT } from "./lib";
import type { Page } from "./parse";

const ROOT = resolve(import.meta.dir, "..");
const EVAL = process.env.WS_EVAL ?? `${ROOT}/eval`;
const OPERATOR_ACCOUNTS = new Set(["IYwiki", "SlovarBot"]);
const MIN_WORDS = 300;
const LONG_RUN = 3; // столько подряд вставленных или удалённых слов считается крупной ошибкой

export type Sample = { id: string; vol: string; file: string; n: number; user: string; level: number; goldRev: number; ocrRev: number; ocrUser: string };

// Шаблоны проекта: что из них видит читатель.
function expandTemplate(inner: string): string {
  const all = inner.split("|");
  const name = all[0].trim();
  const params = all.slice(1);
  const free = params.filter((p) => !/^\s*[\wА-Яа-яёЁ-]+\s*=/.test(p));
  const lower = name.toLowerCase();
  if (lower === "нд") return "-";
  if (name === "=") return "=";
  if (/^(tq|\d+|nop|noindent|indent|rh|примечание вт|примечания вт)$/.test(lower)) return " ";
  if (lower === "перенос") return `${free[0] ?? ""}-`;      // конец страницы: виден первый кусок
  if (lower === "перенос2") return free[1] ?? "";           // начало страницы: виден второй кусок
  if (lower === "sfrac" || lower === "frac") return free.map((p) => p.trim()).join("/");
  if (/^[lri]float$/.test(lower)) return ` ${params.find((p) => /^\s*title\s*=/.test(p))?.replace(/^\s*title\s*=/, "") ?? ""} `;
  if (lower === "poemx1") return free.join(" ");
  if (lower === "бсэ1/автор") return free.join(" ").replace(/\/[^/]*$/, ""); // «А. Добровольский./историк»: после черты пометка редактора
  if (!params.length) return name;                          // опечатка в разметке, текст всё равно виден
  return free.at(-1)?.trim() ?? "";
}

// Приводит викитекст к сравнимому тексту: разметка и оформление не считаются ошибками чтения.
export function normalize(raw: string): string {
  let s = raw
    .replace(/<noinclude>[\s\S]*?<\/noinclude>/g, " ")
    .replace(/<\/?noinclude>/g, " ")
    .replace(/<section\b[^>]*\/?>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<includeonly>[\s\S]*?<\/includeonly>/g, " ") // примечания редакторов, в томе их нет
    .replace(/\[\[(?:Файл|File|Изображение|Image):[^\]]*\]\]/gi, " ")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1");
  // Вложенные шаблоны раскрываем изнутри: остаётся последний параметр без имени.
  for (let i = 0; i < 5 && s.includes("{{"); i++) {
    s = s.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => expandTemplate(inner));
  }
  return s
    .replace(/БСЭ1\//g, "")
    .replace(/¼/g, "1/4").replace(/½/g, "1/2").replace(/¾/g, "3/4").replace(/⅓/g, "1/3").replace(/⅔/g, "2/3")
    .replace(/<(?:sup|sub)>([^<]*)<\/(?:sup|sub)>/g, "$1") // q<sub>1</sub> и q1 одно и то же
    .replace(/<[^>]+>/g, " ")
    .replace(/'{2,}/g, "")
    .replace(/[́]/g, "") // знак ударения: бо́льшая и большая
    .replace(/²/g, "2").replace(/³/g, "3")
    .replace(/&[a-z]+;/g, " ")
    .replace(/­/g, "")
    .replace(/[   ]/g, " ")
    .replace(/[«»„“”"]/g, '"')
    .replace(/[–—−]/g, "—")
    .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, "$1$2") // перенос слова в конце строки
    .replace(/\s+/g, " ")
    .trim();
}

// Слова с числами и дефисами считаются одним токеном, знаки препинания отдельными.
export const tokenize = (s: string): string[] => s.match(/[\p{L}\p{N}]+(?:[-.,:/°][\p{L}\p{N}]+)*|[^\s]/gu) ?? [];
const isWord = (t: string) => /[\p{L}\p{N}]/u.test(t);
const hasDigit = (t: string) => /\p{N}/u.test(t);
// Одинаковые на вид латинские и кириллические буквы на скане неразличимы, поэтому ошибкой не считаются.
const HOMOGLYPHS: Record<string, string> = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", І: "I", і: "i", ј: "j", Ј: "J", ё: "е", Ё: "Е" };
const fold = (s: string) => s.replace(/[aceopxyABCEHKMOPTXІіјЈёЁ]/g, (c) => HOMOGLYPHS[c]);
const looseEq = (a: string, b: string) => a === b || fold(a) === fold(b);

// Выравнивание токенов: для каждого токена эталона номер токена текста или -1, плюс список вставок.
export type Alignment = { goldTo: number[]; inserted: number[] };
export function alignTokens(gold: string[], text: string[]): Alignment {
  const n = gold.length, m = text.length, w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  // Замена возможна только у похожих слов. Иначе выдуманный кусок той же длины выглядел бы как опечатки, а не как потеря и вставка.
  const subCost = (a: string, b: string) => {
    if (looseEq(a, b)) return 0;
    return levenshtein(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 2)) ? 1 : 3;
  };
  for (let j = 0; j <= m; j++) dp[j] = j;
  for (let i = 1; i <= n; i++) {
    dp[i * w] = i;
    for (let j = 1; j <= m; j++) {
      const sub = dp[(i - 1) * w + j - 1] + subCost(gold[i - 1], text[j - 1]);
      dp[i * w + j] = Math.min(sub, dp[(i - 1) * w + j] + 1, dp[i * w + j - 1] + 1);
    }
  }
  const goldTo = new Array<number>(n).fill(-1), inserted: number[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i * w + j] === dp[(i - 1) * w + j - 1] + subCost(gold[i - 1], text[j - 1])) { goldTo[--i] = --j; }
    else if (i > 0 && dp[i * w + j] === dp[(i - 1) * w + j] + 1) { i--; }
    else { inserted.push(--j); }
  }
  return { goldTo, inserted: inserted.reverse() };
}

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1);
    prev = cur;
  }
  return prev[b.length];
}

// Длины идущих подряд потерь эталона и вставок модели, только по словам.
function runs(flags: boolean[]): number[] {
  const out: number[] = [];
  let cur = 0;
  for (const f of flags) { if (f) cur++; else { if (cur) out.push(cur); cur = 0; } }
  if (cur) out.push(cur);
  return out;
}

export type PageScore = {
  goldWords: number; goldNumbers: number;
  ocrWrong: number; modelWrong: number;       // неверные или пропавшие слова эталона
  fixed: number;                              // OCR ошибся, модель права
  missed: number;                             // оба неверны, модель повторила OCR
  badFix: number;                             // оба неверны, модель написала другое
  damaged: number;                            // OCR был прав, модель испортила
  invented: number;                           // лишнее слово модели, которого нет в OCR
  inheritedExtra: number;                     // лишнее слово, перешедшее из OCR
  ocrNumbersWrong: number; modelNumbersWrong: number; damagedNumbers: number;
  longDeleted: number; longInserted: number;  // крупные потери и вставки, слов подряд >= LONG_RUN
  moved: number;                              // слова модели, стоящие не на том месте, но имеющиеся в эталоне
  cerOcr: number; cerModel: number;
  diffs: { kind: string; gold: string; ocr: string; model: string; context: string }[];
};

export function scorePage(goldRaw: string, ocrRaw: string, modelRaw: string): PageScore {
  const gs = normalize(goldRaw), os = normalize(ocrRaw), ms = normalize(modelRaw);
  const g = tokenize(gs), o = tokenize(os), m = tokenize(ms);
  const ao = alignTokens(g, o), am = alignTokens(g, m);
  const r: PageScore = {
    goldWords: 0, goldNumbers: 0, ocrWrong: 0, modelWrong: 0, fixed: 0, missed: 0, badFix: 0, damaged: 0,
    invented: 0, inheritedExtra: 0, ocrNumbersWrong: 0, modelNumbersWrong: 0, damagedNumbers: 0,
    longDeleted: 0, longInserted: 0, moved: 0,
    cerOcr: levenshtein(gs, os) / Math.max(1, gs.length), cerModel: levenshtein(gs, ms) / Math.max(1, gs.length), diffs: [],
  };
  const context = (i: number) => g.slice(Math.max(0, i - 5), i + 6).join(" ");
  // Подпись к рисунку может стоять в другом месте: это не потеря и не выдумка, если слово есть и там, и там.
  const movedGold = new Set<number>(), movedModel = new Set<number>();
  const free = g.map((t, i) => i).filter((i) => am.goldTo[i] < 0 && isWord(g[i]) && g[i].length >= 2);
  for (const j of am.inserted) {
    if (!isWord(m[j]) || m[j].length < 2) continue;
    const k = free.findIndex((i) => looseEq(g[i], m[j]));
    if (k >= 0) { movedGold.add(free[k]); movedModel.add(j); free.splice(k, 1); r.moved++; }
  }
  const lost: boolean[] = [];
  g.forEach((tok, i) => {
    const oi = ao.goldTo[i], mi = am.goldTo[i];
    const ot = oi >= 0 ? o[oi] : "∅", mt = mi >= 0 ? m[mi] : "∅";
    const okO = oi >= 0 && looseEq(tok, ot), okM = (mi >= 0 && looseEq(tok, mt)) || movedGold.has(i);
    if (isWord(tok)) lost.push(mi < 0 && !movedGold.has(i));
    if (!isWord(tok)) {
      if (!okM && okO) r.diffs.push({ kind: "знак: модель изменила", gold: tok, ocr: ot, model: mt, context: context(i) });
      return;
    }
    r.goldWords++;
    if (hasDigit(tok)) r.goldNumbers++;
    if (!okO) { r.ocrWrong++; if (hasDigit(tok)) r.ocrNumbersWrong++; }
    if (!okM) { r.modelWrong++; if (hasDigit(tok)) r.modelNumbersWrong++; }
    if (!okO && okM) r.fixed++;
    if (!okO && !okM) {
      if (looseEq(ot, mt)) { r.missed++; r.diffs.push({ kind: "пропущено", gold: tok, ocr: ot, model: mt, context: context(i) }); }
      else { r.badFix++; r.diffs.push({ kind: "неверно исправлено", gold: tok, ocr: ot, model: mt, context: context(i) }); }
    }
    if (okO && !okM) {
      r.damaged++;
      if (hasDigit(tok)) r.damagedNumbers++;
      r.diffs.push({ kind: "модель испортила", gold: tok, ocr: ot, model: mt, context: context(i) });
    }
  });
  const insertedSet = new Set(am.inserted);
  // Слово считается вставкой из OCR, если такое же есть в OCR среди его вставок относительно эталона.
  const ocrExtra = ao.inserted.map((i) => o[i]);
  const insertedFlags = m.map((_, j) => insertedSet.has(j) && isWord(m[j]) && !movedModel.has(j));
  for (const j of am.inserted) {
    if (!isWord(m[j]) || movedModel.has(j)) continue;
    const k = ocrExtra.findIndex((t) => looseEq(t, m[j]));
    if (k >= 0) { ocrExtra.splice(k, 1); r.inheritedExtra++; r.diffs.push({ kind: "лишнее из OCR", gold: "∅", ocr: m[j], model: m[j], context: m.slice(Math.max(0, j - 5), j + 6).join(" ") }); }
    else { r.invented++; r.diffs.push({ kind: "вставка модели", gold: "∅", ocr: "∅", model: m[j], context: m.slice(Math.max(0, j - 5), j + 6).join(" ") }); }
  }
  r.longDeleted = runs(lost).filter((x) => x >= LONG_RUN).reduce((a, b) => a + b, 0);
  r.longInserted = runs(insertedFlags).filter((x) => x >= LONG_RUN).reduce((a, b) => a + b, 0);
  return r;
}

// Детерминированный генератор, чтобы выборку можно было повторить.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(list: T[], rand: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export type Eligible = { vol: string; file: string; n: number; user: string; level: number };
export function eligiblePage(vol: string, p: Page): Eligible | null {
  const m = p.content.match(/<pagequality level="(\d)" user="([^"]*)"/);
  if (!m || (m[1] !== "3" && m[1] !== "4") || OPERATOR_ACCOUNTS.has(m[2])) return null;
  const body = p.content.replace(/<noinclude>[\s\S]*?<\/noinclude>/g, "");
  if (body.trim().split(/\s+/).length < MIN_WORDS) return null;
  if (/\{\||<table|<math|\[\[(?:Файл|File|Изображение)/i.test(body)) return null;
  return { vol, file: p.file, n: p.n, user: m[2], level: Number(m[1]) };
}

// Обходит тома по кругу: том с 1 страницей весит столько же, сколько том с 400, поэтому в выборке разный набор.
export function pickOrder(pages: Eligible[], rand: () => number): Eligible[] {
  const byVol = new Map<string, Eligible[]>();
  for (const p of shuffle(pages, rand)) (byVol.get(p.vol) ?? byVol.set(p.vol, []).get(p.vol)!).push(p);
  const vols = shuffle([...byVol.keys()], rand);
  const out: Eligible[] = [];
  for (let round = 0; out.length < pages.length; round++) for (const v of vols) { const p = byVol.get(v)![round]; if (p) out.push(p); }
  return out;
}

async function sample() {
  const n = Number(arg("n") ?? 30), seed = Number(arg("seed") ?? 20261104);
  for (const d of ["gold", "ocr", "scans", "model"]) await mkdir(`${EVAL}/${d}`, { recursive: true });
  const vols = `${ROOT}/vols`;
  const all: Eligible[] = [];
  for (const v of readdirSync(vols)) {
    if (!existsSync(`${vols}/${v}/pages.json`)) continue;
    for (const p of (await Bun.file(`${vols}/${v}/pages.json`).json()) as Page[]) { const e = eligiblePage(v, p); if (e) all.push(e); }
  }
  const order = pickOrder(all, rng(seed));
  const api = new Client();
  const picked: Sample[] = [];
  const skipped: Record<string, number> = {};
  const usedVols = new Map<string, number>();
  for (const e of order) {
    if (picked.length >= n) break;
    const title = `Страница:${e.file}/${e.n}`;
    const j = await api.call({ action: "query", prop: "revisions", titles: title, rvprop: "ids|user|content", rvslots: "main", rvlimit: "50", rvdir: "newer" });
    await sleep(1500);
    const revs: any[] = j.query?.pages?.[0]?.revisions ?? [];
    const level = (r: any) => Number(r.slots?.main?.content?.match(/pagequality level="(\d)"/)?.[1] ?? -1);
    const firstProof = revs.findIndex((r) => level(r) >= 3);
    const before = firstProof > 0 ? revs.slice(0, firstProof).filter((r) => level(r) === 1).at(-1) : undefined;
    if (!before) { skipped["нет правки уровня 1 до вычитки"] = (skipped["нет правки уровня 1 до вычитки"] ?? 0) + 1; continue; }
    const gold = revs.at(-1);
    if (revs.length >= 50 || level(gold) < 3) { skipped["история длиннее 50 правок или сменился уровень"] = (skipped["история длиннее 50 правок или сменился уровень"] ?? 0) + 1; continue; }
    const goldText = gold.slots.main.content, ocrText = before.slots.main.content;
    if (tokenize(normalize(ocrText)).length < MIN_WORDS / 2) { skipped["в правке уровня 1 почти нет текста"] = (skipped["в правке уровня 1 почти нет текста"] ?? 0) + 1; continue; }
    if (normalize(ocrText) === normalize(goldText)) { skipped["текст не менялся при вычитке"] = (skipped["текст не менялся при вычитке"] ?? 0) + 1; continue; }
    const id = `${e.vol}-${String(e.n).padStart(4, "0")}`;
    await Bun.write(`${EVAL}/gold/${id}.txt`, goldText);
    await Bun.write(`${EVAL}/ocr/${id}.txt`, normalizedForModel(ocrText));
    const info = await api.call({ action: "query", prop: "imageinfo", iiprop: "url", iiurlwidth: "2000", iiurlparam: `page${e.n}-2000px`, titles: `Файл:${e.file}` });
    const url = info.query?.pages?.[0]?.imageinfo?.[0]?.thumburl;
    if (!url) throw new Error(`Нет скана: ${e.file}, стр. ${e.n}`);
    await sleep(1500);
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!r.ok) throw new Error(`Скан не скачан: HTTP ${r.status}`);
    await Bun.write(`${EVAL}/scans/${id}.jpg`, await r.arrayBuffer());
    await sleep(1500);
    picked.push({ id, vol: e.vol, file: e.file, n: e.n, user: e.user, level: e.level, goldRev: gold.revid, ocrRev: before.revid, ocrUser: before.user });
    usedVols.set(e.vol, (usedVols.get(e.vol) ?? 0) + 1);
    console.log(`${picked.length}/${n} ${id} ${e.user} ур.${e.level}`);
  }
  await Bun.write(`${EVAL}/sample.jsonl`, picked.map((p) => JSON.stringify(p)).join("\n") + "\n");
  console.log(`Подходящих страниц: ${all.length}. Выбрано: ${picked.length}. Томов: ${usedVols.size}. Пропущено:`, skipped);
}

// Модель видит только текст OCR без служебной разметки страницы.
const normalizedForModel = (raw: string) => raw.replace(/<noinclude>[\s\S]*?<\/noinclude>/g, "").trim();

function percentile(sorted: number[], q: number) { return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; }
// Доверительный интервал считается по страницам: ошибки внутри одной страницы не независимы.
export function bootstrap(pages: PageScore[], rate: (p: PageScore[]) => number, seed = 1, rounds = 2000): [number, number] {
  const rand = rng(seed);
  const values: number[] = [];
  for (let i = 0; i < rounds; i++) values.push(rate(pages.map(() => pages[Math.floor(rand() * pages.length)])));
  values.sort((a, b) => a - b);
  return [percentile(values, 0.025), percentile(values, 0.975)];
}

async function score() {
  const samples = (await Bun.file(`${EVAL}/sample.jsonl`).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)) as Sample[];
  const done = samples.filter((s) => existsSync(`${EVAL}/model/${s.id}.txt`));
  const results: { s: Sample; r: PageScore }[] = [];
  for (const s of done) {
    const [g, o, m] = await Promise.all(["gold", "ocr", "model"].map((d) => Bun.file(`${EVAL}/${d}/${s.id}.txt`).text()));
    results.push({ s, r: scorePage(g, o, m) });
  }
  const sum = (ps: PageScore[], k: keyof PageScore) => ps.reduce((a, p) => a + (p[k] as number), 0);
  const ps = results.map((x) => x.r);
  const ratio = (k: keyof PageScore, base: keyof PageScore = "goldWords") => (p: PageScore[]) => sum(p, k) / Math.max(1, sum(p, base));
  const pct = (x: number) => (x * 100).toFixed(2) + " %";
  const line = (name: string, k: keyof PageScore, base: keyof PageScore = "goldWords") => {
    const [lo, hi] = bootstrap(ps, ratio(k, base));
    return `| ${name} | ${sum(ps, k)} | ${pct(ratio(k, base)(ps))} | ${pct(lo)}–${pct(hi)} |`;
  };
  const report = `# Замер точности ИИ: сырые цифры

Страниц: ${done.length} из ${samples.length}. Слов эталона: ${sum(ps, "goldWords")}, чисел: ${sum(ps, "goldNumbers")}. Эталон считается верным, поэтому здесь есть и ошибки самих участников, см. разбор расхождений.

| Показатель | Слов | Доля | 95 % по страницам |
|---|---|---:|---:|
${line("Ошибка OCR", "ocrWrong")}
${line("Ошибка модели", "modelWrong")}
${line("Исправлено моделью", "fixed")}
${line("Пропущено: модель повторила OCR", "missed")}
${line("Неверно исправлено", "badFix")}
${line("Модель испортила верное слово", "damaged")}
${line("Вставка модели, которой нет в OCR", "invented")}
${line("Лишнее из OCR", "inheritedExtra")}
${line("Стоит в другом месте, например подпись к рисунку", "moved")}
${line("Крупные потери, от " + LONG_RUN + " слов подряд", "longDeleted")}
${line("Крупные вставки, от " + LONG_RUN + " слов подряд", "longInserted")}
${line("Числа: ошибка OCR", "ocrNumbersWrong", "goldNumbers")}
${line("Числа: ошибка модели", "modelNumbersWrong", "goldNumbers")}
${line("Числа: модель испортила", "damagedNumbers", "goldNumbers")}

## По страницам
| Страница | Участник | Ур. | Слов | Ошибка OCR | Ошибка модели | Испортила | Вставки | CER OCR | CER модели |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
${results.map(({ s, r }) => `| ${s.id} | ${s.user} | ${s.level} | ${r.goldWords} | ${r.ocrWrong} | ${r.modelWrong} | ${r.damaged} | ${r.invented} | ${pct(r.cerOcr)} | ${pct(r.cerModel)} |`).join("\n")}
`;
  const diffs = results.map(({ s, r }) => `## ${s.id}: ${s.file}, стр. ${s.n}\n\n| Вид | Эталон | OCR | Модель | Контекст эталона |\n|---|---|---|---|---|\n${r.diffs.map((d) => `| ${d.kind} | ${d.gold} | ${d.ocr} | ${d.model} | ${d.context.replace(/\|/g, "\\|")} |`).join("\n")}`).join("\n\n");
  await Bun.write(`${EVAL}/report.md`, report);
  await Bun.write(`${EVAL}/diffs.md`, `# Расхождения с эталоном\n\n${diffs}\n`);
  console.log(report.split("## По страницам")[0]);
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "sample") await sample();
  else if (cmd === "score") await score();
  else throw new Error("Команды: sample, score");
}
