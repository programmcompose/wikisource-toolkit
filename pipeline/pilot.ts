// Стенд сверки страниц индекса, размеченных ИИ. На Викитеке ничего не меняет: action=parse работает без сохранения.
//   bun pipeline/pilot.ts --dir pilot/60 --file "БСЭ-1 Том 60. Холангит - Цянь (1934).pdf"
// В папке: ocr/N.wiki — текст с сайта, model/N.wiki — разметка модели, scans/N.jpg — скан, notes.json — сомнительные места.
// Пишет index.html: скан, вид на сайте, викитекст и все слова, которые отличаются от OCR.
import { readdir } from "fs/promises";
import { resolve } from "path";
import { Client, arg, localTestMode, sleep } from "./lib";
import { BSE1 } from "./profile";
import { lintStyle } from "./style";

// Текст, который видит читатель: без разметки и служебных тегов. Шаблон {{перенос}} склеивает слово.
export function visibleText(wiki: string): string {
  let s = wiki
    .replace(/<noinclude>[\s\S]*?<\/noinclude>/g, " ")
    // В формулах читателю видны только символы: команды TeX и скобки групп убираются, «CH_2» становится «CH2».
    .replace(/<math[^>]*>([\s\S]*?)<\/math>/g, (_, m: string) => m.replace(/\\(?:begin|end)\{[a-z]*\}/g, " ").replace(/\\text\{([^}]*)\}/g, " $1 ").replace(/\\[a-zA-Z]+/g, " ").replace(/[{}_^&]/g, ""))
    .replace(/<section[^>]*>/g, " ")
    .replace(/-<br\s*\/?>/g, "")
    .replace(/<\/?(small|center|sup|sub)>/g, "")
    .replace(/&nbsp;|&#160;|&#32;|&thinsp;/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<");
  for (let i = 0; i < 4; i++) {
    s = s
      .replace(/\{\{нд\}\}/g, "-")
      .replace(/\{\{Ко\}\}/g, "Ко")
      .replace(/\{\{nop\}\}/g, " ")
      .replace(/\{\{перенос2\|[^|{}]*\|([^|{}]*)\}\}/g, "$1")
      .replace(/\{\{перенос\|([^|{}]*)\|([^|{}]*)\}\}/g, "$1$2")
      .replace(/\{\{frac\|([^|{}]*)\|([^|{}]*)\}\}/g, " $1/$2")
      .replace(/\{\{lsafe\|[^|{}]*\|([^{}]*)\}\}/g, "$1")
      .replace(/\{\{img\|([^|{}]*)(?:\|[^{}]*)?\}\}/g, "$1")
      .replace(/\{\{(?:lsafe|razr2?|right|БСЭ1\/Автор|=)\|([^{}]*)\}\}/g, "$1")
      .replace(/\{\{Dotted cell\|([^|{}]*)\|[^{}]*\}\}/g, "$1");
  }
  return s
    .replace(/^\{\|.*$|^\|\}$|^\|-.*$/gm, " ")
    .replace(/(?:rowspan|colspan)="\d+" \|/g, " ")
    .replace(/\|\||!!/g, " ")
    .replace(/^[|!]\s?/gm, "")
    .replace(/'{2,}/g, "");
}

export const words = (s: string) => s.toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}][\p{L}\p{N}.,/-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? [];

// Сравнение наборов слов: при перемешанных столбцах порядок слов в OCR не имеет смысла.
export function wordDiff(ocr: string, model: string): { added: string[]; removed: string[]; share: number } {
  const count = new Map<string, number>();
  const a = words(visibleText(ocr)), b = words(visibleText(model));
  for (const w of a) count.set(w, (count.get(w) ?? 0) + 1);
  const added: string[] = [];
  for (const w of b) {
    const n = count.get(w) ?? 0;
    if (n > 0) count.set(w, n - 1);
    else added.push(w);
  }
  const removed = [...count].flatMap(([w, n]) => Array<string>(n).fill(w));
  return { added, removed, share: b.length ? 1 - added.length / b.length : 0 };
}

export function sectionTags(wiki: string): { opened: string[]; closed: string[] } {
  const opened: string[] = [], closed: string[] = [];
  for (const m of wiki.matchAll(/<section (begin|end)="([^"]*)"\s*\/>/g)) {
    if (m[1] === "begin") opened.push(m[2]);
    else if (opened.at(-1) === m[2]) opened.pop();
    else closed.push(m[2]);
  }
  return { opened, closed };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

if (import.meta.main) {
  const dir = resolve(arg("dir") ?? ".");
  const file = arg("file");
  if (!file) throw new Error("Укажите --file с именем файла индекса");
  const api = new Client();
  const notes = await Bun.file(`${dir}/notes.json`).json();
  const list = (await readdir(`${dir}/model`)).map((f) => Number(f.replace(".wiki", ""))).sort((a, b) => a - b);
  const parts: string[] = [];
  for (const n of list) {
    const ocr = await Bun.file(`${dir}/ocr/${n}.wiki`).text();
    const model = await Bun.file(`${dir}/model/${n}.wiki`).text();
    const res = await api.call({ action: "parse", title: `${BSE1.pageNamespace}:${file}/${n}`, text: model, prop: "text|templates", contentmodel: "wikitext", disablelimitreport: "1", disableeditsection: "1" });
    if (res.error) throw new Error(`Ошибка API на стр. ${n}: ${res.error.code}`);
    const html: string = res.parse.text;
    const missing = (res.parse.templates ?? []).filter((t: any) => t.missing || t.exists === false).map((t: any) => t.title);
    const errors = (html.match(/class="(?:error|mw-parser-error|scribunto-error)[^"]*"/g) ?? []).length;
    const diff = wordDiff(ocr, model);
    const tags = sectionTags(model);
    console.log(`стр. ${n}: добавлено слов ${diff.added.length}, убрано ${diff.removed.length}, совпало ${(diff.share * 100).toFixed(1)}%, ошибок разметки ${errors}, нет шаблонов ${missing.length}, открыто [${tags.opened}], закрыто [${tags.closed}]`);
    const note = notes[n] ?? { why: "", notes: [] };
    parts.push(`<section id="p${n}">
<h2>Страница ${n}</h2>
<p class="why">${esc(note.why)} ${localTestMode ? "" : `<a href="https://ru.wikisource.org/wiki/${encodeURI(`${BSE1.pageNamespace}:${file}/${n}`)}">Страница на сайте</a>`}</p>
${(() => {
  // «⚠ Проверить:» — то, что оператор сверяет со сканом (облегчённая сверка с 11 ноября 2026); остальное справка.
  // Плюс места, которые нашла проверка оформления (pipeline/style.ts, правила в РАЗМЕТКА.md).
  const check = [...note.notes.filter((x: string) => x.startsWith("⚠")), ...lintStyle(model).map((w) => `⚠ оформление: ${w}`)], info = note.notes.filter((x: string) => !x.startsWith("⚠"));
  return `<h3>⚠ Проверить по скану (${check.length})</h3>
<ul class="check">${check.length ? check.map((x: string) => `<li>${esc(x.replace(/^⚠\s*(Проверить:\s*)?/, ""))}</li>`).join("") : "<li>сомнительных мест нет</li>"}</ul>
<details><summary>Справка: что исправлено по сравнению с OCR (${info.length})</summary>
<ul>${info.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul></details>`;
})()}
<div class="cols">
<figure><figcaption>Скан</figcaption><img src="data:image/jpeg;base64,${Buffer.from(await Bun.file(`${dir}/scans/${n}.jpg`).arrayBuffer()).toString("base64")}" alt="Скан страницы ${n}"></figure>
<div class="render"><div class="cap">Как выглядит на сайте (предпросмотр)</div><div class="mw-parser-output">${html}</div></div>
</div>
<details><summary>Отличия от OCR: добавлено ${diff.added.length}, убрано ${diff.removed.length}. Проверка автоматическая, по словам.</summary>
<h4>Слова, которых не было в OCR</h4><p class="words">${esc(diff.added.join(" · ")) || "нет"}</p>
<h4>Слова OCR, которых нет в разметке</h4><p class="words">${esc(diff.removed.join(" · ")) || "нет"}</p></details>
<details><summary>Викитекст модели</summary><pre>${esc(model)}</pre></details>
<details><summary>Исходный текст с сайта (OCR)</summary><pre>${esc(ocr)}</pre></details>
<p class="check">Секции: открыто и не закрыто на странице — ${esc(tags.opened.join(", ") || "нет")}; закрыто без начала на странице — ${esc(tags.closed.join(", ") || "нет")}. Ошибок разметки на сайте: ${errors}. Отсутствующих шаблонов: ${missing.length}.</p>
</section>`);
    await sleep(localTestMode ? 0 : 2500);
  }
  await Bun.write(`${dir}/index.html`, `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Проба страниц БСЭ1</title>
${localTestMode ? "" : '<link rel="stylesheet" href="https://ru.wikisource.org/w/load.php?lang=ru&amp;modules=ext.cite.styles%7Cext.proofreadpage.base%7Csite.styles&amp;only=styles&amp;skin=vector">'}
<style>
ul.check{background:#fff4d6;border-left:4px solid #e0a000;padding:.5em .5em .5em 2em;color:#111} ul.check li{margin:.3em 0;font-weight:600}
:root{color-scheme:light}
body{margin:0 auto;max-width:1500px;padding:16px;background:#fff;color:#202122;font:16px/1.5 system-ui,sans-serif}
nav a{margin-right:12px}
h2{margin-top:40px;border-bottom:1px solid #a2a9b1}
.why{color:#54595d}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}
figure{margin:0}
figure img{width:100%;height:auto;border:1px solid #c8ccd1}
figcaption,.cap{font-weight:600;margin-bottom:6px}
.render{font-family:Georgia,serif;overflow-x:auto;border:1px solid #c8ccd1;padding:12px}
.render table{font-size:12px}
.words{line-height:1.8;font-size:14px}
details{margin-top:12px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f8f9fa;padding:10px;font-size:13px}
.check{font-size:14px;color:#54595d}
@media (max-width:900px){.cols{grid-template-columns:minmax(0,1fr)}}
</style></head><body>
<h1>Проба страниц БСЭ1, ${esc(file.match(/Том (\d+)/)?.[0].toLowerCase() ?? file)}</h1>
<p>${localTestMode ? "Учебный отчёт на вымышленных страницах. Предпросмотр дал локальный имитатор API." : "Кандидаты на сверку. Уровень вычитки определяется проверкой оператором и правилами проекта."}</p>
<nav>${list.map((n) => `<a href="#p${n}">стр. ${n}</a>`).join("")}</nav>
${parts.join("\n")}
</body></html>
`);
  console.log(`Готово: ${dir}/index.html`);
}
