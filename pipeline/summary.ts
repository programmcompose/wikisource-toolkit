// Сводка по всем томам: читает vols/NN/articles.jsonl и pages.json, таблицы авторов и заглушки АП.
//   bun pipeline/summary.ts [--refresh]
// На Викитеке ничего не меняет. Пишет файлы в summary/. Ответы сайта кэшируются в summary/cache/.
import { mkdir } from "fs/promises";
import { resolve } from "path";
import { Client, flag, readJsonl, sleep, volDir } from "./lib";

export type AuthorRow = { who: string; as: string; year?: number; rehab?: number; vov: boolean; titles: string[] };
export type Term = "pd" | "check" | "protected" | "unknown";
export type Verdict = "pd" | "check" | "protected" | "unknown" | "partial" | "norow";

// «Возможно [[Иванов]]» и знак вопроса: личность автора в таблице предположительная.
const tentative = (a: AuthorRow) => /возможно|предположительно|\?/i.test(`${a.who} ${a.as}`);

// Конец текста похож на подпись, которую не поймала проверка в prepare.ts. Много ложных срабатываний: это список на просмотр.
export const tailLooksSigned = (ocr: string) => /(?:^|[\s.])(?:[А-ЯЁ]\.\s?){1,2}[А-ЯЁ][а-яё-]{2,}\.?\s*$/.test(ocr.trim());

// Статья-отсылка: одно короткое предложение со «см.». Их проще всего сверять.
export const isCrossReference = (ocr: string) => ocr.split(/\s+/).length <= 15 && /см\./.test(ocr);

// Строки таблицы «Авторы на X»: автор || упомянут как || статьи || статус АП.
export function parseAuthorTable(wikitext: string): { rows: AuthorRow[]; skipped: number } {
  const rows: AuthorRow[] = [];
  let skipped = 0;
  for (const row of wikitext.split(/\n\|-/).slice(1)) {
    const parts = row.replace(/^[^\n]*\n?\s*\|/, (m) => (m.includes("||") ? m : "|")).replace(/^\|/, "").split(/\s*\|\|\s*/);
    if (parts.length < 3) {
      if (row.includes("БСЭ1/")) skipped++;
      continue;
    }
    const tpl = row.match(/\{\{\s*БСЭ1\/АП-мини([^{}]*)\}\}/)?.[1] ?? "";
    const year = tpl.match(/(?:^|\|)\s*ГОД\s*=\s*(\d{4})/)?.[1];
    const rehab = tpl.match(/ГОДРЕАБИЛИТАЦИИ\s*=\s*(\d{4})/)?.[1];
    rows.push({
      who: parts[0].trim(),
      as: parts[1].trim(),
      year: year ? Number(year) : undefined,
      rehab: rehab ? Number(rehab) : undefined,
      vov: /ВОВ\s*=\s*[^\s|]/.test(tpl),
      titles: [...parts[2].matchAll(/\[\[БСЭ1\/([^\]|]+)/g)].map((m) => m[1].replace(/_/g, " ").trim()),
    });
  }
  return { rows, skipped };
}

// Формула та же, что в {{БСЭ1/АП-мини}}. «check» — шаблон считает срок истёкшим, но данные могут быть неполными:
// смерть в 1952–1955 (могли не отметить ВОВ, это ещё 4 года), смерть в 1936–1941 без года реабилитации
// и предположительная личность автора.
export function term(a: AuthorRow | undefined, currentYear: number): Term {
  if (!a?.year) return "unknown";
  const base = (a.rehab ?? a.year) + (a.vov ? 4 : 0);
  if (base + 70 >= currentYear) return "protected";
  if (!a.rehab && !a.vov && base + 70 >= currentYear - 4) return "check";
  if (!a.rehab && a.year >= 1936 && a.year <= 1941) return "check";
  return tentative(a) ? "check" : "pd";
}

// Статья открыта, только если у таблицы есть строка на каждого подписавшего и все они вне охраны.
export function verdict(authorCount: number, rows: AuthorRow[], currentYear: number): Verdict {
  const terms = rows.map((r) => term(r, currentYear));
  if (terms.includes("protected")) return "protected";
  if (!rows.length) return "norow";
  if (rows.length < authorCount) return "partial";
  if (terms.includes("unknown")) return "unknown";
  return terms.includes("check") ? "check" : "pd";
}

export const pageLevel = (content: string) => content.match(/<pagequality level="(\d)"/)?.[1] ?? "?";

const LETTERS = "АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ".split("");
const tsvCell = (x: unknown) => String(x ?? "").replace(/[\t\n\r]+/g, " ").trim();
const tsv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(tsvCell).join("\t")).join("\n") + "\n";
const num = (n: number) => n.toLocaleString("ru-RU");

