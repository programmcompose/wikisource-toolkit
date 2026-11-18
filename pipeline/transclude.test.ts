// Включение страниц через <pages>. Сверка и заливка идут на локальном поддельном API.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { checkRendered, planTransclusion, readerWords, renderPagesTag, type PlanResult } from "./parse";
import { classify } from "./prepare";
import { headMismatch, selectArticles } from "./transclude";

const page = (n: number, body: string, level = "3") => ({
  file: "F.pdf", n,
  content: `<noinclude><pagequality level="${level}" user="Egor" /><div class="text"></noinclude>${body}<noinclude></div></noinclude>`,
});
const planned = (r: PlanResult) => { if ("problem" in r) throw new Error(r.problem); return r; };
const problem = (r: PlanResult) => ("problem" in r ? r.problem : "");

describe("название и заголовок в тексте", () => {
  test("опечатка словника находится", () => {
    expect(headMismatch("Хорга", "'''ХОРТА''' (Horta), город")).toBe("ХОРТА");
    expect(headMismatch("Хордотоальные органы", "'''ХОРДОТОНАЛЬНЫЕ ОРГАНЫ,''' текст")).toBe("ХОРДОТОНАЛЬНЫЕ ОРГАНЫ,");
    expect(headMismatch("Налоги с оборота", "'''НАЛОГ С ОБОРОТА,''' текст")).toBe("НАЛОГ С ОБОРОТА,");
    expect(headMismatch("Нальчинский могильник", "'''НАЛЬЧИКСКИЙ МОГИЛЬНИК,''' текст")).toBe("НАЛЬЧИКСКИЙ МОГИЛЬНИК,");
  });
  test("сокращение с точкой совпадает с полным словом", () => {
    expect(headMismatch("Нижне-Тагильский завод", "'''НИЖНЕ-ТАГИЛЬСК. ЗАВОД''' текст")).toBeNull();
  });
  test("уточнения, кавычки, сокращения и ё не считаются расхождением", () => {
    expect(headMismatch("Хорда, в биологии", "'''ХОРДА,''' текст")).toBeNull();
    expect(headMismatch("Хорти, Миклош", "'''ХОРТИ''' (Horthy), Миклош")).toBeNull();
    expect(headMismatch("«Христианская наука»", "'''«ХРИСТИАНСКАЯ НАУКА»''' текст")).toBeNull();
    expect(headMismatch("Хрен", "'''ХРЕН,''' текст")).toBeNull();
    expect(headMismatch("Чёрное море", "'''ЧЕРНОЕ МОРЕ,''' текст")).toBeNull();
  });
  test("без жирного заголовка сравнивать не с чем", () => {
    expect(headMismatch("Хорта", "Текст без заголовка")).toBeNull();
  });
  test("статья с расхождением задерживается", () => {
    const articles = [{ id: "1", seq: 1, title: "Хорга", head: "Хорга", status: "candidate", reasons: [], weak: false, pages: [{ file: "F.pdf", n: 5 }], ocr: "'''ХОРТА''' город." }] as any;
    const { ready, held } = selectArticles(articles, [page(5, `<section begin="хорга"/>'''ХОРТА''' город.<section end="хорга"/>`)]);
    expect(ready.length).toBe(0);
    expect(held[0].why).toContain("ХОРТА");
  });
  test("расхождение, сверенное по скану (heads-ok.txt), не задерживает", () => {
    const articles = [{ id: "1", seq: 1, title: "Хордофоны", head: "Хордофоны", status: "candidate", reasons: [], weak: false, pages: [{ file: "F.pdf", n: 5 }], ocr: "'''ХОРОДФОНЫ''' инструменты." }] as any;
    const pages = [page(5, `<section begin="хородфоны"/>'''ХОРОДФОНЫ''' инструменты.<section end="хородфоны"/>`)];
    expect(selectArticles(articles, pages).ready.length).toBe(0);
    expect(selectArticles(articles, pages, new Set(["Хордофоны"])).ready.length).toBe(1);
  });
  test("{{nop}} следующей страницы не делает короткую отсылку «шире секции» (Хороводные песни, т. 60)", () => {
    const articles = [{ id: "1", seq: 1, title: "Хороводные песни", head: "Хороводные песни", status: "candidate", reasons: [], weak: false, pages: [{ file: "F.pdf", n: 5 }, { file: "F.pdf", n: 6 }], ocr: "'''ХОРОВОДНЫЕ ПЕСНИ,''' см. ''{{lsafe|Песни}}''. {{nop}}" },
      { id: "2", seq: 2, title: "Хоровые кружки", head: "Хоровые кружки", status: "exists", reasons: [], weak: false, pages: [{ file: "F.pdf", n: 6 }], ocr: "'''ХОРОВЫЕ КРУЖКИ,''' ячейки." }] as any;
    const pages = [page(5, `<section begin="хороводные песни"/>'''ХОРОВОДНЫЕ ПЕСНИ,''' см. ''{{lsafe|Песни}}''.<section end="хороводные песни"/>`), page(6, `{{nop}}\n<section begin="хоровые кружки"/>'''ХОРОВЫЕ КРУЖКИ,''' ячейки.<section end="хоровые кружки"/>`)];
    const r = selectArticles(articles, pages);
    expect(r.held).toEqual([]);
    expect(r.ready[0].plan.to).toBe(5);
  });
});

