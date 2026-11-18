// Шаг 4. Создаёт страницы из vols/NN/manifest.jsonl. Существующие страницы не меняет (createonly).
//   bun pipeline/upload.ts --vol 58                         — проверка: ничего не публикует, пароль не нужен
//   bun pipeline/upload.ts --vol 58 --publish --limit 20    — без флага бота, не больше 50 статей за запуск
//   bun pipeline/upload.ts --vol 58 --publish --limit 500 --bot — с флагом бота
//   --manifest pages берёт статьи из transclude.ts: vols/NN/manifest-pages.jsonl. Журнал общий.
// Пароль задаётся только переменными WS_BOT_USER и WS_BOT_PASS. Запуск можно повторять: журнал
// vols/NN/journal.jsonl хранит результат каждой статьи. Капчу и фильтры правок скрипт не обходит:
// на любом неизвестном отказе он останавливается и показывает ответ сервера.
import { appendFile } from "fs/promises";
import { API, Client, arg, csrfToken, flag, login, readJsonl, sleep, volArg, volDir, localTestMode } from "./lib";
import type { ManifestRow } from "./build";

const NO_BOT_LIMIT = 50;
const CHECK_BATCH = 50;
const DEFAULT_PAUSE_S = 30;
const BOT_MIN_PAUSE_S = 5;
const testing = localTestMode; // локальный тестовый сервер

const vol = volArg();
const dir = volDir(vol);
const publish = flag("publish");
const bot = flag("bot");
const limit = Number(arg("limit") ?? Infinity);
const pauseS = Number(arg("pause") ?? DEFAULT_PAUSE_S);

if (publish && !(limit > 0 && Number.isInteger(limit))) throw new Error("С --publish укажите --limit N");
if (publish && !bot && limit > NO_BOT_LIMIT) throw new Error(`Без флага бота не больше ${NO_BOT_LIMIT} статей за запуск: массовая заливка забьёт свежие правки.`);
if (!Number.isFinite(pauseS) || pauseS < 0 || (!testing && pauseS < (bot ? BOT_MIN_PAUSE_S : DEFAULT_PAUSE_S))) throw new Error(`Пауза не меньше ${bot ? BOT_MIN_PAUSE_S : DEFAULT_PAUSE_S} с`);

const manifestKind = arg("manifest");
if (manifestKind !== undefined && manifestKind !== "pages") throw new Error("--manifest принимает только значение pages");
const manifest = await readJsonl<ManifestRow>(`${dir}/${manifestKind ? "manifest-pages.jsonl" : "manifest.jsonl"}`);
if (!manifest.length) throw new Error(`Манифест пуст: сначала запустите ${manifestKind ? "transclude.ts" : "build.ts"}`);
for (const [i, row] of manifest.entries()) {
  if (typeof row?.title !== "string" || !row.title.trim() || typeof row.page !== "string" || !row.page.trim()
      || typeof row.summary !== "string" || !row.summary.trim() || typeof row.file !== "string"
      || !/^wiki(?:-pages)?\/[^/\\:]+\.wiki$/.test(row.file)) {
    throw new Error(`Некорректная строка манифеста: ${i + 1}`);
  }
}
const journalPath = `${dir}/journal.jsonl`;
const done = new Set((await readJsonl<{ title: string; result: string }>(journalPath)).filter((j) => j.result === "created" || j.result === "exists").map((j) => j.title));
const log = (title: string, result: string, extra: object = {}) =>
  appendFile(journalPath, JSON.stringify({ title, result, at: new Date().toISOString(), ...extra }) + "\n");

const api = new Client();
const remaining = manifest.filter((m) => !done.has(m.title));

// Проверка наличия страниц порциями, а не по одной.
const onSite = new Set<string>();
for (let i = 0; i < remaining.length; i += CHECK_BATCH) {
  const j = await api.call({ action: "query", titles: remaining.slice(i, i + CHECK_BATCH).map((m) => m.page).join("|") });
  if (j.error) throw new Error(`Проверка страниц: ${j.error.code}`);
  for (const p of j.query.pages) if (!p.missing) onSite.add(p.title);
  await sleep(testing ? 0 : 1500);
}
const queue = remaining.filter((m) => !onSite.has(m.page));
console.log(`В манифесте: ${manifest.length}. Уже в журнале: ${done.size}. Появились на сайте: ${remaining.length - queue.length}. К созданию: ${queue.length}.`);
if (!publish) {
  for (const m of queue.slice(0, 10)) console.log("создать:", m.page);
  console.log("Режим проверки: ничего не опубликовано.");
  process.exit(0);
}

const user = process.env.WS_BOT_USER, pass = process.env.WS_BOT_PASS;
if (!user || !pass) throw new Error("Не заданы WS_BOT_USER и WS_BOT_PASS");
for (const m of remaining) if (onSite.has(m.page)) await log(m.title, "exists");

const signIn = () => login(api, user!, pass!);
const csrf = () => csrfToken(api);

await signIn();
if (bot) {
  const info = await api.call({ action: "query", meta: "userinfo", uiprop: "rights" });
  if (!info.query.userinfo.rights?.includes("bot")) throw new Error("У учётной записи нет флага бота. Запустите без --bot.");
}
let token = await csrf();
console.log(`API: ${API}`);

let created = 0;
for (const m of queue) {
  if (created >= limit) break;
  const text = await Bun.file(`${dir}/${m.file}`).text();
  // Последняя защита на случай правки файла после build.ts.
  if (/\{\{\s*БСЭ1\/Автор|<section|<noinclude/.test(text)) {
    console.log("ОСТАНОВКА: запрещённая разметка в", m.file);
    process.exit(1);
  }
  if (created > 0) await sleep(pauseS * 1000);
  const params: Record<string, string> = {
    action: "edit", title: m.page, text, summary: m.summary, createonly: "1",
    assert: bot ? "bot" : "user", ...(bot ? { bot: "1" } : {}),
  };
  let res = await api.call({ ...params, token });
  if (res.error?.code === "badtoken" || res.error?.code === "assertuserfailed" || res.error?.code === "assertbotfailed") {
    // Сессия истекла: один повторный вход. Если нет флага бота, проверка выше уже остановила бы запуск.
    await signIn();
    token = await csrf();
    res = await api.call({ ...params, token });
  }
  if (res.error?.code === "articleexists") {
    await log(m.title, "exists");
    console.log("уже есть", m.page);
    continue;
  }
  if (res.edit?.result !== "Success") {
    await log(m.title, "stopped", { response: res.error ?? res.edit });
    console.log("ОСТАНОВКА на", m.page, JSON.stringify(res.error ?? res.edit));
    process.exit(1);
  }
  await log(m.title, "created", { revid: res.edit.newrevid });
  created++;
  console.log("создана", m.page);
}
console.log(`Создано: ${created}.`);