async function cached<T>(path: string, refresh: boolean, load: () => Promise<T>): Promise<T> {
  if (!refresh && (await Bun.file(path).exists())) return Bun.file(path).json();
  const value = await load();
  await Bun.write(path, JSON.stringify(value));
  return value;
}

async function fetchAuthors(api: Client): Promise<{ rows: AuthorRow[]; skipped: number }> {
  const out: AuthorRow[] = [];
  let skipped = 0;
  for (const name of [...LETTERS.map((l) => `Авторы на ${l}`), "Авторы по инициалам"]) {
    const j = await api.call({ action: "query", titles: `Викитека:Проект:БСЭ1/${name}`, prop: "revisions", rvprop: "content", rvslots: "main" });
    const text = j.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
    if (typeof text !== "string") throw new Error(`Нет таблицы: ${name}`);
    const t = parseAuthorTable(text);
    out.push(...t.rows);
    skipped += t.skipped;
    await sleep(2000);
  }
  return { rows: out, skipped };
}

async function fetchStubs(api: Client): Promise<string[]> {
  const out: string[] = [];
  let cont: Record<string, string> = {};
  do {
    const j = await api.call({ action: "query", list: "embeddedin", eititle: "Шаблон:АП-произведение", einamespace: "0", eilimit: "500", ...cont });
    for (const p of j.query.embeddedin) if (p.title.startsWith("БСЭ1/")) out.push(p.title.slice(5));
    cont = j.continue ?? {};
    await sleep(2000);
  } while (Object.keys(cont).length);
  return out;
}