describe("план включения", () => {
  test("секция на одной странице", () => {
    const r = planned(planTransclusion("б", [page(5, `<section end="а"/><section begin="б"/>'''Б,''' текст.<section end="б"/><section begin="в"/>в`)]));
    expect(r.plan).toEqual({ index: "F.pdf", from: 5, to: 5, section: "б" });
    expect(r.text).toBe("'''Б,''' текст.");
  });
  test("секция через три страницы, закрытая на последней", () => {
    const r = planned(planTransclusion("а", [page(1, `<section begin="а"/>раз`), page(2, "два"), page(3, `три<section end="а"/><section begin="б"/>б`)]));
    expect(r.plan).toMatchObject({ from: 1, to: 3 });
    expect(r.text).toBe("раз два три");
  });
  test("следующая страница, где сразу начинается другая статья, не входит в диапазон", () => {
    const r = planned(planTransclusion("а", [page(1, `<section begin="а"/>раз<section end="а"/>`), page(2, `{{nop}}\n<section begin="б"/>б`)]));
    expect(r.plan.to).toBe(1);
  });
  test("тег записан так же, как в действующих статьях", () => {
    expect(renderPagesTag({ index: "F.pdf", from: 1, to: 2, section: "а б" })).toBe(`<pages index="F.pdf" from=1 to=2 fromsection="а б" tosection="а б" />`);
  });
  test("опечатка в закрывающем теге: иначе в статью попадёт соседняя", () => {
    expect(problem(planTransclusion("а", [page(1, `<section begin="а"/>т<section end="а."/><section begin="б"/>б`)]))).toContain("нет закрывающего");
  });
  test("секция без конца на последней странице", () => {
    expect(problem(planTransclusion("а", [page(1, `<section begin="а"/>т`), page(2, "дальше")]))).toContain("нет закрывающего");
  });
  test("омонимы на странице: сайт вывел бы оба", () => {
    expect(problem(planTransclusion("а", [page(1, `<section begin="а"/>т<section end="а"/><section begin="а"/>у<section end="а"/>`)]))).toContain("не один раз");
  });
  test("другая секция внутри статьи", () => {
    expect(problem(planTransclusion("а", [page(1, `<section begin="а"/>т<section end="а"/>`)], 1))).toContain("другие секции");
    expect(problem(planTransclusion("а", [page(1, `<section begin="а"/>т<section begin="б"/>у<section end="б"/><section end="а"/>`)]))).toContain("другие теги");
  });
  test("текст после конца секции: это может быть подпись", () => {
    expect(problem(planTransclusion("а", [page(1, `<section begin="а"/>т<section end="а"/>\nА. Брюсов.\n<section begin="б"/>б`)]))).toContain("вне секций");
    expect(problem(planTransclusion("а", [page(1, `<section begin="а"/>т<section end="а"/>`), page(2, `А. Брюсов.<section begin="б"/>б`)]))).toContain("вне секций");
  });
  test("разные файлы, пропуск страницы и тег без кавычек", () => {
    expect(problem(planTransclusion("а", [page(1, `<section begin="а"/>т`), { ...page(2, `т<section end="а"/>`), file: "G.pdf" }]))).toContain("другой файл");
    expect(problem(planTransclusion("а", [page(1, `<section begin="а"/>т`), page(3, `т<section end="а"/>`)]))).toContain("не подряд");
    expect(problem(planTransclusion("а", [page(1, `<section begin=а />т<section end="а"/>`)]))).toContain("нестандартного");
  });
});

