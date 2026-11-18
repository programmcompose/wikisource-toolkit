// Шаг 1. Готовит том: читает словник и страницы индекса, режет текст на статьи и отбирает кандидатов.
//   bun pipeline/prepare.ts --vol 58 [--index "(1933)"] [--refresh]
// Только читает Викитеку. Пишет vols/NN/articles.jsonl и vols/NN/report.md.
import { mkdir } from "fs/promises";
import { Client, arg, flag, selectIndexes, sleep, volArg, volDir, type IndexFile } from "./lib";
import { align, buildStream, findComplex, findSignature, parseSlovnik, words, type Entry, type Page } from "./parse";
import { BSE1 } from "./profile";

export type Status = "exists" | "blocked" | "review" | "candidate";
export type Article = Entry & {
  id: string;
  status: Status;
  reasons: string[];
  pages: { file: string; n: number }[];
  ocr: string;
  year: number;
  weak: boolean; // начало статьи найдено по слову прописными, а не по секции
};

const REQUEST_PAUSE_MS = 3000;

async function listIndexes(api: Client): Promise<string[]> {
  const out: string[] = [];
  let cont: Record<string, string> = {};
  do {
    const j = await api.call({ action: "query", list: "categorymembers", cmtitle: BSE1.indexCategory, cmlimit: "500", ...cont });
    out.push(...j.query.categorymembers.map((m: any) => m.title.replace(/^Индекс:/, "")));
    cont = j.continue ?? {};
  } while (Object.keys(cont).length);
  return out;
}

async function fetchPages(api: Client, indexes: IndexFile[], cachePath: string, refresh: boolean): Promise<Page[]> {
  if (!refresh && (await Bun.file(cachePath).exists())) return Bun.file(cachePath).json();
  const pages: Page[] = [];
  for (const { file } of indexes) {
    const before = pages.length;
    let cont: Record<string, string> = {};
    do {
      const j = await api.call({ action: "query", generator: "allpages", gapnamespace: "104", gapprefix: file + "/", gaplimit: "50", prop: "revisions", rvprop: "content", rvslots: "main", ...cont });
      if (j.error) throw new Error(`Ошибка API: ${j.error.code}`);
      for (const p of j.query?.pages ?? []) {
        const n = Number(p.title.slice(p.title.lastIndexOf("/") + 1));
        pages.push({ file, n, content: p.revisions?.[0]?.slots?.main?.content ?? "" });
      }
      cont = j.continue ?? {};
      await sleep(REQUEST_PAUSE_MS);
    } while (Object.keys(cont).length);
    console.log(`  ${file}: ${pages.length - before} стр.`);
  }
  const order = new Map(indexes.map((x, i) => [x.file, i]));
  pages.sort((a, b) => order.get(a.file)! - order.get(b.file)! || a.n - b.n);
  await Bun.write(cachePath, JSON.stringify(pages));
  return pages;
}

const WORDS_PER_COLUMN_MAX = 1100;
const COLUMN_DRIFT_MAX = 12;

