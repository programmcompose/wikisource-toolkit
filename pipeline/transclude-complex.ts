// Сложные статьи (таблицы, заглушки рисунков) по решению оператора: обычный transclude их пропускает
// (статус review по findComplex). Здесь для перечисленных названий — та же сверка с сайтом и тот же манифест.
//   bun pipeline/transclude-complex.ts --vol 31 --titles "Картель"
// Пропускает только статьи, у которых причины review — лишь «таблица» и/или «иллюстрация».
import { Client, arg, readJsonl, sleep, volArg, volDir } from "./lib";
import { checkRendered, renderArticle, renderPagesTag, type Page } from "./parse";
import type { ManifestRow } from "./build";
import type { Article } from "./prepare";
import { selectArticles } from "./transclude";

const ALLOWED = new Set(["таблица", "иллюстрация"]);
const vol = volArg();
const dir = volDir(vol);
const titles = new Set((arg("titles") ?? "").split("|").map((s) => s.trim()).filter(Boolean));
if (!titles.size) throw new Error("Укажите --titles \"Название|Название\"");

const articles = await readJsonl<Article>(`${dir}/articles.jsonl`);
const pages: Page[] = await Bun.file(`${dir}/pages.json`).json();
for (const a of articles) {
  if (!titles.has(a.title)) continue;
  if (a.status !== "review" || !a.reasons.length || !a.reasons.every((r) => ALLOWED.has(r))) throw new Error(`«${a.title}»: статус ${a.status}, причины: ${a.reasons.join("; ") || "нет"}`);
  a.status = "candidate";
}
for (const a of articles) if (!titles.has(a.title) && a.status === "candidate") a.status = "exists"; // остальные уже созданы обычным путём
const { ready, held } = selectArticles(articles, pages);
for (const h of held) console.log(`задержано: ${h.title} — ${h.why}`);

const api = new Client();
const rows: ManifestRow[] = [];
for (const { article: a, plan, text } of ready) {
  const page = `БСЭ1/${a.title}`;
  const tag = renderPagesTag(plan);
  const res = await api.call({ action: "parse", title: page, text: tag, prop: "text", contentmodel: "wikitext", disablelimitreport: "1", disableeditsection: "1" });
  if (res.error) throw new Error(`Ошибка API на «${a.title}»: ${res.error.code}`);
  const problems = checkRendered(text, res.parse.text, plan);
  if (problems.length) { console.log(`сверка с сайтом: ${a.title} — ${problems.join("; ")}`); continue; }
  const file = `wiki-pages/${a.id}.wiki`;
  await Bun.write(`${dir}/${file}`, renderArticle({ title: a.title, body: tag, quality: 3, category: "Статьи без категорий" }));
  rows.push({ title: a.title, page, file, summary: `Статья БСЭ1, т. ${vol} (${a.year}): включены страницы индекса, вычитанные оператором (таблицы/заглушки рисунков сверены по скану), текст не менялся. Создано скриптом с помощью ИИ (Claude).` });
  await sleep(1500);
}
await Bun.write(`${dir}/manifest-pages.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
console.log(`Прошли сверку: ${rows.map((r) => r.title).join(", ") || "нет"}.`);