const html = (n: number[], text: string, level = 3) =>
  `<div class="prp-pages-output"><p>${n.map((x) => `<span><span class="noprint ws-noexport pagenumber" id="${x}" data-page-number="${x}" data-page-name="С/${x}" data-page-index="${x}" data-page-quality="${level}">[<a href="/x">${x}</a>]</span></span>`).join("")}${text}&#32;</p></div>`;
const plan = { index: "F.pdf", from: 1, to: 2, section: "а" };
const body = "'''АЛЬФА,''' первое {{razr|слово}} и ''{{lsafe|Бета|беты}}'' {{перенос|дру|гое}} слово статьи";

describe("сверка готового результата", () => {
  const good = "<b>АЛЬФА,</b> первое <span>слово</span> и <i><a>беты</a></i> другое слово статьи";
  test("совпадение проходит, шаблоны и номера страниц не мешают", () => {
    expect(readerWords(body).join(" ")).toBe("альфа первое слово и беты другое слово статьи");
    expect(checkRendered(body, html([1, 2], good), plan)).toEqual([]);
  });
  test("сущности и ссылка с префиксом БСЭ1/ не считаются расхождением", () => {
    const raw = "'''ЯД,''' к&#x2011;рый хо&#x0301;рей, см. {{lsafe|БСЭ1/Психология}}";
    expect(checkRendered(raw, html([1, 2], "<b>ЯД,</b> к&#x2011;рый хо&#x301;рей, см. <a>Психология</a>"), plan)).toEqual([]);
  });
  test("в результат попало начало следующей статьи", () => {
    expect(checkRendered(body, html([1, 2], `${good} <b>БЕТА,</b> совсем другая статья про совсем другое дело`), plan).join()).toContain("другой конец");
  });
  test("уровень страницы успел понизиться", () => {
    expect(checkRendered(body, html([1, 2], good, 1), plan).join()).toContain("уровень ниже 3");
  });
  test("примечание редакторов Викитеки уходит в конец и не считается расхождением (Хо-лун, т. 60)", () => {
    const raw = "'''ХО-ЛУН,''' во время ''{{lsafe|Северная экспедиция|Северной экспедиции}}''{{Примечание ВТ|В энциклопедии нет такой статьи.}} (см.) стал командиром.\n\n{{Примечания ВТ}}";
    const shown = `<b>ХО-ЛУН,</b> во время <i>Северной экспедиции</i><sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[ВТ 1]</a></sup> (см.) стал командиром.</p>`
      + `<div class="mw-heading mw-heading2"><h2 id="Примечания_редакторов_Викитеки">Примечания редакторов Викитеки</h2></div>`
      + `<div class="references-small"><ol class="references" data-mw-group="ВТ"><li><span class="reference-text">В энциклопедии нет такой статьи.</span></li></ol></div><p>`;
    expect(checkRendered(raw, html([1, 2], shown), plan)).toEqual([]);
  });
  test("сноска книги (<ref>) уходит в конец и не считается расхождением (Октябрьская революция, т. 43)", () => {
    const raw = "'''РЕВОЛЮЦИЯ.'''<ref>Извлечения из Краткого курса, стр. 174—214.</ref> Текст статьи до конца.";
    const shown = `<b>РЕВОЛЮЦИЯ.</b><sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup> Текст статьи до конца.</p>`
      + `<div class="mw-references-wrap"><ol class="references"><li id="cite_note-1"><span class="reference-text">Извлечения из Краткого курса, стр. 174—214.</span></li></ol></div>`;
    expect(checkRendered(raw, html([1, 2], shown), plan)).toEqual([]);
  });
  test("атрибуты таблицы не считаются словами текста (Картель, т. 31)", () => {
    const raw = `'''КАРТЕЛЬ,''' индексы:\n{| style="margin:auto;" border="1"\n! rowspan="3" | Годы\n! colspan="2" | Германия\n|-\n| style="text-align:left;" | 1929 || 105,0 || 97,4\n|}\nдалее текст статьи.`;
    const shown = `<b>КАРТЕЛЬ,</b> индексы:</p><table style="margin:auto;" border="1"><tr><th rowspan="3">Годы</th><th colspan="2">Германия</th></tr><tr><td style="text-align:left;">1929</td><td>105,0</td><td>97,4</td></tr></table><p>далее текст статьи.`;
    expect(checkRendered(raw, html([1, 2], shown), plan)).toEqual([]);
  });
  test("подпись страницы из индекса (номера столбцов) не мешает сверке номера файла (т. 53)", () => {
    const cols = html([1, 2], good).replace(/data-page-number="(\d)"/g, (_, x) => `data-page-number="${2 * +x + 73}-${2 * +x + 74}"`);
    expect(cols).toContain('data-page-number="75-76"');
    expect(checkRendered(body, cols, plan)).toEqual([]);
  });
  test("показаны не те страницы, пустой результат и ошибка", () => {
    expect(checkRendered(body, html([1], good), plan).join()).toContain("показаны страницы 1 вместо 1,2");
    expect(checkRendered(body, "", plan).join()).toContain("пустой");
    expect(checkRendered(body, `<strong class="error">Ошибка</strong>${html([1, 2], good)}`, plan).join()).toContain("ошибку");
  });
});