export function classify(vol: number, year: number, entries: Entry[], redOrBlue: Map<string, boolean>, pages: Page[]): Article[] {
  const stream = buildStream(pages);
  const match = align(entries, stream.sections);
  const matched = match.map((s, i) => [s, i] as const).filter(([s]) => s >= 0);
  const nextOffset = new Map<number, number>();
  matched.forEach(([s, i], k) => {
    nextOffset.set(i, k + 1 < matched.length ? stream.sections[matched[k + 1][0]].offset : stream.text.length);
  });
  const pageIndexAt = (offset: number) => {
    let lo = 0, hi = stream.pageAt.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (stream.pageAt[mid].offset <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const seen = new Set<string>();
  const articles: Article[] = entries.map((e, i) => {
    const reasons: string[] = [];
    let ocr = "";
    let pagesOf: Article["pages"] = [];
    if (match[i] >= 0) {
      const begin = stream.sections[match[i]].offset, end = nextOffset.get(i)!;
      ocr = stream.text.slice(begin, end).trim();
      // Хвостовые пробелы не считаются: если следующая статья начинается с самого верха страницы,
      // эта страница текущей статье не принадлежит (БСЭ1/Революционный комитет, т. 48, стр. 199—200).
      let last = end;
      while (last > begin && /\s/.test(stream.text[last - 1])) last--;
      const a = pageIndexAt(begin), b = pageIndexAt(Math.max(begin, last - 1));
      pagesOf = stream.pageAt.slice(a, b + 1).map(({ file, n }) => ({ file, n }));
      if (stream.pageAt.slice(a, b + 1).some((p) => p.quality === "0")) reasons.push("на странице нет текста (уровень 0)");
    } else {
      reasons.push("секция не найдена");
    }
    if (seen.has(e.title)) reasons.push("название повторяется в словнике");
    seen.add(e.title);
    if (e.colStart === undefined) reasons.push("нет столбцов в словнике");
    const weak = match[i] >= 0 && !!stream.sections[match[i]].weak;
    return { ...e, id: String(e.seq).padStart(4, "0"), status: "candidate" as Status, reasons, pages: pagesOf, ocr, year, weak };
  });

  // Статья без своей секции «проглочена» предыдущей: той нельзя верить, пока человек не посмотрит.
  articles.forEach((a, i) => {
    if (match[i] >= 0) return;
    for (let k = i - 1; k >= 0; k--) {
      if (match[k] >= 0) { articles[k].reasons.push(`может содержать текст статьи «${a.title}»`); break; }
    }
  });

  // Столбцы тома растут примерно вдвое быстрее страниц скана; большой сдвиг означает неверное сопоставление.
  const drift = articles.map((a, i) => {
    if (match[i] < 0 || a.colStart === undefined) return null;
    return a.colStart - 2 * pageIndexAt(stream.sections[match[i]].offset);
  });
  const known = drift.map((d, i) => [d, i] as const).filter(([d]) => d !== null) as [number, number][];
  known.forEach(([d, i], k) => {
    const window = known.slice(Math.max(0, k - 15), k + 16).map(([x]) => x).sort((a, b) => a - b);
    const median = window[window.length >> 1];
    if (Math.abs(d - median) > COLUMN_DRIFT_MAX) articles[i].reasons.push(`столбцы не совпадают со страницей (сдвиг ${d - median})`);
  });

  for (const a of articles) {
    const span = a.colEnd !== undefined && a.colStart !== undefined ? a.colEnd - a.colStart + 1 : 1;
    const count = words(a.ocr).length;
    if (a.ocr && count > (span + 1) * WORDS_PER_COLUMN_MAX) a.reasons.push(`слишком длинная: ${count} слов на ${span} стлб.`);
    if (a.ocr && count < 2) a.reasons.push("слишком короткая");
    a.reasons.push(...findComplex(a.ocr));

    const exists = redOrBlue.get(`${BSE1.articlePrefix}${a.title}`);
    if (exists === undefined && a.linked) a.reasons.push("ссылки нет в ответе API");
    const sign = findSignature(a.ocr);
    // Сначала то, что нельзя публиковать ни при каких проверках текста.
    if (exists === true) a.status = "exists";
    else if (!a.linked) { a.status = "blocked"; a.reasons.unshift("в словнике нет ссылки"); }
    else if (a.authors.length) { a.status = "blocked"; a.reasons.unshift(`автор в словнике: ${a.authors.join(", ")}`); }
    else if (sign?.sure) { a.status = "blocked"; a.reasons.unshift(`подпись в тексте: ${sign.sample}`); }
    else {
      if (sign) a.reasons.unshift(`похоже на подпись: ${sign.sample}`);
      a.status = a.reasons.length ? "review" : "candidate";
    }
  }
  return articles;
}

export function reportText(vol: number, articles: Article[], unparsed: string[], indexes: string[]): string {
  const by = (s: Status) => articles.filter((a) => a.status === s);
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const table = (list: Article[]) => list.map((a) => `| ${a.id} | ${esc(a.title)} | ${a.cols} | ${esc(a.reasons.join("; "))} |`).join("\n");
  const causes = new Map<string, number>();
  for (const a of by("review")) for (const r of a.reasons) {
    const k = r.replace(/[:«(].*$/, "").trim();
    causes.set(k, (causes.get(k) ?? 0) + 1);
  }
  return `# Том ${vol}: подготовка

Индексы: ${indexes.join("; ")}

| Состояние | Статей |
|---|---|
| Уже на сайте | ${by("exists").length} |
| Закрыто: авторские права | ${by("blocked").length} |
| На ручной разбор | ${by("review").length} |
| Кандидаты | ${by("candidate").length} |
| Всего | ${articles.length} |
| Строки словника, которые не разобраны | ${unparsed.length} |

## Причины разбора
${[...causes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

## На ручной разбор
| № | Статья | Стлб. | Причина |
|---|---|---|---|
${table(by("review"))}

## Закрыто: авторские права
| № | Статья | Стлб. | Причина |
|---|---|---|---|
${table(by("blocked"))}

## Не разобранные строки словника
${unparsed.map((u) => "- `" + u.slice(0, 200).replace(/`/g, "'") + "`").join("\n")}
`;
}

if (import.meta.main) {
  const vol = volArg();
  const dir = volDir(vol);
  await mkdir(dir, { recursive: true });
  const api = new Client();

  const indexes = selectIndexes(await listIndexes(api), vol, arg("index"));
  console.log(`Том ${vol}, индексы: ${indexes.length}`);
  const page = `${BSE1.slovnikRoot}/${String(vol).padStart(2, "0")}`;
  const parsed = await api.call({ action: "parse", page, prop: "links|wikitext" });
  if (parsed.error) throw new Error(`Словник: ${parsed.error.code}`);
  const status = new Map<string, boolean>(parsed.parse.links.map((l: any) => [l.title, !!l.exists]));
  const { entries, unparsed } = parseSlovnik(parsed.parse.wikitext);
  await sleep(REQUEST_PAUSE_MS);

  // В части словников ссылка записана с пробелом («БСЭ1/ Нейва») и ведёт не на настоящую страницу.
  // Такие статьи проверяем напрямую, иначе можно создать дубликат.
  const unchecked = entries.filter((e) => e.linked && !status.has(`БСЭ1/${e.title}`)).map((e) => `БСЭ1/${e.title}`);
  for (let i = 0; i < unchecked.length; i += 50) {
    const j = await api.call({ action: "query", titles: unchecked.slice(i, i + 50).join("|") });
    if (j.error) throw new Error(`Проверка страниц: ${j.error.code}`);
    const normalized = new Map<string, string>((j.query.normalized ?? []).map((n: any) => [n.to, n.from]));
    for (const p of j.query.pages) status.set(normalized.get(p.title) ?? p.title, !p.missing);
    await sleep(REQUEST_PAUSE_MS);
  }

  const pages = await fetchPages(api, indexes, `${dir}/pages.json`, flag("refresh"));
  const articles = classify(vol, indexes[0].year, entries, status, pages);

  await Bun.write(`${dir}/articles.jsonl`, articles.map((a) => JSON.stringify(a)).join("\n") + "\n");
  await Bun.write(`${dir}/report.md`, reportText(vol, articles, unparsed, indexes.map((i) => i.file)));
  const count = (s: Status) => articles.filter((a) => a.status === s).length;
  console.log(`Статей: ${articles.length}. На сайте ${count("exists")}, закрыто ${count("blocked")}, разбор ${count("review")}, кандидаты ${count("candidate")}. Не разобрано строк: ${unparsed.length}.`);
}
