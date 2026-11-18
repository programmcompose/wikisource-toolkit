// Шаг 2. Выдаёт следующую порцию статей на сверку со сканом.
//   bun pipeline/todo.ts --vol 58 --count 20 [--scans]
// Для каждой статьи пишет распознанный текст в vols/NN/todo/. С --scans скачивает сканы страниц.
// Исправленный текст добавляется строкой в vols/NN/fixed.jsonl: {"title": "...", "body": "...", "category": "..."}.
// category необязательна. Шапку и категорию добавлять в body не нужно, их добавит build.ts.
import { mkdir } from "fs/promises";
import { Client, arg, flag, readJsonl, sleep, volArg, volDir, USER_AGENT } from "./lib";
import type { Article } from "./prepare";

const vol = volArg();
const dir = volDir(vol);
const count = Number(arg("count") ?? 20);
const articles = await readJsonl<Article>(`${dir}/articles.jsonl`);
if (!articles.length) throw new Error("Сначала запустите prepare.ts");
const fixed = new Set((await readJsonl<{ title: string }>(`${dir}/fixed.jsonl`)).map((f) => f.title));
const left = articles.filter((a) => a.status === "candidate" && !fixed.has(a.title));
const batch = left.slice(0, count);
console.log(`Кандидатов без сверки: ${left.length}. В порции: ${batch.length}.`);
await mkdir(`${dir}/todo`, { recursive: true });

const api = new Client();
async function scan(file: string, n: number): Promise<string> {
  const path = `${dir}/scans/${file.match(/-(\d+)\.pdf$/)?.[1] ?? "1"}-${n}.jpg`;
  if (await Bun.file(path).exists()) return path;
  const j = await api.call({ action: "query", prop: "imageinfo", iiprop: "url", iiurlwidth: "1300", iiurlparam: `page${n}-1300px`, titles: `Файл:${file}` });
  const url = j.query?.pages?.[0]?.imageinfo?.[0]?.thumburl;
  if (!url) throw new Error(`Нет скана: ${file}, стр. ${n}`);
  await sleep(3000);
  const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!r.ok) throw new Error(`Скан не скачан: HTTP ${r.status}`);
  await Bun.write(path, await r.arrayBuffer());
  await sleep(3000);
  return path;
}

for (const a of batch) {
  await Bun.write(`${dir}/todo/${a.id}.txt`, a.ocr);
  const where = a.pages.map((p) => p.n).join(", ");
  const scans: string[] = [];
  if (flag("scans")) for (const p of a.pages) scans.push(await scan(p.file, p.n));
  console.log(`${a.id} | ${a.title} | стлб. ${a.cols} | стр. ${where}${a.weak ? " | начало найдено без секции" : ""}${scans.length ? "\n     " + scans.join("\n     ") : ""}`);
}
