// Точечные правки разметки на страницах индекса: секции, теги, явные опечатки по скану.
// bun tools/pagefix.ts <папка>              — берёт страницы с сайта, применяет fixes.json, пишет before/, after/, README.md
// bun tools/pagefix.ts <папка> --publish    — то же и публикует (WS_BOT_USER/WS_BOT_PASS из work/.env)
// fixes.json: { "file": "БСЭ-1 Том 60. … .pdf", "summary": "…", "fixes": { "14": [["было", "стало", "пояснение правки текста"?]] } }
// Каждое «было» должно встречаться на странице ровно один раз. Уровень страницы, шапка и подвал вне правок не меняются.
// Публикация идёт с baserevid: если страницу успели поправить, сайт вернёт конфликт и скрипт остановится.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { Client, csrfToken, login, sleep } from "../pipeline/lib";

type Fix = [string, string, string?];
const dir = process.argv[2];
const publish = process.argv.includes("--publish");
const cfg: { file: string; summary: string; fixes: Record<string, Fix[]> } = JSON.parse(readFileSync(`${dir}/fixes.json`, "utf8"));
const title = (n: string) => `Страница:${cfg.file}/${n}`;
const words = (s: string) => s.replace(/<section[^>]*\/?>/g, " ").replace(/'''/g, "").toLowerCase().replace(/ё/g, "е").match(/[\p{L}0-9]+/gu) ?? [];

function lineDiff(a: string, b: string): string {
  const x = a.split("\n"), y = b.split("\n");
  const L = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: string[] = [];
  const cut = (s: string) => (s.length > 220 ? s.slice(0, 220) + "…" : s);
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { i++; j++; }
    else if (j < y.length && (i === x.length || L[i][j + 1] >= L[i + 1][j])) out.push("+ " + cut(y[j++]));
    else out.push("- " + cut(x[i++]));
  }
  return out.join("\n");
}

const api = new Client();
const ns = Object.keys(cfg.fixes);
const q = await api.call({ action: "query", prop: "revisions", rvprop: "content|ids|timestamp", rvslots: "main", titles: ns.map(title).join("|") }, false);
const live = new Map<string, { content: string; revid: number; timestamp: string }>();
for (const p of q.query.pages) {
  const r = p.revisions?.[0];
  if (!r) throw new Error(`нет страницы ${p.title}`);
  live.set(p.title, { content: r.slots.main.content, revid: r.revid, timestamp: r.timestamp });
}

mkdirSync(`${dir}/before`, { recursive: true });
mkdirSync(`${dir}/after`, { recursive: true });
const readme: string[] = [`# Правки разметки: ${cfg.file}\n`, `Снимок с сайта ${new Date().toISOString().slice(0, 16)} UTC. Описание правки: «${cfg.summary}».\n`];
const edits: { n: string; text: string; revid: number; timestamp: string }[] = [];
for (const n of ns) {
  const page = live.get(title(n))!;
  let c = page.content;
  for (const [from, to] of cfg.fixes[n]) {
    const count = c.split(from).length - 1;
    if (count !== 1) throw new Error(`стр. ${n}: «${from.slice(0, 60)}» найдено ${count} раз`);
    c = c.replace(from, () => to);
  }
  writeFileSync(`${dir}/before/${n}.wiki`, page.content);
  writeFileSync(`${dir}/after/${n}.wiki`, c);
  const same = words(page.content).join(" ") === words(c).join(" ");
  const notes = cfg.fixes[n].filter((f) => f[2]).map((f) => f[2]);
  const level = page.content.match(/<pagequality level="(\d)" user="([^"]*)"/);
  const tags = [...c.matchAll(/<section (begin|end)="([^"]*)"\s*\/>/g)].map((m) => (m[1] === "begin" ? "+" : "−") + m[2]).join(" ");
  console.log(`стр. ${n} (ур. ${level?.[1]} ${level?.[2]}): правок ${cfg.fixes[n].length}; слова ${same ? "не изменились" : "изменились"}${notes.length ? " — " + notes.join("; ") : ""}`);
  console.log("   ", tags);
  readme.push(`## Стр. ${n}\nУровень ${level?.[1]} (${level?.[2]}), слова ${same ? "не изменились" : "изменились: " + notes.join("; ")}.\n\`\`\`diff\n${lineDiff(page.content, c)}\n\`\`\``);
  edits.push({ n, text: c, ...page });
}
writeFileSync(`${dir}/README.md`, readme.join("\n") + "\n");

if (publish) {
  const user = process.env.WS_BOT_USER, pass = process.env.WS_BOT_PASS;
  if (!user || !pass) throw new Error("Не заданы WS_BOT_USER и WS_BOT_PASS");
  await login(api, user, pass);
  const token = await csrfToken(api);
  for (const e of edits) {
    if (e.text === e.content) continue;
    const res = await api.call({ action: "edit", title: title(e.n), text: e.text, summary: cfg.summary, baserevid: String(e.revid), basetimestamp: e.timestamp, nocreate: "1", assert: "user", token });
    const ok = res.edit?.result === "Success";
    appendFileSync(`${dir}/journal.jsonl`, JSON.stringify({ page: e.n, ok, at: new Date().toISOString(), ...(ok ? { revid: res.edit.newrevid } : { response: res.error ?? res.edit }) }) + "\n");
    if (!ok) { console.log("ОСТАНОВКА на стр.", e.n, JSON.stringify(res.error ?? res.edit)); process.exit(1); }
    console.log(`опубликовано: стр. ${e.n}, правка ${res.edit.newrevid}`);
    await sleep(1500);
  }
}