const pagesFixture = [
  page(1, `<section begin="чистая"/>'''ЧИСТАЯ,''' вычитанный текст статьи<section end="чистая"/><section begin="длинная"/>'''ДЛИННАЯ,''' начало`),
  page(2, `продолжение статьи<section end="длинная"/><section begin="опечатка"/>'''ОПЕЧАТКА,''' текст<section end="опечатка."/><section begin="расходится"/>'''РАСХОДИТСЯ,''' текст статьи<section end="расходится"/><section begin="подписанная"/>'''ПОДПИСАННАЯ,''' текст. А. Брюсов.<section end="подписанная"/><section begin="авторская"/>'''АВТОРСКАЯ,''' текст<section end="авторская"/>`),
  page(3, `<section begin="невычитанная"/>'''НЕВЫЧИТАННАЯ,''' текст<section end="невычитанная"/>`, "1"),
];
const entry = (seq: number, title: string, extra: object = {}) => ({ seq, title, head: title, cols: String(seq), colStart: seq, colEnd: seq, authors: [], linked: true, ...extra });
const titles = ["Чистая", "Длинная", "Опечатка", "Расходится", "Подписанная", "Авторская", "Невычитанная"];
const entries = titles.map((t, i) => entry(i + 1, t, t === "Авторская" ? { authors: ["И. И."] } : {}));
const statusMap = new Map(titles.map((t) => [`БСЭ1/${t}`, false]));
const fixture = () => {
  const arts = classify(7, 1930, entries, statusMap, pagesFixture);
  // prepare.ts уже отправил бы эту статью на разбор. Здесь проверяется запасной фильтр самой сборки.
  for (const a of arts) if (a.title === "Подписанная") { a.status = "candidate"; a.reasons = []; }
  return arts;
};

test("отбор: только кандидаты на вычитанных страницах с однозначной разметкой", () => {
  const { ready, held } = selectArticles(fixture(), pagesFixture);
  expect(ready.map((r) => r.article.title)).toEqual(["Чистая", "Длинная", "Расходится"]);
  expect(Object.fromEntries(held.map((h) => [h.title, h.why.split(":")[0]]))).toEqual({ "Опечатка": "нет закрывающего тега с тем же именем", "Подписанная": "конец текста похож на подпись" });
});

test("статья, закрытая в самом конце страницы, не захватывает следующую (Революционный комитет, т. 48)", () => {
  const pages = [
    page(1, `<section begin="первая"/>'''ПЕРВАЯ,''' текст до конца страницы.<section end="первая"/>`),
    page(2, `\n<section begin="вторая"/>'''ВТОРАЯ,''' начало следующей статьи`, "1"),
  ];
  const es = [entry(1, "Первая"), entry(2, "Вторая")];
  const arts = classify(7, 1930, es, new Map(es.map((e) => [`БСЭ1/${e.title}`, false])), pages);
  expect(arts[0].pages.map((p) => p.n)).toEqual([1]);
  expect(selectArticles(arts, pages).ready.map((r) => r.article.title)).toEqual(["Первая"]);
});

