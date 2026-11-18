// Заливка пробы разметки на страницы индекса. Уровень страниц остаётся 1.
//   bun pipeline/pilot-upload.ts --dir pilot/60 --file "БСЭ-1 Том 60. Холангит - Цянь (1934).pdf"   — проверка, на сайте ничего не меняет
//   ... --publish --limit 5                                                                          — публикация
// Страница заливается, только если на сайте она на уровне 1, совпадает со снимком ocr/N.wiki, с которого делалась
// разметка, и её не включает ни одна статья. Запуск можно повторять: уже залитые страницы пропускаются.
// При чужой правке сайт вернёт конфликт, и скрипт остановится. Пароль задаётся только переменными WS_BOT_USER и WS_BOT_PASS.
//
// С --reviewed заливаются только страницы из reviewed.txt в папке пробы (номер страницы на строку, # — комментарий),
// и им ставится уровень 3. Номер туда вписывает оператор, только после личной сверки страницы со сканом на стенде.
// Остальные страницы в этом режиме не трогаются. Страницу, уже залитую пробой на уровне 1, скрипт поднимает до 3,
// если её текст на сайте не менялся.
import { appendFile, readdir } from "fs/promises";
import { resolve } from "path";
import { Client, arg, csrfToken, flag, login, sleep, localTestMode } from "./lib";
import { BSE1 } from "./profile";
import { sectionTags } from "./pilot";
import { pageLevel } from "./summary";

const MAX_PAGES = 5;
const DEFAULT_PAUSE_S = 30;
const SUMMARY = "Проба разметки по обсуждению проекта БСЭ1: текст подготовил ИИ (Claude) по скану: порядок столбцов, исправление OCR, секции, разрядка, таблицы, заглушки рисунков. Требует вычитки человеком, уровень 1.";
const SUMMARY_REVIEWED = "Вычитка по скану (проект БСЭ1): разметку подготовил ИИ (Claude), оператор сверил страницу со сканом, уровень 3.";

const same = (a: string, b: string) => a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();

// Номера страниц, которые оператор сверил: по одному на строку, после # комментарий.
export function parseReviewed(text: string): number[] {
  const out: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (!/^\d+$/.test(line)) throw new Error(`reviewed.txt: не номер страницы: «${raw}»`);
    out.push(Number(line));
  }
  return out;
}

// Текст для публикации после сверки: та же разметка, но уровень 3. Поднимается только уровень 1.
export function raiseLevel(model: string, user: string): string {
  const re = /<pagequality level="1" user="[^"]*" \/>/;
  if (!re.test(model)) throw new Error("в разметке нет отметки уровня 1");
  return model.replace(re, `<pagequality level="3" user="${user}" />`);
}

// Служебная часть страницы: шапка и подвал вокруг текста. Разметка не должна их менять.
export function frame(content: string): string | null {
  const m = content.replace(/\r\n/g, "\n").trim().match(/^(<noinclude>[\s\S]*?<\/noinclude>)[\s\S]*(<noinclude>(?:(?!<noinclude>)[\s\S])*<\/noinclude>)$/);
  return m ? `${m[1]}${m[2]}` : null;
}

export type Decision = { status: "ready" | "done" | "held"; why?: string };

// target — текст, который будет залит: разметка как есть или она же с уровнем 3 после сверки.
export function decide(model: string, snapshot: string, live: string | null, usedBy: string[], target = model): Decision {
  if (live === null) return { status: "held", why: "страницы нет на сайте" };
  if (same(live, target)) return { status: "done" };
  // Своя проба, залитая раньше на уровне 1: после сверки меняется только уровень.
  if (target !== model && same(live, model)) {
    if (usedBy.length) return { status: "held", why: `страницу включают: ${usedBy.join(", ")}` };
    return { status: "ready" };
  }
  if (pageLevel(live) !== "1") return { status: "held", why: `на сайте уровень ${pageLevel(live) ?? "не указан"}` };
  if (!same(live, snapshot)) return { status: "held", why: "страницу правили после снимка, с которого делалась разметка" };
  if (pageLevel(model) !== "1") return { status: "held", why: "в разметке уровень не 1" };
  const f = frame(model);
  if (!f || f !== frame(live)) return { status: "held", why: "разметка меняет шапку или подвал страницы" };
  if (usedBy.length) return { status: "held", why: `страницу включают: ${usedBy.join(", ")}` };
  return { status: "ready" };
}

