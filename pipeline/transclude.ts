// Статьи без правки текста: тег <pages> включает страницы индекса, которые уже вычитали участники.
//   bun pipeline/prepare.ts --vol 41 --refresh    — сначала свежие страницы
//   bun pipeline/transclude.ts --vol 41           — сверка с сайтом и сборка заливки
//   bun pipeline/transclude.ts --vol 41 --offline — только проверка разметки, манифест не создаётся
//   bun pipeline/upload.ts --vol 41 --manifest pages
// На Викитеке ничего не меняет: action=parse показывает результат без сохранения. В манифест попадают
// только статьи, прошедшие эту сверку. Страницы индекса скрипт не правит.
import { mkdir, rm } from "fs/promises";
import { Client, flag, readJsonl, sleep, volArg, volDir, localTestMode } from "./lib";
import { BSE1 } from "./profile";
import { align, buildStream, changedShare, checkRendered, planTransclusion, renderArticle, renderPagesTag, type Page, type PlanResult, type TranscludePlan } from "./parse";
import type { ManifestRow } from "./build";
import type { Article } from "./prepare";
import { pageLevel, tailLooksSigned } from "./summary";

// КАЧЕСТВО по уровню страниц индекса, как предложил Egor (4 ноября 2026). Выше 3 не указываем: уровень 4 ставит другой участник.
const QUALITY = 3;
const MAX_OFFLINE_DIFF = 0.02;
const PARSE_PAUSE_MS = 1500;

type HeldCode = Extract<PlanResult, { problem: string }>["code"] | "section_not_found" | "stale_snapshot"
  | "weak_section" | "duplicate_title" | "heading_mismatch" | "possible_signature" | "section_text_mismatch" | "render_mismatch";
type Held = { title: string; id: string; code: HeldCode; why: string };
type Ready = { article: Article; plan: TranscludePlan; text: string };

