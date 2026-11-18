// Перенос статей, созданных ботом, на страницы индекса: текст статьи уходит в её секцию, после секции
// ставится {{tq|3}}, уровень страницы не меняется, в статье остаётся тег <pages>.
//   bun pipeline/migrate.ts --vol 48                       — проверка: файлы и отчёт, на сайте ничего не меняет
//   bun pipeline/migrate.ts --vol 48 --publish --limit 5   — публикация, только статьи из vols/48/reviewed.txt
//   bun pipeline/migrate.ts --vol 48 --publish --quality-only — только КАЧЕСТВО = 4 у статей, перенесённых раньше
// reviewed.txt заполняет оператор: по одному названию на строку, только статьи, лично сверенные со сканом.
// Перед правкой статьи результат на сайте сверяется с её текстом. Состояние читается с сайта, поэтому
// запуск можно повторять. Капчу и фильтры правок скрипт не обходит: он останавливается и показывает ответ.
import { appendFile, mkdir, rm } from "fs/promises";
import { Client, arg, csrfToken, flag, login, readJsonl, sleep, volArg, volDir, localTestMode } from "./lib";
import { STRICT_TAG, changedShare, checkRendered, findComplex, fixRazr, norm, planTransclusion, readerWords, renderPagesTag, similarity, type Page, type TranscludePlan } from "./parse";
import type { Article } from "./prepare";
import { tailLooksSigned } from "./summary";
import { BSE1 } from "./profile";

const BOT_ACCOUNT = "SlovarBot";
const MARK = " {{tq|3}}";
const MIN_NAME_SIMILARITY = 0.7;
const MAX_OCR_DIFF = 0.2;
const ANCHOR = 40;
const MIN_ANCHOR_SIMILARITY = 0.7;
const MIN_ANCHOR_MARGIN = 0.1;
const NO_BOT_LIMIT = 20;
const DEFAULT_PAUSE_S = 30;
const CHECK_BATCH = 40;
const PAGE_EDIT = (n: number) => `БСЭ1: в секции страницы перенесён сверенный текст статей (${n}), после секции {{tq|3}}, уровень страницы не менялся. Скрипт с помощью ИИ (Claude).`;
const QUALITY_EDIT = "КАЧЕСТВО = 4: текст статьи на страницах индекса, у них свой статус вычитки. Скрипт с помощью ИИ (Claude).";
const ARTICLE_EDIT = "Статья переведена на включение страницы индекса, текст перенесён на страницу без изменений. Скрипт с помощью ИИ (Claude).";

export type SitePage = Page & { revid: number; timestamp: string };
export type LiveArticle = { title: string; content: string; revid: number; timestamp: string };
type Change = { start: number; end: number; text: string };
export type Ready = { article: Article; body: string; plan: TranscludePlan; changes: Map<number, Change[]>; articleText: string; revid: number; timestamp: string };
export type Held = { title: string; why: string };

// КАЧЕСТВО у перенесённой статьи 4: текст физически на страницах индекса, у них свой статус вычитки
// (совет Vladis13, 6 ноября 2026). Значение меняет только скрытые категории вида «00%».
export const MOVED_QUALITY = "4";
const QUALITY = /(\|\s*КАЧЕСТВО\s*=)[^|}\n]*/;
export const setQuality = (text: string) => text.replace(QUALITY, `$1 ${MOVED_QUALITY}`);
const qualityOf = (text: string) => text.match(QUALITY)?.[0].replace(/^[^=]*=/, "").trim();

// Статьи, которые этот скрипт уже перенёс, но с другим КАЧЕСТВО (первая проба шла с пустым полем).
export function qualityFixes(live: LiveArticle[], moved: Set<string>): { title: string; text: string; revid: number; timestamp: string }[] {
  return live
    .filter((l) => moved.has(l.title) && /<pages\b/.test(l.content) && QUALITY.test(l.content) && qualityOf(l.content) !== MOVED_QUALITY)
    .map((l) => ({ title: l.title, text: setQuality(l.content), revid: l.revid, timestamp: l.timestamp }));
}

// Разделяет статью на шапку, текст и категории. Кроме КАЧЕСТВО шапку и категории перенос не трогает.
export function splitArticle(content: string): { head: string; body: string; tail: string } | null {
  const m = content.match(/^(\{\{БСЭ1\n[\s\S]*?\n\}\}\s*)([\s\S]*?)(\s*(?:\[\[Категория:[^\]]*\]\]\s*)*)$/);
  return m && m[2].trim() ? { head: m[1], body: m[2], tail: m[3] } : null;
}