describe("сборка и заливка на поддельном API", () => {
  let server: ReturnType<typeof Bun.serve>, vols: string, parses: Record<string, string>[], edits: Record<string, string>[];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const p: Record<string, string> = Object.fromEntries(new URLSearchParams(await req.text()));
        if (p.action === "parse") {
          parses.push(p);
          const m = p.text.match(/from=(\d+) to=(\d+) fromsection="([^"]*)"/)!;
          const texts: Record<string, string> = { "чистая": "ЧИСТАЯ, вычитанный текст статьи", "длинная": "ДЛИННАЯ, начало продолжение статьи", "расходится": "РАСХОДИТСЯ, текст статьи и начало следующей статьи целиком" };
          const n = Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i);
          return Response.json({ parse: { text: html(n, texts[m[3]]) } });
        }
        if (p.action === "edit") { edits.push(p); return Response.json({ edit: { result: "Success", newrevid: 1 } }); }
        if (p.action === "login") return Response.json({ login: { result: "Success" } });
        if (p.meta === "tokens") return Response.json({ query: { tokens: { logintoken: "L", csrftoken: "C" } } });
        if (p.titles) return Response.json({ query: { pages: p.titles.split("|").map((title) => ({ title, missing: true })) } });
        return Response.json({ error: { code: "unexpected" } });
      },
    });
  });
  afterAll(() => { server.stop(true); rmSync(vols, { recursive: true, force: true }); });
  beforeEach(async () => {
    vols = mkdtempSync(join(tmpdir(), "bse-pages-"));
    parses = []; edits = [];
    await Bun.write(`${vols}/07/articles.jsonl`, fixture().map((a) => JSON.stringify(a)).join("\n") + "\n");
    await Bun.write(`${vols}/07/pages.json`, JSON.stringify(pagesFixture));
  });
  const run = async (script: string, ...args: string[]) => {
    const proc = Bun.spawn(["bun", resolve(import.meta.dir, script), "--vol", "7", ...args], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, WS_TEST_MODE: "1", WS_API: `http://localhost:${server.port}/`, WS_VOLS: vols, WS_RETRY_MS: "1", WS_BOT_USER: "u", WS_BOT_PASS: "p" },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out: out + err };
  };

  test("--offline не обращается к сайту и не создаёт манифест", async () => {
    const r = await run("transclude.ts", "--offline");
    expect(r.code).toBe(0);
    expect(parses.length).toBe(0);
    expect(await Bun.file(`${vols}/07/manifest-pages.jsonl`).exists()).toBe(false);
  });
  test("в манифест попадает только прошедшее сверку, и ничего не правится", async () => {
    const r = await run("transclude.ts");
    expect(r.code).toBe(0);
    expect(parses.length).toBe(3);
    expect(edits.length).toBe(0);
    const rows = (await Bun.file(`${vols}/07/manifest-pages.jsonl`).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((x) => x.title)).toEqual(["Чистая", "Длинная"]);
    expect(await Bun.file(`${vols}/07/pages-held.md`).text()).toContain("Расходится | сверка с сайтом");
    expect(await Bun.file(`${vols}/07/${rows[1].file}`).text()).toBe(`{{БСЭ1\n| НАЗВАНИЕ     = Длинная\n| СПИСОК       = \n| ПРЕДЫДУЩИЙ   = \n| СЛЕДУЮЩИЙ    = \n| ВИКИПЕДИЯ    =\n| ВИКИДАННЫЕ   =\n| ВИКИТЕКА     =\n| ВИКИСКЛАД    =\n| ВИКИСЛОВАРЬ  =\n| ВИКИЦИТАТНИК =\n| ВИКИУЧЕБНИК  =\n| ВИКИНОВОСТИ  =\n| ВИКИВИДЫ     =\n| НЕОДНОЗНАЧНОСТЬ =\n| КАЧЕСТВО     = 3\n}}\n\n<pages index="F.pdf" from=1 to=2 fromsection="длинная" tosection="длинная" />\n\n[[Категория:БСЭ1:Статьи без категорий]]\n`);
  });
  test("заливка берёт манифест страниц только по явному флагу, с createonly", async () => {
    await run("transclude.ts");
    expect((await run("upload.ts", "--pause", "0")).out).toContain("Манифест пуст");
    expect((await run("upload.ts", "--manifest", "другой")).out).toContain("только значение pages");
    expect(edits.length).toBe(0);
    const r = await run("upload.ts", "--pause", "0", "--manifest", "pages", "--publish", "--limit", "1");
    expect(r.code).toBe(0);
    expect(edits.length).toBe(1);
    expect(edits[0]).toMatchObject({ title: "БСЭ1/Чистая", createonly: "1", assert: "user" });
    expect(edits[0].text).toContain(`<pages index="F.pdf" from=1 to=1 fromsection="чистая" tosection="чистая" />`);
    expect(edits[0].summary).toContain("текст не менялся");
  });
});