// Секции, которые переходят на соседние страницы. На правку это не влияет, вычитывающему нужно знать о разрывах.
export function sectionGaps(model: string, live: string, prev: string, next: string): string[] {
  const gaps: string[] = [];
  const now = sectionTags(model), was = sectionTags(live);
  for (const name of now.closed) if (!prev.includes(`begin="${name}"`)) gaps.push(`секция «${name}» закрыта здесь, но на предыдущей странице нет её начала`);
  for (const name of now.opened) if (!next.includes(`end="${name}"`)) gaps.push(`секция «${name}» открыта здесь, но на следующей странице нет её конца`);
  for (const name of was.closed) if (!now.closed.includes(name) && prev.includes(`begin="${name}"`)) gaps.push(`на предыдущей странице осталось начало секции «${name}», а её конец здесь убран`);
  for (const name of was.opened) if (!now.opened.includes(name) && next.includes(`end="${name}"`)) gaps.push(`на следующей странице остался конец секции «${name}», а её начало здесь убрано`);
  return gaps;
}

if (import.meta.main) {
  const testing = localTestMode;
  const dir = resolve(arg("dir") ?? ".");
  const file = arg("file");
  if (!file) throw new Error("Укажите --file с именем файла индекса");
  const publish = flag("publish");
  const reviewedMode = flag("reviewed");
  const limit = Number(arg("limit") ?? Infinity);
  const pauseS = Number(arg("pause") ?? DEFAULT_PAUSE_S);
  if (publish && !(limit > 0 && Number.isInteger(limit))) throw new Error("С --publish укажите --limit N");
  if (publish && limit > MAX_PAGES) throw new Error(`Это проба: не больше ${MAX_PAGES} страниц за запуск`);
  if (!Number.isFinite(pauseS) || pauseS < 0 || (!testing && pauseS < DEFAULT_PAUSE_S)) throw new Error(`Пауза не меньше ${DEFAULT_PAUSE_S} с`);

  const title = (n: number) => `${BSE1.pageNamespace}:${file}/${n}`;
  const modelPages = (await readdir(`${dir}/model`)).map((f) => Number(f.replace(".wiki", ""))).sort((a, b) => a - b);
  let list = modelPages;
  // Уровень 3 ставится от имени учётной записи, которая публикует. Без неё режим сверки нельзя даже проверить:
  // иначе проверка покажет не тот текст, который уйдёт на сайт.
  const account = (process.env.WS_BOT_USER ?? "").split("@")[0];
  if (reviewedMode) {
    const path = `${dir}/reviewed.txt`;
    if (!(await Bun.file(path).exists())) throw new Error(`Нет ${path}: впишите туда номера страниц, которые сверили со сканом`);
    const reviewed = parseReviewed(await Bun.file(path).text());
    const unknown = reviewed.filter((n) => !modelPages.includes(n));
    if (unknown.length) throw new Error(`В reviewed.txt страницы без разметки: ${unknown.join(", ")}`);
    if (!account) throw new Error("Для --reviewed задайте WS_BOT_USER: от этой учётной записи ставится уровень 3");
    list = modelPages.filter((n) => reviewed.includes(n));
    console.log(`Режим сверки: страниц в reviewed.txt ${list.length} из ${modelPages.length}, уровень 3 от имени ${account}.`);
    if (!list.length) {
      console.log("К заливке: 0. Сверенных страниц нет, на сайте ничего не изменено.");
      process.exit(0);
    }
  }
  const api = new Client();
  const names = [...new Set(list.flatMap((n) => [n - 1, n, n + 1]))].map(title);
  const revs = await api.call({ action: "query", prop: "revisions", rvprop: "ids|timestamp|content", rvslots: "main", titles: names.join("|") });
  if (revs.error) throw new Error(`Чтение страниц: ${revs.error.code}`);
  const live = new Map<string, { content: string; revid: number; timestamp: string }>();
  for (const p of revs.query.pages) if (p.revisions?.[0]) live.set(p.title, { content: p.revisions[0].slots.main.content, revid: p.revisions[0].revid, timestamp: p.revisions[0].timestamp });

  const used = new Map<string, string[]>();
  let cont: Record<string, string> = {};
  do {
    await sleep(testing ? 0 : 1500);
    const j = await api.call({ action: "query", prop: "transcludedin", tiprop: "title", tilimit: "500", titles: list.map(title).join("|"), ...cont });
    if (j.error) throw new Error(`Проверка включений: ${j.error.code}`);
    // Страница индекса включает все свои страницы, это не статья.
    for (const p of j.query.pages) for (const t of p.transcludedin ?? []) if (t.title !== `${BSE1.indexNamespace}:${file}`) used.set(p.title, [...(used.get(p.title) ?? []), t.title]);
    cont = j.continue ?? {};
  } while (Object.keys(cont).length);

  const queue: { n: number; text: string; revid: number; timestamp: string }[] = [];
  for (const n of list) {
    const model = await Bun.file(`${dir}/model/${n}.wiki`).text();
    const snapshot = await Bun.file(`${dir}/ocr/${n}.wiki`).text();
    const page = live.get(title(n));
    const target = reviewedMode ? raiseLevel(model, account) : model;
    const d = decide(model, snapshot, page?.content ?? null, used.get(title(n)) ?? [], target);
    console.log(`стр. ${n}: ${d.status === "ready" ? "готова" : d.status === "done" ? "уже залита" : `задержана, ${d.why}`}`);
    if (page) for (const g of sectionGaps(model, page.content, live.get(title(n - 1))?.content ?? "", live.get(title(n + 1))?.content ?? "")) console.log(`  ${g}`);
    if (d.status === "ready") queue.push({ n, text: target.replace(/\r\n/g, "\n").trim(), revid: page!.revid, timestamp: page!.timestamp });
  }
  console.log(`К заливке: ${queue.length}.`);
  if (!publish) {
    console.log("Режим проверки: на сайте ничего не изменено.");
    process.exit(0);
  }

  const user = process.env.WS_BOT_USER, pass = process.env.WS_BOT_PASS;
  if (!user || !pass) throw new Error("Не заданы WS_BOT_USER и WS_BOT_PASS");
  await login(api, user, pass);
  const token = await csrfToken(api);
  const journal = `${dir}/upload-journal.jsonl`;
  let edited = 0;
  for (const q of queue) {
    if (edited >= limit) break;
    if (edited > 0) await sleep(pauseS * 1000);
    const res = await api.call({ action: "edit", title: title(q.n), text: q.text, summary: reviewedMode ? SUMMARY_REVIEWED : SUMMARY, baserevid: String(q.revid), basetimestamp: q.timestamp, nocreate: "1", assert: "user", token });
    const ok = res.edit?.result === "Success";
    await appendFile(journal, JSON.stringify({ page: q.n, result: ok ? "edited" : "stopped", level: reviewedMode ? 3 : 1, at: new Date().toISOString(), ...(ok ? { revid: res.edit.newrevid } : { response: res.error ?? res.edit }) }) + "\n");
    if (!ok) {
      console.log("ОСТАНОВКА на странице", q.n, JSON.stringify(res.error ?? res.edit));
      process.exit(1);
    }
    edited++;
    console.log("залита страница", q.n);
  }
  console.log(`Залито: ${edited}. Журнал: ${journal}`);
}