if (import.meta.main) {
  const OUT = resolve(import.meta.dir, "..", "summary");
  const YEAR = new Date().getFullYear();
  const refresh = flag("refresh");
  await mkdir(`${OUT}/cache`, { recursive: true });
  const api = new Client();
  const authors = await cached(`${OUT}/cache/authors.json`, refresh, () => fetchAuthors(api));
  const stubs = new Set(await cached(`${OUT}/cache/stubs.json`, refresh, () => fetchStubs(api)));
  const byTitle = new Map<string, AuthorRow[]>();
  for (const a of authors.rows) for (const t of new Set(a.titles)) (byTitle.get(t) ?? byTitle.set(t, []).get(t)!).push(a);

  const volRows: Record<string, any>[] = [];
  const ready: unknown[][] = [], readyWeak: unknown[][] = [], review: unknown[][] = [], open: unknown[][] = [], check: unknown[][] = [], audit: unknown[][] = [], signedInText: unknown[][] = [], leftovers: unknown[][] = [], tails: unknown[][] = [], xrefs: unknown[][] = [];
  const proofreaders = new Map<string, number>();
  const verdicts: Record<string, number> = {};
  const reasonCounts = new Map<string, number>();
  const blockedByAuthor = new Map<AuthorRow, number>();
  const missingVols: number[] = [];

  for (let vol = 1; vol <= 65; vol++) {
    const dir = volDir(vol);
    const arts = await readJsonl<any>(`${dir}/articles.jsonl`);
    if (!arts.length) { missingVols.push(vol); continue; }
    const pages: { file: string; n: number; content: string }[] = await Bun.file(`${dir}/pages.json`).json();
    const level = new Map(pages.map((p) => [`${p.file}/${p.n}`, pageLevel(p.content)]));
    const checker = new Map(pages.map((p) => [`${p.file}/${p.n}`, p.content.match(/<pagequality level="\d" user="([^"]*)"/)?.[1] ?? ""]));
    const levels: Record<string, number> = {};
    for (const l of level.values()) levels[l] = (levels[l] ?? 0) + 1;

    const v = { vol, year: arts[0].year, total: arts.length, exists: 0, stub: 0, signed: 0, signedInText: 0, unlinked: 0, review: 0, candidate: 0, weak: 0, xref: 0, ready: 0, words: 0, pages: pages.length, l1: levels["1"] ?? 0, l3: (levels["3"] ?? 0) + (levels["4"] ?? 0), l0: levels["0"] ?? 0 };
    for (const a of arts) {
      const allProofread = a.pages.length > 0 && a.pages.every((p: any) => ["3", "4"].includes(level.get(`${p.file}/${p.n}`) ?? ""));
      const pageRef = a.pages.length ? `${a.pages[0].file}/${a.pages[0].n}${a.pages.length > 1 ? `–${a.pages.at(-1).n}` : ""}` : "";
      const rows = byTitle.get(a.title) ?? [];
      if (a.status === "exists") {
        v.exists++;
        if (stubs.has(a.title)) v.stub++;
        else if (a.authors.length && rows.some((r) => term(r, YEAR) === "protected")) audit.push([vol, a.title, a.authors.join(", "), rows.filter((r) => term(r, YEAR) === "protected").map((r) => r.who || r.as).join("; ")]);
      } else if (a.authors.length) {
        v.signed++;
        const res = verdict(a.authors.length, rows, YEAR);
        verdicts[res] = (verdicts[res] ?? 0) + 1;
        for (const r of rows) if (term(r, YEAR) === "unknown") blockedByAuthor.set(r, (blockedByAuthor.get(r) ?? 0) + 1);
        const line = [vol, a.title, a.cols, a.authors.join(", "), rows.map((r) => `${r.who || r.as}: ${r.year ?? "?"}${r.rehab ? `, реаб. ${r.rehab}` : ""}${r.vov ? ", ВОВ" : ""}`).join("; "), pageRef];
        if (res === "pd") open.push(line);
        if (res === "check") check.push(line);
      } else if (a.status === "blocked") {
        if (!a.linked) v.unlinked++;
        else { v.signedInText++; signedInText.push([vol, a.title, a.cols, a.reasons[0], pageRef]); }
      } else if (a.status === "review") {
        v.review++;
        review.push([vol, a.title, a.cols, a.reasons.join("; "), pageRef]);
        for (const r of a.reasons) { const k = r.replace(/[:«(].*$/, "").trim(); reasonCounts.set(k, (reasonCounts.get(k) ?? 0) + 1); }
      } else {
        v.candidate++;
        v.words += String(a.ocr).split(/\s+/).length;
        if (a.weak) v.weak++;
        if (isCrossReference(a.ocr)) { v.xref++; xrefs.push([vol, a.title, a.cols, a.ocr, pageRef]); }
        if (tailLooksSigned(a.ocr)) tails.push([vol, a.title, a.cols, a.ocr.slice(-90), pageRef]);
        if (allProofread) {
          v.ready++;
          const users = [...new Set<string>(a.pages.map((p: any) => checker.get(`${p.file}/${p.n}`) ?? ""))];
          for (const u of users) proofreaders.set(u, (proofreaders.get(u) ?? 0) + 1);
          (a.weak ? readyWeak : ready).push([vol, a.title, a.cols, pageRef, users.join(", ")]);
        }
      }
    }
    volRows.push(v);
    const open_ = v.candidate + v.review;
    if (open_ > 0 && open_ < 20) for (const a of arts) if (a.status === "candidate" || a.status === "review") leftovers.push([vol, a.title, a.cols, a.status, a.reasons.join("; ")]);
  }

  const sum = (k: string) => volRows.reduce((s, r) => s + r[k], 0);
  const noYear = authors.rows.filter((a) => !a.year);
  const priority = noYear.map((a) => [blockedByAuthor.get(a) ?? 0, a.as, a.who, a.titles.length] as const).filter((r) => r[0] > 0).sort((x, y) => y[0] - x[0]);
  const top = (n: number) => priority.slice(0, n).reduce((s, r) => s + r[0], 0);

  await Bun.write(`${OUT}/тома.tsv`, tsv(Object.keys(volRows[0]), volRows.map((r) => Object.values(r))));
  await Bun.write(`${OUT}/1-готовы-к-включению.tsv`, tsv(["том", "статья", "столбцы", "страницы", "уровень поставил"], ready));
  await Bun.write(`${OUT}/1б-нужна-секция.tsv`, tsv(["том", "статья", "столбцы", "страницы", "уровень поставил"], readyWeak));
  await Bun.write(`${OUT}/2-ручной-разбор.tsv`, tsv(["том", "статья", "столбцы", "причина", "страницы"], review));
  await Bun.write(`${OUT}/3-остатки-почти-готовых-томов.tsv`, tsv(["том", "статья", "столбцы", "состояние", "причина"], leftovers));
  await Bun.write(`${OUT}/4-авторы-приоритет.tsv`, tsv(["закрыто статей", "упомянут как", "автор", "всего статей"], priority));
  await Bun.write(`${OUT}/5-срок-истёк-по-таблице.tsv`, tsv(["том", "статья", "столбцы", "подпись", "данные таблицы", "страницы"], open));
  await Bun.write(`${OUT}/6-срок-нужна-проверка.tsv`, tsv(["том", "статья", "столбцы", "подпись", "данные таблицы", "страницы"], check));
  await Bun.write(`${OUT}/7-подпись-только-в-тексте.tsv`, tsv(["том", "статья", "столбцы", "подпись", "страницы"], signedInText));
  // Размер страницы отличает полный текст от короткой пометки.
  const sizes = new Map<string, number>();
  for (let i = 0; i < audit.length; i += 50) {
    const j = await api.call({ action: "query", titles: audit.slice(i, i + 50).map((r) => `БСЭ1/${r[1]}`).join("|"), prop: "info" });
    for (const p of j.query.pages) sizes.set(p.title.slice(5), p.length ?? 0);
    await sleep(2000);
  }
  await Bun.write(`${OUT}/8-проверка-ап-на-сайте.tsv`, tsv(["том", "статья", "подпись", "кто ещё под охраной по таблице", "байт"], audit.map((r) => [...r, sizes.get(String(r[1])) ?? ""])));
  await Bun.write(`${OUT}/9-возможная-подпись-в-конце.tsv`, tsv(["том", "статья", "столбцы", "конец текста", "страницы"], tails));
  await Bun.write(`${OUT}/10-статьи-отсылки.tsv`, tsv(["том", "статья", "столбцы", "текст", "страницы"], xrefs));

  const ranking = [...volRows].filter((r) => r.candidate > 0).sort((a, b) => b.ready - a.ready || a.words / a.candidate - b.words / b.candidate);
  const report = `# БСЭ1: рабочая сводка

Собрано ${new Date().toISOString().slice(0, 10)} скриптом \`pipeline/summary.ts\`. Статусы посчитаны скриптами и не заменяют проверку человеком.
${missingVols.length ? `\n**Нет данных по томам:** ${missingVols.join(", ")}.\n` : ""}
## Итог

| Состояние | Статей |
|---|---|
| Всего в словниках | ${num(sum("total"))} |
| На сайте | ${num(sum("exists"))} |
| из них заглушка АП | ${num(sum("stub"))} |
| Кандидаты: подписи не найдено, можно сверять со сканом | ${num(sum("candidate"))} |
| из них все страницы уже на уровне 3–4 | ${num(sum("ready"))} |
| из них короткие отсылки со «см.» | ${num(sum("xref"))} |
| из них начало найдено без секции, по слову прописными | ${num(sum("weak"))} |
| Ручной разбор | ${num(sum("review"))} |
| Закрыто: автор в словнике | ${num(sum("signed"))} |
| Закрыто: подпись найдена только в тексте | ${num(sum("signedInText"))} |
| Закрыто: в словнике нет ссылки | ${num(sum("unlinked"))} |

«На сайте» включает перенаправления. В кандидатах ${num(sum("words"))} слов распознанного текста.

Статус «кандидат» не гарантирует отсутствие подписи и правильные границы статьи: текст всё равно сверяется со сканом.

Страниц индекса: ${num(sum("pages"))}. На уровне 1: ${num(sum("l1"))}, на уровнях 3–4: ${num(sum("l3"))}, без текста: ${num(sum("l0"))}. В томе 63 учтён индекс 1933 года, указанный в словнике, в томе 64 основной индекс без «64-1».

Кто поставил уровень страниц у готовых статей: ${[...proofreaders].sort((a, b) => b[1] - a[1]).map(([u, n]) => `${u || "не указан"} (${n})`).join(", ")}.

## Закрытые подписанные статьи

| Вывод по таблицам авторов | Статей |
|---|---|
| Срок истёк по таблице, файл 5 | ${num(verdicts.pd ?? 0)} |
| Истёк по шаблону, но данные могут быть неполны, файл 6 | ${num(verdicts.check ?? 0)} |
| Срок ещё идёт | ${num(verdicts.protected ?? 0)} |
| Автор не определён | ${num(verdicts.unknown ?? 0)} |
| В таблице есть не все соавторы | ${num(verdicts.partial ?? 0)} |
| Статьи нет в таблицах | ${num(verdicts.norow ?? 0)} |

Строк в таблицах авторов: ${num(authors.rows.length)}, без года смерти: ${num(noYear.length)}, не разобрано: ${num(authors.skipped)}. Строк без года, закрывающих хотя бы одну статью: ${num(priority.length)}. Первые 100 таких строк закрывают ${num(top(100))} статей (статья с соавторами считается у каждого).

## Причины ручного разбора

${[...reasonCounts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${num(n)}`).join("\n")}

## Файлы

- \`тома.tsv\`: все цифры по томам.
- \`1-готовы-к-включению.tsv\`: кандидаты, все страницы которых уже вычитаны участниками, и секция найдена.
- \`1б-нужна-секция.tsv\`: то же, но секцию на странице ещё нужно поставить.
- \`2-ручной-разбор.tsv\`: статьи с причинами разбора.
- \`3-остатки-почти-готовых-томов.tsv\`: тома, где осталось меньше 20 статей.
- \`4-авторы-приоритет.tsv\`: неопределённые авторы по числу закрытых статей.
- \`5-срок-истёк-по-таблице.tsv\`, \`6-срок-нужна-проверка.tsv\`: подписанные статьи, которые можно проверить на публикацию.
- \`7-подпись-только-в-тексте.tsv\`: подпись найдена в тексте, в словнике автора нет. Словник стоит дополнить.
- \`8-проверка-ап-на-сайте.tsv\`: статьи с текстом без заглушки, хотя по таблице срок ещё идёт. Возможны ложные срабатывания, проверять вручную.
- \`9-возможная-подпись-в-конце.tsv\`: кандидаты, у которых конец текста похож на подпись. Много ложных срабатываний.
- \`10-статьи-отсылки.tsv\`: короткие кандидаты со «см.», их проще всего сверять.

## Тома с кандидатами

Сначала тома, где больше статей можно включить без вычитки, затем с более короткими статьями.

| Том | Год | Всего | На сайте | Кандидаты | Готовы | Разбор | Подпись | Стр. | Ур. 1 | Ур. 3–4 | Слов на кандидата |
|---|---|---|---|---|---|---|---|---|---|---|---|
${ranking.map((r) => `| ${r.vol} | ${r.year} | ${r.total} | ${r.exists} | ${r.candidate} | ${r.ready} | ${r.review} | ${r.signed + r.signedInText} | ${r.pages} | ${r.l1} | ${r.l3} | ${Math.round(r.words / r.candidate)} |`).join("\n")}
`;
  await Bun.write(`${OUT}/README.md`, report);
  console.log(report.slice(0, report.indexOf("## Файлы")));
}
