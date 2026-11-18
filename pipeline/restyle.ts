// Правка оформления страниц индекса БСЭ1, залитых по разметке ИИ, по правилам pipeline/style.ts (замечания Egor, 12 ноября 2026).
//   bun pipeline/restyle.ts                         — проверка: что изменится, на сайте ничего не меняет
//   bun pipeline/restyle.ts --publish --limit 20    — публикация
// Берутся страницы, которые SlovarBot заливал с описанием «Вычитка по скану» или «Проба разметки». Правится текущий текст
// страницы, кто бы его ни правил последним; уровень страницы не меняется. При чужой правке между чтением и записью
// сайт вернёт конфликт, и скрипт остановится. Запуск можно повторять: исправленные страницы пропускаются.
import { appendFile } from "fs/promises";
import { Client, arg, csrfToken, flag, login, sleep, localTestMode } from "./lib";
import { fixStyle, lintStyle, lsafeTargets } from "./style";

const NO_BOT_LIMIT = 20;
const DEFAULT_PAUSE_S = 30;
const SUMMARY = "Оформление по замечаниям Egor и Vladis13 (обсуждение проекта БСЭ1, 12–14 ноября): ";
const OURS = /^(Вычитка по скану|Проба разметки)/;

if (import.meta.main) {
  const testing = localTestMode;
  const publish = flag("publish");
  const limit = Number(arg("limit") ?? Infinity);
  const pauseS = Number(arg("pause") ?? DEFAULT_PAUSE_S);
  if (publish && !(limit > 0 && limit <= NO_BOT_LIMIT)) throw new Error(`С --publish укажите --limit от 1 до ${NO_BOT_LIMIT}`);
  if (!Number.isFinite(pauseS) || pauseS < 0 || (!testing && pauseS < DEFAULT_PAUSE_S)) throw new Error(`Пауза не меньше ${DEFAULT_PAUSE_S} с`);
  const wait = () => sleep(testing ? 0 : 1500);

  const api = new Client();
  const titles = new Set<string>();
  let cont: Record<string, string> = {};
  do {
    const j = await api.call({ action: "query", list: "usercontribs", ucuser: "SlovarBot", ucnamespace: "104", uclimit: "500", ucprop: "title|comment", ...cont });
    if (j.error) throw new Error(`Вклад SlovarBot: ${j.error.code}`);
    for (const c of j.query.usercontribs) if (c.title.includes("БСЭ-1") && OURS.test(c.comment ?? "")) titles.add(c.title);
    cont = j.continue ?? {};
    await wait();
  } while (Object.keys(cont).length);

  const queue: { title: string; text: string; revid: number; timestamp: string; changes: string[] }[] = [];
  const targets = new Map<string, string[]>();
  const list = [...titles].sort();
  for (let i = 0; i < list.length; i += 50) {
    const r = await api.call({ action: "query", prop: "revisions", rvprop: "ids|timestamp|content", rvslots: "main", titles: list.slice(i, i + 50).join("|") });
    if (r.error) throw new Error(`Чтение страниц: ${r.error.code}`);
    for (const p of r.query.pages) {
      const v = p.revisions?.[0];
      if (!v) continue;
      const content: string = v.slots.main.content;
      const { text, changes } = fixStyle(content);
      for (const t of lsafeTargets(text)) targets.set(t, [...(targets.get(t) ?? []), p.title]);
      for (const w of lintStyle(content)) console.log(`${p.title}: ⚠ ${w}`);
      if (changes.length) queue.push({ title: p.title, text, revid: v.revid, timestamp: v.timestamp, changes });
    }
    await wait();
  }
  queue.sort((a, b) => a.title.localeCompare(b.title, "ru", { numeric: true }));
  for (const q of queue) console.log(`${q.title}: ${q.changes.join("; ")}`);
  console.log(`Страниц: ${titles.size}, к правке: ${queue.length}.`);

  // Ссылки {{lsafe}} на статьи, которых нет на сайте: имя могло разойтись со словником. Только отчёт.
  const names = [...targets.keys()];
  const missing: string[] = [];
  for (let i = 0; i < names.length; i += 50) {
    const r = await api.call({ action: "query", titles: names.slice(i, i + 50).map((n) => `БСЭ1/${n}`).join("|") });
    for (const p of r.query.pages) if (p.missing !== undefined) missing.push(p.title.replace(/^БСЭ1\//, ""));
    await wait();
  }
  // Имена из всех словников (vols/*/articles.jsonl): если имени там нет, ссылка, скорее всего, разошлась со словником.
  const slovnik = new Set<string>();
  for (const f of new Bun.Glob("vols/*/articles.jsonl").scanSync())
    for (const line of (await Bun.file(f).text()).split("\n")) if (line.trim()) slovnik.add(JSON.parse(line).title);
  const where = (m: string) => [...new Set(targets.get(m))].map((t) => t.replace(/^.*Том (\d+).*\/(\d+)$/, "т. $1 стр. $2")).join(", ");
  const unknown = missing.filter((m) => !slovnik.has(m)).sort();
  console.log(`Ссылок {{lsafe}}: ${names.length}, статей нет на сайте: ${missing.length}, из них имени нет ни в одном словнике: ${unknown.length}.`);
  await Bun.write("restyle-missing-lsafe.txt",
    `# Имени нет ни в одном словнике — проверить ссылку\n${unknown.map((m) => `${m}\t${where(m)}`).join("\n")}\n\n# Есть в словнике, статьи пока нет\n${missing.filter((m) => slovnik.has(m)).sort().map((m) => `${m}\t${where(m)}`).join("\n")}\n`);

  if (!publish) {
    console.log("Режим проверки: на сайте ничего не изменено. Список ссылок без статей: restyle-missing-lsafe.txt");
    process.exit(0);
  }
  const user = process.env.WS_BOT_USER, pass = process.env.WS_BOT_PASS;
  if (!user || !pass) throw new Error("Не заданы WS_BOT_USER и WS_BOT_PASS");
  await login(api, user, pass);
  const token = await csrfToken(api);
  let edited = 0;
  for (const q of queue) {
    if (edited >= limit) break;
    if (edited > 0) await sleep(testing ? 0 : pauseS * 1000);
    const res = await api.call({ action: "edit", title: q.title, text: q.text, summary: SUMMARY + q.changes.join("; "), minor: "1", baserevid: String(q.revid), basetimestamp: q.timestamp, nocreate: "1", assert: "user", token });
    const ok = res.edit?.result === "Success";
    await appendFile("restyle-journal.jsonl", JSON.stringify({ title: q.title, result: ok ? "edited" : "stopped", at: new Date().toISOString(), ...(ok ? { revid: res.edit.newrevid } : { response: res.error ?? res.edit }) }) + "\n");
    if (!ok) {
      console.log("ОСТАНОВКА на", q.title, JSON.stringify(res.error ?? res.edit));
      process.exit(1);
    }
    edited++;
    console.log("исправлена", q.title);
  }
  console.log(`Исправлено: ${edited}, осталось: ${queue.length - edited}.`);
}
