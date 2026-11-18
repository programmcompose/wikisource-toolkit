// Шаг 3. Собирает страницы из сверенных текстов и применяет все проверки. Ничего не публикует.
//   bun pipeline/build.ts --vol 58 --quality 2 [--reviewed]
// --quality обязателен: значение для сверки ИИ сообщество ещё не определило.
// --reviewed ставьте, только если вы лично проверили эту партию: без него нельзя указать КАЧЕСТВО 3 или 4.
// Статьи со статусом «разбор» попадут в заливку, только если их название есть в vols/NN/approved.txt.
// Закрытые по авторским правам статьи файл approved.txt не открывает.
import { mkdir, rm } from "fs/promises";
import { arg, flag, readJsonl, volArg, volDir } from "./lib";
import { BSE1 } from "./profile";
import { changedShare, findSignature, renderArticle } from "./parse";
import type { Article } from "./prepare";

const CHANGED_MAX = 0.2;
export type ManifestRow = { title: string; page: string; file: string; summary: string };

const vol = volArg();
const dir = volDir(vol);
const quality = Number(arg("quality"));
const reviewed = flag("reviewed");
if (!Number.isInteger(quality) || quality < 0 || quality > 4) throw new Error("Укажите --quality 0–4");
if (quality >= 3 && !reviewed) throw new Error("КАЧЕСТВО 3 и 4 только при личной сверке оператора: добавьте --reviewed, если партия проверена вами");

const articles = await readJsonl<Article>(`${dir}/articles.jsonl`);
if (!articles.length) throw new Error("Сначала запустите prepare.ts");
const fixed = new Map((await readJsonl<{ title: string; body: string; category?: string }>(`${dir}/fixed.jsonl`)).map((f) => [f.title, f]));
const approvedFile = Bun.file(`${dir}/approved.txt`);
const approved = new Set((await approvedFile.exists() ? await approvedFile.text() : "").split("\n").map((s) => s.trim()).filter(Boolean));

const summary = (year: number) =>
  `Статья БСЭ1, т. ${vol} (${year}), по скану. Текст подготовлен с помощью ИИ (Claude)${reviewed ? ", партия проверена участником" : ""}.`;

await rm(`${dir}/wiki`, { recursive: true, force: true });
await mkdir(`${dir}/wiki`, { recursive: true });

const ready: ManifestRow[] = [];
const held: { title: string; why: string }[] = [];
let waiting = 0, unknown = 0;
const byTitle = new Set(articles.map((a) => a.title));
for (const t of fixed.keys()) if (!byTitle.has(t)) { unknown++; held.push({ title: t, why: "нет в словнике" }); }

for (const a of articles) {
  if (a.status === "exists") continue;
  const f = fixed.get(a.title);
  if (a.status === "blocked") {
    if (f) held.push({ title: a.title, why: `закрыто: ${a.reasons[0]}` });
    continue;
  }
  if (!f) { waiting++; continue; }
  const problems: string[] = [];
  if (a.status === "review") problems.push(...a.reasons);
  const body = f.body.trim();
  // Эти признаки есть только в необработанном тексте страницы индекса.
  if (!body) problems.push("пустой текст");
  if (/<section|<noinclude|<pagequality/.test(body)) problems.push("в тексте остались служебные теги");
  if (/\{\{\s*БСЭ1(\||\s*\n)|\[\[Категория:/.test(body)) problems.push("шапку и категории добавляет build.ts");
  const sign = findSignature(body);
  if (sign?.sure) {
    held.push({ title: a.title, why: `закрыто: подпись в тексте: ${sign.sample}` });
    continue;
  }
  if (sign) problems.push(`похоже на подпись: ${sign.sample}`);
  const share = changedShare(body, a.ocr);
  if (share > CHANGED_MAX) problems.push(`расхождение с распознанным текстом ${(share * 100).toFixed(0)}%`);
  if (problems.length && !approved.has(a.title)) {
    held.push({ title: a.title, why: problems.join("; ") });
    continue;
  }
  const file = `wiki/${a.id}.wiki`;
  await Bun.write(`${dir}/${file}`, renderArticle({ title: a.title, body, quality, category: f.category ?? "Статьи без категорий" }));
  ready.push({ title: a.title, page: `${BSE1.articlePrefix}${a.title}`, file, summary: summary(a.year) });
}

await Bun.write(`${dir}/manifest.jsonl`, ready.map((r) => JSON.stringify(r)).join("\n") + (ready.length ? "\n" : ""));
await Bun.write(`${dir}/held.md`, `# Том ${vol}: не вошло в заливку\n\n| Статья | Причина |\n|---|---|\n${held.map((h) => `| ${h.title.replace(/\|/g, "\\|")} | ${h.why.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`).join("\n")}\n`);
console.log(`К заливке: ${ready.length}. Задержано: ${held.length} (см. held.md). Ждут сверки: ${waiting}.${unknown ? ` Нет в словнике: ${unknown}.` : ""}`);