// Заголовок в тексте вычитан участником, а название взято из словника, где бывают опечатки OCR («Хорга» вместо «Хорта»).
// Возвращает заголовок, если слова до запятой или скобки не совпали («Налоги с оборота» и НАЛОГ С ОБОРОТА).
// Уточнение после запятой («Хорда, в биологии») не сравнивается. Слово с точкой считается сокращением и совпадает с началом полного.
export function headMismatch(title: string, ocr: string): string | null {
  const words = (s: string) => s.split(/[,(]/)[0].toLowerCase().replace(/ё/g, "е").split(/\s+/)
    .map((w) => w.replace(/[^\p{L}.-]/gu, "")).filter((w) => w.replace(/[.-]/g, ""));
  const same = (a: string, b: string) => {
    if (a.replace(/\.$/, "") === b.replace(/\.$/, "")) return true;
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    return short.endsWith(".") && long.startsWith(short.slice(0, -1));
  };
  const bold = ocr.match(/'''([^']+)'''/)?.[1];
  if (!bold) return null;
  const a = words(title), b = words(bold);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (!same(a[i], b[i])) return bold.trim();
  return null;
}

// headsOk: названия из vols/NN/heads-ok.txt, у которых расхождение с заголовком сверено по скану и оказалось
// опечаткой самой книги («ХОРОДФОНЫ» в т. 60 при колонтитуле «ХОРДОФОНЫ»): текст верен, название из словника тоже.
export function selectArticles(articles: Article[], pages: Page[], headsOk: Set<string> = new Set()): { ready: Ready[]; held: Held[] } {
  const stream = buildStream(pages);
  const match = align(articles, stream.sections);
  const matched = match.flatMap((s, i) => (s >= 0 ? [{ s, i }] : []));
  const next = new Map(matched.map(({ i }, k) => [i, k + 1 < matched.length ? stream.sections[matched[k + 1].s].offset : stream.text.length]));
  const byKey = new Map(pages.map((p) => [`${p.file}/${p.n}`, p]));
  const repeats = new Map<string, number>();
  for (const a of articles) repeats.set(a.title, (repeats.get(a.title) ?? 0) + 1);

  const ready: Ready[] = [], held: Held[] = [];
  articles.forEach((a, i) => {
    if (a.status !== "candidate") return;
    const own = a.pages.map((p) => byKey.get(`${p.file}/${p.n}`));
    if (!own.length || own.some((p) => !p || !["3", "4"].includes(pageLevel(p.content)))) return;
    const hold = (code: HeldCode, why: string) => held.push({ title: a.title, id: a.id, code, why });
    if (match[i] < 0) return hold("section_not_found", "секция не найдена");
    const section = stream.sections[match[i]], end = next.get(i)!;
    if (stream.text.slice(section.offset, end).trim() !== a.ocr) return hold("stale_snapshot", "articles.jsonl устарел, запустите prepare.ts");
    if (a.weak) return hold("weak_section", "на странице нет секции, её нужно поставить");
    if (repeats.get(a.title)! > 1) return hold("duplicate_title", "название повторяется в словнике");
    const printed = headMismatch(a.title, a.ocr);
    if (printed && !headsOk.has(a.title)) return hold("heading_mismatch", `название в словнике расходится с заголовком в тексте: ${printed}`);
    if (tailLooksSigned(a.ocr)) return hold("possible_signature", `конец текста похож на подпись: ${a.ocr.slice(-40)}`);
    const inner = stream.sections.filter((s) => !s.weak && s.offset > section.offset && s.offset < end).length;
    const res = planTransclusion(section.name, own as Page[], inner);
    if ("problem" in res) return hold(res.code, res.problem);
    // {{nop}} в начале следующей страницы попадает в хвост текста статьи; у отсылок в одну строку это заметная доля слов.
    if (changedShare(res.text, a.ocr.replace(/\s*\{\{nop\}\}\s*$/i, "")) > MAX_OFFLINE_DIFF) return hold("section_text_mismatch", "секция шире или уже текста статьи");
    ready.push({ article: a, plan: res.plan, text: res.text });
  });
  return { ready, held };
}

if (import.meta.main) {
  const vol = volArg();
  const dir = volDir(vol);
  const offline = flag("offline");
  const articles = await readJsonl<Article>(`${dir}/articles.jsonl`);
  if (!articles.length) throw new Error("Сначала запустите prepare.ts");
  const pages: Page[] = await Bun.file(`${dir}/pages.json`).json();
  const headsFile = Bun.file(`${dir}/heads-ok.txt`);
  const headsOk = new Set((await headsFile.exists() ? await headsFile.text() : "").split("\n").map((s) => s.trim()).filter(Boolean));
  const { ready, held } = selectArticles(articles, pages, headsOk);

  await rm(`${dir}/wiki-pages`, { recursive: true, force: true });
  await rm(`${dir}/manifest-pages.jsonl`, { force: true });
  const rows: ManifestRow[] = [];
  if (offline) {
    console.log(`Разметка подходит: ${ready.length}. Сверка с сайтом не выполнялась, манифест не создан.`);
  } else {
    await mkdir(`${dir}/wiki-pages`, { recursive: true });
    const api = new Client();
    for (const { article: a, plan, text } of ready) {
      const page = `${BSE1.articlePrefix}${a.title}`;
      const tag = renderPagesTag(plan);
      const res = await api.call({ action: "parse", title: page, text: tag, prop: "text", contentmodel: "wikitext", disablelimitreport: "1", disableeditsection: "1" });
      if (res.error) throw new Error(`Ошибка API на «${a.title}»: ${res.error.code}`);
      const problems = checkRendered(text, res.parse.text, plan);
      if (problems.length) held.push({ title: a.title, id: a.id, code: "render_mismatch", why: `сверка с сайтом: ${problems.join("; ")}` });
      else {
        const file = `wiki-pages/${a.id}.wiki`;
        await Bun.write(`${dir}/${file}`, renderArticle({ title: a.title, body: tag, quality: QUALITY, category: "Статьи без категорий" }));
        rows.push({ title: a.title, page, file, summary: `Статья БСЭ1, т. ${vol} (${a.year}): включены страницы индекса, вычитанные участниками, текст не менялся. Создано скриптом с помощью ИИ (Claude).` });
      }
      await sleep(localTestMode ? 0 : PARSE_PAUSE_MS);
    }
    await Bun.write(`${dir}/manifest-pages.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    console.log(`Прошли сверку: ${rows.length}.`);
  }
  const heldById = new Map(held.map((h) => [h.id, h]));
  const planById = new Map(ready.map(({ article, plan }) => [article.id, plan]));
  const checks = articles.map((a) => {
    const base = { id: a.id, title: a.title };
    const issue = heldById.get(a.id);
    if (issue) return { ...base, status: "held", code: issue.code, message: issue.why };
    const plan = planById.get(a.id);
    if (plan) return { ...base, status: offline ? "local_pass" : "ready", plan };
    return { ...base, status: "skipped", code: a.status === "candidate" ? "unproofread_or_missing_pages" : a.status };
  });
  await Bun.write(`${dir}/checks.jsonl`, checks.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  await Bun.write(`${dir}/pages-held.md`, `# Том ${vol}: вычитанные статьи, не вошедшие в заливку через <pages>\n\n| Статья | Причина |\n|---|---|\n${held.map((h) => `| ${esc(h.title)} | ${esc(h.why)} |`).join("\n")}\n`);
  console.log(`Задержано: ${held.length} (см. pages-held.md).`);
}