// Буквы текста, как их увидит читатель, и их места в исходной разметке.
export function visibleLetters(text: string): { letters: string; at: number[] } {
  const hidden = new Uint8Array(text.length);
  for (const re of [/\{\{\s*lsafe\s*\|(?:[^|{}]*\|)?/gi, /\{\{[^|{}]*\|?/g, /\}\}/g, /<[^>]+>/g]) {
    for (const m of text.matchAll(re)) hidden.fill(1, m.index, m.index + m[0].length);
  }
  let letters = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i].toLowerCase().replace("ё", "е");
    if (!hidden[i] && /[а-яa-z0-9]/.test(c)) { letters += c; at.push(i); }
  }
  return { letters, at };
}

// Где в сверенном тексте проходит граница страниц: ищется место, вокруг которого буквы похожи на конец
// одной распознанной страницы и начало другой. Неоднозначное место возвращает ошибку.
export function findCut(body: string, before: string, after: string): number | string {
  const v = visibleLetters(body);
  const tail = visibleLetters(before).letters.slice(-ANCHOR), head = visibleLetters(after).letters.slice(0, ANCHOR);
  if (tail.length < 8 || head.length < 8) return "мало текста у границы страниц";
  const score = new Float32Array(v.letters.length + 1).fill(-1);
  for (let p = 1; p < v.letters.length; p++) {
    const a = similarity(tail, v.letters.slice(Math.max(0, p - tail.length), p));
    const b = similarity(head, v.letters.slice(p, p + head.length));
    if (a >= MIN_ANCHOR_SIMILARITY && b >= MIN_ANCHOR_SIMILARITY) score[p] = a + b;
  }
  let best = -1;
  for (let p = 1; p < score.length; p++) if (score[p] > (best < 0 ? -1 : score[best])) best = p;
  if (best < 0 || score[best] < 0) return "не найдено место границы страниц";
  for (let p = 1; p < score.length; p++) {
    if (Math.abs(p - best) > ANCHOR && score[p] > score[best] - MIN_ANCHOR_MARGIN) return "граница страниц неоднозначна";
  }
  return v.at[best - 1] + 1;
}

