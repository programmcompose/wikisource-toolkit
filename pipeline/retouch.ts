// Правка оформления в статьях, которые уже создал бот: разрядка и КАЧЕСТВО = 3 у статей из вычитанных страниц.
//   bun pipeline/retouch.ts                                — проверка: показывает правки, на сайте ничего не меняет
//   bun pipeline/retouch.ts --publish --limit 5            — без флага бота не больше 20 статей за запуск
// Текст статей не меняется. Состояние читается с сайта, поэтому запуск можно повторять. При чужой правке сайт
// вернёт конфликт, и скрипт остановится. Пароль задаётся только переменными WS_BOT_USER и WS_BOT_PASS.
import { Client, arg, csrfToken, flag, login, sleep, localTestMode } from "./lib";
import { fixRazr } from "./parse";
import { pageLevel } from "./summary";
import { BSE1 } from "./profile";

const BOT_ACCOUNT = "SlovarBot";
const NO_BOT_LIMIT = 20;
const DEFAULT_PAUSE_S = 30;
const BOT_MIN_PAUSE_S = 5;
const BATCH = 40;

export type PageRange = { file: string; from: number; to: number };

export function pageRanges(content: string): PageRange[] {
  return [...content.matchAll(/<pages\s[^>]*?index="([^"]+)"[^>]*?\sfrom=(\d+)[^>]*?\sto=(\d+)/g)]
    .map((m) => ({ file: m[1], from: Number(m[2]), to: Number(m[3]) }));
}

export function retouchArticle(content: string, pagesProofread: boolean): { text: string; changes: string[] } {
  const changes: string[] = [];
  let text = fixRazr(content);
  if (text !== content) changes.push("разрядка: {{razr}} перед пробелом, {{razr2}} перед знаком препинания");
  if (pagesProofread) {
    const set = text.replace(/(\|\s*КАЧЕСТВО\s*=)[ \t]*(?=\n|\||\}\})/, "$1 3");
    if (set !== text) changes.push("КАЧЕСТВО = 3 по уровню страниц индекса");
    text = set;
  }
  return { text, changes };
}

if (import.meta.main) {
  const testing = localTestMode;
  const publish = flag("publish");
  const bot = flag("bot");
  const limit = Number(arg("limit") ?? Infinity);
  const pauseS = Number(arg("pause") ?? DEFAULT_PAUSE_S);
  if (publish && !(limit > 0 && Number.isInteger(limit))) throw new Error("С --publish укажите --limit N");
  if (publish && !bot && limit > NO_BOT_LIMIT) throw new Error(`Без флага бота не больше ${NO_BOT_LIMIT} статей за запуск`);
  if (!Number.isFinite(pauseS) || pauseS < 0 || (!testing && pauseS < (bot ? BOT_MIN_PAUSE_S : DEFAULT_PAUSE_S))) throw new Error(`Пауза не меньше ${bot ? BOT_MIN_PAUSE_S : DEFAULT_PAUSE_S} с`);

  const api = new Client();
  const wait = () => sleep(testing ? 0 : 1500);
  const titles: string[] = [];
  let cont: Record<string, string> = {};
  do {
    const j = await api.call({ action: "query", list: "usercontribs", ucuser: BOT_ACCOUNT, uclimit: "500", ucshow: "new", ucnamespace: "0", ucprop: "title", ...cont });
    if (j.error) throw new Error(`Вклад бота: ${j.error.code}`);
    titles.push(...j.query.usercontribs.map((c: any) => c.title).filter((t: string) => t.startsWith("БСЭ1/")));
    cont = j.continue ?? {};
    await wait();
  } while (Object.keys(cont).length);

  const articles: { title: string; content: string; revid: number }[] = [];
  for (let i = 0; i < titles.length; i += BATCH) {
    const j = await api.call({ action: "query", prop: "revisions", rvprop: "ids|content", rvslots: "main", titles: titles.slice(i, i + BATCH).join("|") });
    if (j.error) throw new Error(`Чтение статей: ${j.error.code}`);
    for (const p of j.query.pages) if (!p.missing) articles.push({ title: p.title, content: p.revisions[0].slots.main.content, revid: p.revisions[0].revid });
    await wait();
  }

  const pageTitle = (file: string, n: number) => `${BSE1.pageNamespace}:${file}/${n}`;
  const wanted = new Set<string>();
  for (const a of articles) for (const r of pageRanges(a.content)) for (let n = r.from; n <= r.to; n++) wanted.add(pageTitle(r.file, n));
  const levels = new Map<string, string>();
  const list = [...wanted];
  for (let i = 0; i < list.length; i += BATCH) {
    const j = await api.call({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: list.slice(i, i + BATCH).join("|") });
    if (j.error) throw new Error(`Чтение страниц индекса: ${j.error.code}`);
    for (const p of j.query.pages) if (!p.missing) levels.set(p.title, pageLevel(p.revisions[0].slots.main.content) ?? "");
    await wait();
  }
  const proofread = (content: string) => {
    const ranges = pageRanges(content);
    if (!ranges.length) return false;
    return ranges.every((r) => { for (let n = r.from; n <= r.to; n++) if (!["3", "4"].includes(levels.get(pageTitle(r.file, n)) ?? "")) return false; return true; });
  };

  const queue = articles.flatMap((a) => {
    const { text, changes } = retouchArticle(a.content, proofread(a.content));
    return changes.length ? [{ ...a, text, changes }] : [];
  });
  console.log(`Статей бота: ${articles.length}. Нужна правка: ${queue.length}.`);
  for (const q of queue) console.log(`  ${q.title}: ${q.changes.join("; ")}`);
  if (!publish) {
    console.log("Режим проверки: ничего не опубликовано.");
    process.exit(0);
  }

  const user = process.env.WS_BOT_USER, pass = process.env.WS_BOT_PASS;
  if (!user || !pass) throw new Error("Не заданы WS_BOT_USER и WS_BOT_PASS");
  await login(api, user, pass);
  const token = await csrfToken(api);
  let edited = 0;
  for (const q of queue) {
    if (edited >= limit) break;
    if (edited > 0) await sleep(pauseS * 1000);
    const res = await api.call({
      action: "edit", title: q.title, text: q.text, baserevid: String(q.revid), nocreate: "1", token,
      summary: `Оформление по обсуждению проекта БСЭ1: ${q.changes.join("; ")}. Текст не менялся.`,
      assert: bot ? "bot" : "user", ...(bot ? { bot: "1" } : {}),
    });
    if (res.edit?.result !== "Success") {
      console.log("ОСТАНОВКА на", q.title, JSON.stringify(res.error ?? res.edit));
      process.exit(1);
    }
    edited++;
    console.log("исправлена", q.title);
  }
  console.log(`Исправлено: ${edited}.`);
}