// Режет текст в найденном месте. Посреди слова ставит перенос, как на страницах скана.
export function cutBody(body: string, cut: number): [string, string] | string {
  let at = cut;
  const midWord = /[а-яёa-z0-9]/i.test(body[at] ?? "");
  if (!midWord) while (at < body.length && /[.,;:!?)»\]'}]/.test(body[at])) at++;
  const left = body.slice(0, at), right = body.slice(at);
  if ((left.match(/\{\{/g) ?? []).length !== (left.match(/\}\}/g) ?? []).length) return "граница страниц попадает внутрь шаблона";
  if ((left.match(/'{2,}/g) ?? []).length % 2) return "граница страниц попадает внутрь выделения";
  if (midWord) return [`${left}-`, right];
  const gap = right.match(/^\s*/)![0];
  return [left.trimEnd(), `${gap.includes("\n\n") ? "\n\n" : ""}${right.trimStart()}`];
}

const inside = (content: string) => {
  const start = content.indexOf("</noinclude>") + "</noinclude>".length;
  const end = content.lastIndexOf("<noinclude>");
  return start >= "</noinclude>".length && end >= start ? { start, end } : null;
};
const pageTags = (content: string, from: number, to: number) => [...content.slice(from, to).matchAll(STRICT_TAG)].map((m) => ({ kind: m[1], name: m[2], start: from + m.index!, end: from + m.index! + m[0].length }));

// Секция с полным названием статьи («хор, река») побеждает: у одноимённых статей заголовок один.
function chooseSection(head: string, title: string, tags: ReturnType<typeof pageTags>): string | null {
  const exact = tags.find((t) => t.kind === "begin" && norm(t.name) === norm(title));
  if (exact) return exact.name;
  const scored = tags.filter((t) => t.kind === "begin").map((t) => ({ name: t.name, score: similarity(norm(head), norm(t.name)) })).filter((s) => s.score >= MIN_NAME_SIMILARITY);
  if (!scored.length) return null;
  const top = Math.max(...scored.map((s) => s.score));
  return scored.find((s) => s.score === top)!.name;
}

type Spot = { section: string; parts: { page: number; start: number; end: number }[]; endTag: { page: number; start: number; end: number } };

// Находит куски секции на страницах. Секция должна закрываться тем же именем или пустым тегом end="",
// который заливка поставила на следующей странице. Всё остальное оставляется человеку.
function locate(a: Article, pages: SitePage[]): Spot | string {
  const first = pages[0];
  const box = inside(first.content);
  if (!box) return "у страницы нестандартное оформление";
  const tags = pageTags(first.content, box.start, box.end);
  const section = chooseSection(a.head, a.title, tags);
  if (!section) return "на странице нет секции статьи";
  const begins = tags.filter((t) => t.kind === "begin" && t.name === section);
  if (begins.length !== 1) return "имя секции повторяется на странице";
  const begin = begins[0];
  const next = tags[tags.indexOf(begin) + 1];
  if (next?.kind === "end") {
    if (next.name !== section) return `закрывающий тег с другим именем: «${next.name}»`;
    return { section, parts: [{ page: first.n, start: begin.end, end: next.start }], endTag: { page: first.n, start: next.start, end: next.end } };
  }
  if (next) return "секция не закрыта до начала другой";
  const parts: Spot["parts"] = [{ page: first.n, start: begin.end, end: box.end }];
  for (const p of pages.slice(1)) {
    const b = inside(p.content);
    if (!b) return "у страницы нестандартное оформление";
    const t = pageTags(p.content, b.start, b.end)[0];
    if (!t) { parts.push({ page: p.n, start: b.start, end: b.end }); continue; }
    if (t.kind !== "end") return "секция не закрыта до начала другой";
    if (t.name && t.name !== section) return `закрывающий тег с другим именем: «${t.name}»`;
    parts.push({ page: p.n, start: b.start, end: t.start });
    return { section, parts, endTag: { page: p.n, start: t.start, end: t.end } };
  }
  return "нет закрывающего тега на страницах статьи";
}

export function applyChanges(content: string, changes: Change[]): string {
  let out = content;
  for (const c of [...changes].sort((x, y) => y.start - x.start)) out = out.slice(0, c.start) + c.text + out.slice(c.end);
  return out;
}

const sameWords = (a: string, b: string) => readerWords(a).join(" ") === readerWords(b).join(" ");

export function planMigration(articles: Article[], live: LiveArticle[], pages: SitePage[]): { ready: Ready[]; held: Held[]; done: string[] } {
  const byTitle = new Map(articles.map((a) => [a.title, a]));
  const byN = new Map(pages.map((p) => [p.n, p]));
  const repeats = new Map<string, number>();
  for (const a of articles) repeats.set(a.title, (repeats.get(a.title) ?? 0) + 1);
  const ready: Ready[] = [], held: Held[] = [], done: string[] = [];

  for (const item of live) {
    const short = item.title.replace(/^БСЭ1\//, "");
    const hold = (why: string) => { held.push({ title: short, why }); };
    if (/<pages\b/.test(item.content)) { done.push(short); continue; }
    const a = byTitle.get(short);
    if (!a) { hold("нет в словнике тома"); continue; }
    if (repeats.get(short)! > 1) { hold("название повторяется в словнике"); continue; }
    if (a.weak) { hold("на странице нет секции, её нужно поставить вручную"); continue; }
    const parts = splitArticle(item.content);
    if (!parts) { hold("нестандартный вид статьи"); continue; }
    // Разрядка по правилу Vladis13: слова не меняются, только вид шаблона.
    const body = fixRazr(parts.body.trim());
    if (/<ref\b/i.test(body)) { hold("в статье есть сноска"); continue; }
    const complex = findComplex(body);
    if (complex.length) { hold(`в статье есть: ${complex.join(", ")}`); continue; }
    const own = a.pages.map((p) => byN.get(p.n));
    if (!own.length || own.some((p) => !p)) { hold("страница не найдена на сайте"); continue; }
    if (new Set(a.pages.map((p) => p.file)).size > 1) { hold("статья переходит в другой файл индекса"); continue; }
    // Закрывающий тег может стоять в самом начале следующей страницы, которой нет в списке статьи.
    const following = byN.get(a.pages.at(-1)!.n + 1);
    const site = [...(own as SitePage[]), ...(following ? [following] : [])];

    const spot = locate(a, site);
    if (typeof spot === "string") { hold(spot); continue; }
    const used = spot.parts.map((s) => byN.get(s.page)!);
    if (used.some((p) => !/<pagequality level="1"/.test(p.content))) { hold("страница не на уровне 1"); continue; }
    const ocrParts = spot.parts.map((s) => byN.get(s.page)!.content.slice(s.start, s.end).trim());
    const ocr = ocrParts.join(" ");
    if (/\{\{\s*БСЭ1\/Автор/.test(ocr) && !/\{\{\s*БСЭ1\/Автор/.test(body)) { hold("в секции шаблон автора: возможна подпись"); continue; }
    if (tailLooksSigned(ocr)) { hold(`конец секции похож на подпись: ${ocr.slice(-40)}`); continue; }

    const after = (p: SitePage, end: number) => p.content.slice(end, end + 40);
    const endPage = byN.get(spot.endTag.page)!;
    const marked = /^\s*\{\{\s*tq\s*\|/.test(after(endPage, spot.endTag.end));
    const moved = marked && sameWords(ocr, body);
    const changes = new Map<number, Change[]>();
    if (!moved) {
      if (changedShare(body, ocr) > MAX_OCR_DIFF) { hold("в секции другой текст: она шире статьи или текст перемешан с соседним столбцом"); continue; }
      const pieces: string[] = [];
      let rest = body;
      let failed = "";
      for (let i = 0; i + 1 < ocrParts.length; i++) {
        const cut = findCut(rest, ocrParts[i], ocrParts[i + 1]);
        if (typeof cut === "string") { failed = cut; break; }
        const split = cutBody(rest, cut);
        if (typeof split === "string") { failed = split; break; }
        pieces.push(split[0]);
        rest = split[1];
      }
      if (failed) { hold(failed); continue; }
      pieces.push(rest);
      spot.parts.forEach((s, i) => {
        const list = changes.get(s.page) ?? [];
        list.push({ start: s.start, end: s.end, text: pieces[i] });
        changes.set(s.page, list);
      });
      changes.get(spot.endTag.page)!.push({ start: spot.endTag.start, end: spot.endTag.end, text: `<section end="${spot.section}"/>${MARK}` });
    }
    const after2: Page[] = used.map((p) => ({ file: p.file, n: p.n, content: applyChanges(p.content, changes.get(p.n) ?? []) }));
    const check = planTransclusion(spot.section, after2);
    if ("problem" in check) { hold(check.problem); continue; }
    if (!sameWords(check.text, body)) { hold("после переноса слова статьи не совпадают с исходными"); continue; }
    ready.push({
      article: a, body, plan: check.plan, changes,
      articleText: `${setQuality(parts.head)}${renderPagesTag(check.plan)}${parts.tail}`,
      revid: item.revid, timestamp: item.timestamp,
    });
  }
  return { ready, held, done };
}

// Складывает правки выбранных статей постранично.
export function pageEdits(ready: Ready[], pages: SitePage[]): { page: SitePage; text: string; count: number }[] {
  const merged = new Map<number, { changes: Change[]; count: number }>();
  for (const r of ready) for (const [n, list] of r.changes) {
    const e = merged.get(n) ?? { changes: [], count: 0 };
    e.changes.push(...list); e.count++;
    merged.set(n, e);
  }
  return pages.filter((p) => merged.has(p.n)).map((p) => ({ page: p, text: applyChanges(p.content, merged.get(p.n)!.changes), count: merged.get(p.n)!.count }));
}

async function readSite(api: Client, articles: Article[]): Promise<{ live: LiveArticle[]; pages: SitePage[] }> {
  const pause = () => sleep(localTestMode ? 0 : 1200);
  const titles: string[] = [];
  let cont: Record<string, string> = {};
  for (;;) {
    const j = await api.call({ action: "query", list: "usercontribs", ucuser: BOT_ACCOUNT, uclimit: "500", ucprop: "title|flags", ucnamespace: "0", ucshow: "new", ...cont });
    if (j.error) throw new Error(`Вклад бота: ${j.error.code}`);
    titles.push(...j.query.usercontribs.map((e: any) => e.title));
    await pause();
    if (!j.continue) break;
    cont = j.continue;
  }
  const volume = new Set(articles.map((a) => `${BSE1.articlePrefix}${a.title}`));
  const wanted = titles.filter((t) => volume.has(t));
  const live: LiveArticle[] = [];
  const read = async (names: string[], use: (p: any, rev: any) => void) => {
    for (let i = 0; i < names.length; i += CHECK_BATCH) {
      const j = await api.call({ action: "query", prop: "revisions", rvprop: "content|ids|timestamp", rvslots: "main", titles: names.slice(i, i + CHECK_BATCH).join("|") });
      if (j.error) throw new Error(`Чтение страниц: ${j.error.code}`);
      for (const p of j.query.pages) if (p.revisions?.[0]) use(p, p.revisions[0]);
      await pause();
    }
  };
  await read(wanted, (p, rev) => live.push({ title: p.title, content: rev.slots.main.content, revid: rev.revid, timestamp: rev.timestamp }));
  live.sort((a, b) => wanted.indexOf(a.title) - wanted.indexOf(b.title));

  const short = new Set(live.map((l) => l.title.replace(/^БСЭ1\//, "")));
  const refs = new Map<string, { file: string; n: number }>();
  for (const a of articles) if (short.has(a.title) && a.pages.length) {
    const last = a.pages.at(-1)!;
    for (const p of [...a.pages, { file: last.file, n: last.n + 1 }]) refs.set(`Страница:${p.file}/${p.n}`, p);
  }
  const pages: SitePage[] = [];
  await read([...refs.keys()], (p, rev) => {
    const ref = refs.get(p.title);
    if (ref) pages.push({ ...ref, content: rev.slots.main.content, revid: rev.revid, timestamp: rev.timestamp });
  });
  return { live, pages: pages.sort((a, b) => a.n - b.n) };
}

if (import.meta.main) {
  const vol = volArg();
  const dir = volDir(vol);
  const publish = flag("publish"), bot = flag("bot"), qualityOnly = flag("quality-only");
  const limit = Number(arg("limit") ?? Infinity);
  const pauseS = Number(arg("pause") ?? DEFAULT_PAUSE_S);
  const testing = localTestMode;
  if (publish && !qualityOnly && !(limit > 0 && Number.isInteger(limit))) throw new Error("С --publish укажите --limit N");
  if (publish && !qualityOnly && !bot && limit > NO_BOT_LIMIT) throw new Error(`Без флага бота не больше ${NO_BOT_LIMIT} статей за запуск.`);
  if (!Number.isFinite(pauseS) || pauseS < 0 || (!testing && pauseS < DEFAULT_PAUSE_S)) throw new Error(`Пауза не меньше ${DEFAULT_PAUSE_S} с`);

  const articles = await readJsonl<Article>(`${dir}/articles.jsonl`);
  if (!articles.length) throw new Error("Сначала запустите prepare.ts");
  const reviewedFile = Bun.file(`${dir}/reviewed.txt`);
  const reviewed = new Set((await reviewedFile.exists() ? await reviewedFile.text() : "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));

  const api = new Client();
  const { live, pages } = await readSite(api, articles);
  const { ready, held, done } = planMigration(articles, live, pages);
  const journal = `${dir}/migrate-journal.jsonl`;
  const migrated = new Set((await readJsonl<{ title: string; result: string }>(journal)).filter((j) => j.result === "article-edited").map((j) => j.title));
  const fixes = qualityFixes(live, migrated);

  const out = `${dir}/migrate`;
  await rm(out, { recursive: true, force: true });
  await mkdir(`${out}/pages`, { recursive: true });
  await mkdir(`${out}/articles`, { recursive: true });
  for (const e of pageEdits(ready, pages)) await Bun.write(`${out}/pages/${String(e.page.n).padStart(4, "0")}.wiki`, e.text);
  for (const r of ready) await Bun.write(`${out}/articles/${r.article.id}.wiki`, r.articleText);
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const notReviewed = ready.filter((r) => !reviewed.has(r.article.title));
  await Bun.write(`${dir}/migrate-report.md`, [
    `# Том ${vol}: перенос статей бота на страницы индекса`, "",
    `Готово: ${ready.length}. Из них в reviewed.txt: ${ready.length - notReviewed.length}. Задержано: ${held.length}. Уже перенесено: ${done.length}.`, "",
    ...(fixes.length ? [`Перенесены раньше, КАЧЕСТВО поменяется на ${MOVED_QUALITY}: ${fixes.map((f) => f.title.replace(/^БСЭ1\//, "")).join(", ")}.`, ""] : []),
    "## Готовы к переносу", "", "| Статья | Страницы | Секция | В reviewed.txt |", "|---|---|---|---|",
    ...ready.map((r) => `| ${esc(r.article.title)} | ${r.plan.from}${r.plan.to > r.plan.from ? `–${r.plan.to}` : ""} | ${esc(r.plan.section)} | ${reviewed.has(r.article.title) ? "да" : "нет"} |`),
    "", "## Задержаны", "", "| Статья | Причина |", "|---|---|",
    ...held.map((h) => `| ${esc(h.title)} | ${esc(h.why)} |`), "",
  ].join("\n"));
  console.log(`Готово: ${ready.length}, из них в reviewed.txt: ${ready.length - notReviewed.length}. Задержано: ${held.length}. Уже перенесено: ${done.length}, из них поправить КАЧЕСТВО: ${fixes.length}. Отчёт: migrate-report.md`);

  if (!publish) {
    console.log("Режим проверки: на сайте ничего не изменено.");
    process.exit(0);
  }
  const queue = qualityOnly ? [] : ready.filter((r) => reviewed.has(r.article.title)).slice(0, limit);
  if (!queue.length && !fixes.length) { console.log("Нечего публиковать: впишите лично сверенные статьи в reviewed.txt."); process.exit(0); }
  const user = process.env.WS_BOT_USER, pass = process.env.WS_BOT_PASS;
  if (!user || !pass) throw new Error("Не заданы WS_BOT_USER и WS_BOT_PASS");
  await login(api, user, pass);
  if (bot) {
    const info = await api.call({ action: "query", meta: "userinfo", uiprop: "rights" });
    if (!info.query.userinfo.rights?.includes("bot")) throw new Error("У учётной записи нет флага бота. Запустите без --bot.");
  }
  const token = await csrfToken(api);
  const log =(title: string, result: string, extra: object = {}) => appendFile(journal, JSON.stringify({ title, result, at: new Date().toISOString(), ...extra }) + "\n");
  const stop = async (title: string, response: unknown): Promise<never> => {
    await log(title, "stopped", { response });
    console.log("ОСТАНОВКА на", title, JSON.stringify(response));
    process.exit(1);
  };
  const flags = { assert: bot ? "bot" : "user", ...(bot ? { bot: "1" } : {}), nocreate: "1", token };
  let first = true;
  const wait = async () => { if (!first) await sleep(pauseS * 1000); first = false; };

  for (const f of fixes) {
    await wait();
    const res = await api.call({ action: "edit", title: f.title, text: f.text, summary: QUALITY_EDIT, baserevid: String(f.revid), basetimestamp: f.timestamp, minor: "1", ...flags });
    if (res.edit?.result !== "Success") await stop(f.title, res.error ?? res.edit);
    await log(f.title, "quality-set", { revid: res.edit.newrevid });
    console.log("КАЧЕСТВО", f.title);
  }
  for (const e of pageEdits(queue, pages)) {
    const title = `Страница:${e.page.file}/${e.page.n}`;
    await wait();
    const res = await api.call({ action: "edit", title, text: e.text, summary: PAGE_EDIT(e.count), baserevid: String(e.page.revid), basetimestamp: e.page.timestamp, ...flags });
    if (res.edit?.result !== "Success") await stop(title, res.error ?? res.edit);
    await log(title, "page-edited", { revid: res.edit.newrevid });
    console.log("страница", e.page.n);
  }
  let moved = 0;
  for (const r of queue) {
    const title = `БСЭ1/${r.article.title}`;
    const shown = await api.call({ action: "parse", title, text: renderPagesTag(r.plan), prop: "text", contentmodel: "wikitext", disablelimitreport: "1", disableeditsection: "1" });
    if (shown.error) await stop(title, shown.error);
    const problems = checkRendered(r.body, shown.parse.text, r.plan, 1);
    if (problems.length) await stop(title, { сверка: problems });
    await wait();
    const res = await api.call({ action: "edit", title, text: r.articleText, summary: ARTICLE_EDIT, baserevid: String(r.revid), basetimestamp: r.timestamp, ...flags });
    if (res.edit?.result !== "Success") await stop(title, res.error ?? res.edit);
    await log(title, "article-edited", { revid: res.edit.newrevid });
    moved++;
    console.log("статья", r.article.title);
  }
  console.log(`Перенесено статей: ${moved}.`);
}
