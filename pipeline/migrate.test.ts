// Перенос статей бота на страницы индекса. Сайт заменён локальным поддельным API.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildStream, planTransclusion, readerWords } from "./parse";
import { applyChanges, cutBody, findCut, pageEdits, planMigration, qualityFixes, splitArticle, visibleLetters, type LiveArticle, type SitePage } from "./migrate";
import type { Article } from "./prepare";

const FILE = "F.pdf";
const page = (n: number, body: string, level = "1"): SitePage => ({
  file: FILE, n, revid: 100 + n, timestamp: "2026-11-04T00:00:00Z",
  content: `<noinclude><pagequality level="${level}" user="Vladis13" /><div class="text"></noinclude>${body}<noinclude></div></noinclude>`,
});
const article = (title: string, pages: number[], extra: Partial<Article> = {}): Article => ({
  seq: 1, title, head: title.split(",")[0], cols: "1", authors: [], linked: true, id: title, status: "exists", reasons: [],
  pages: pages.map((n) => ({ file: FILE, n })), ocr: "", year: 1941, weak: false, ...extra,
} as Article);
const live = (title: string, body: string): LiveArticle => ({
  title: `БСЭ1/${title}`, revid: 7, timestamp: "2026-11-04T01:00:00Z",
  content: `{{БСЭ1\n| НАЗВАНИЕ     = ${title}\n| КАЧЕСТВО     = 3\n}}\n\n${body}\n\n[[Категория:БСЭ1:Реки]]\n`,
});
const RIVER = "'''РЕКА''' (Ravi), большая река в Индии, приток Ченаба.";
const OCR_RIVER = "'''РЕКА''' (Ravi), большая peKa в Индии, приток Ченаба.";

describe("вид статьи", () => {
  test("шапка и категории отделяются от текста", () => {
    const s = splitArticle(live("Рави", RIVER).content)!;
    expect(s.body).toBe(RIVER);
    expect(s.head).toContain("КАЧЕСТВО     = 3");
    expect(s.tail).toContain("[[Категория:БСЭ1:Реки]]");
  });
  test("статья без шапки не разбирается", () => expect(splitArticle("просто текст")).toBeNull());
  test("разрядка при переносе: razr перед пробелом, razr2 перед знаком", () => {
    const body = "'''РЕКА''' {{razr2|большая}} река, {{razr|приток}}, Ченаба.";
    const ocr = "'''РЕКА''' большая peKa, приток, Ченаба.";
    const r = planMigration([article("Река", [8])], [live("Река", body)], [page(8, `<section begin="река"/>${ocr}<section end="река"/>`)]);
    expect(r.ready[0].body).toBe("'''РЕКА''' {{razr|большая}} река, {{razr2|приток}}, Ченаба.");
  });
  test("читатель не видит цель ссылки и служебные шаблоны", () => {
    expect(visibleLetters("см. ''{{lsafe|Окружность|круга}}'' и {{razr|ось}}").letters).toBe("смкругаиось");
  });
});

describe("граница страниц", () => {
  const body = "Первая половина статьи о великих реках Индии и их притоках, затем вторая половина статьи о долинах и горах Пенджаба на севере";
  const before = "Первая половина статьи о великих реках Индии и их притоках,";
  const after = "затем вторая половина статьи о долинах и горах Пенджаба на севере";
  test("находится при ошибках распознавания", () => {
    const cut = findCut(body, before.replace("реках", "peках"), after.replace("долинах", "дoлинах"));
    expect(body.slice(0, cut as number).endsWith("притоках")).toBe(true);
  });
  test("чужой текст не даёт границы", () => {
    expect(typeof findCut(body, "совершенно посторонний текст про иное дело", "ещё один посторонний текст про другое")).toBe("string");
  });
  test("посреди слова ставится перенос", () => {
    expect(cutBody("великая река", 4)).toEqual(["вели-", "кая река"]);
  });
  test("знак препинания остаётся на первой странице, абзац сохраняется", () => {
    expect(cutBody("конец абзаца.\n\nНовый абзац", 12)).toEqual(["конец абзаца.", "\n\nНовый абзац"]);
  });
  test("нельзя резать внутри шаблона и выделения", () => {
    expect(cutBody("см. {{lsafe|Река|реки}} дальше", 19)).toContain("внутрь шаблона");
    expect(cutBody("см. ''реки дальше'' тут", 9)).toContain("внутрь выделения");
  });
});

describe("план переноса", () => {
  const one = (ocr: string, body = RIVER, level = "1") => planMigration(
    [article("Река", [8])], [live("Река", body)],
    [page(8, ocr, level)],
  );
  const held = (r: ReturnType<typeof one>) => r.held[0]?.why ?? "";

  test("секция заменяется текстом статьи, остальное на странице не меняется", () => {
    const content = `\n<section begin="река"/>${OCR_RIVER}<section end="река"/>\n\nСосед вне секций.\n<section begin="соседняя"/>'''СОСЕДНЯЯ''' статья<section end="соседняя"/>`;
    const r = planMigration([article("Река", [8])], [live("Река", RIVER)], [page(8, content.replace("\n\nСосед вне секций.\n", "\n\n"))]);
    expect(r.held).toEqual([]);
    const [edit] = pageEdits(r.ready, [page(8, content.replace("\n\nСосед вне секций.\n", "\n\n"))]);
    expect(edit.text).toContain(`<section begin="река"/>${RIVER}<section end="река"/> {{tq|3}}`);
    expect(edit.text).toContain(`<section begin="соседняя"/>'''СОСЕДНЯЯ''' статья<section end="соседняя"/>`);
    expect(edit.text).toContain(`<pagequality level="1" user="Vladis13" />`);
  });
  test("одноимённые статьи: секция выбирается по полному названию", () => {
    const content = `<section begin="река, приток"/>${OCR_RIVER}<section end="река, приток"/>

<section begin="река, озеро"/>'''РЕКА''' озеро в горах<section end="река, озеро"/>`;
    const r = planMigration([article("Река, озеро", [8], { head: "Река" })], [live("Река, озеро", "'''РЕКА''' озеро в горах")], [page(8, content)]);
    expect(r.held).toEqual([]);
    expect(r.ready[0].plan).toMatchObject({ section: "река, озеро" });
  });
  test("в шапке меняется только КАЧЕСТВО (4), категория на месте, текст уходит на страницу", () => {
    const r = one(`<section begin="река"/>${OCR_RIVER}<section end="река"/>`);
    expect(r.ready[0].articleText).toBe(`{{БСЭ1\n| НАЗВАНИЕ     = Река\n| КАЧЕСТВО     = 4\n}}\n\n<pages index="F.pdf" from=8 to=8 fromsection="река" tosection="река" />\n\n[[Категория:БСЭ1:Реки]]\n`);
  });
  test("секция на двух страницах с пустым end: тег исправляется, слова совпадают", () => {
    const body = "'''РЕКА''' начинается на первой странице скана и идёт долго, а заканчивается на следующей странице скана очень далеко";
    const p1 = page(12, `<section begin="река"/>'''РЕКА''' начинается на первой странице скана и идёт долго,`);
    const p2 = page(13, `а заканчивается на следующей странице скана очень далеко<section end=""/>\n\n<section begin="другая"/>другая<section end="другая"/>`);
    const r = planMigration([article("Река", [12, 13])], [live("Река", body)], [p1, p2]);
    expect(r.held).toEqual([]);
    expect(r.ready[0].plan).toMatchObject({ from: 12, to: 13, section: "река" });
    const edits = pageEdits(r.ready, [p1, p2]);
    expect(edits[1].text).toContain(`<section end="река"/> {{tq|3}}`);
    expect(edits[1].text).not.toContain(`<section end=""/>`);
    const plan = planTransclusion("река", edits.map((e) => ({ file: FILE, n: e.page.n, content: e.text })));
    if ("problem" in plan) throw new Error(plan.problem);
    expect(readerWords(plan.text)).toEqual(readerWords(body));
  });
  test("закрывающий тег в начале следующей страницы, которой нет в списке статьи", () => {
    const body = "'''РЕКА''' начинается на первой странице скана и идёт долго, а заканчивается на следующей странице скана очень далеко";
    const p1 = page(12, `<section begin="река"/>'''РЕКА''' начинается на первой странице скана и идёт долго,`);
    const p2 = page(13, `а заканчивается на следующей странице скана очень далеко<section end=""/>`);
    const r = planMigration([article("Река", [12])], [live("Река", body)], [p1, p2]);
    expect(r.held).toEqual([]);
    expect(r.ready[0].plan).toMatchObject({ from: 12, to: 13 });
  });
  test("соседняя страница другого уровня не мешает статье на одной странице", () => {
    const p1 = page(8, `<section begin="река"/>${OCR_RIVER}<section end="река"/>`);
    const r = planMigration([article("Река", [8])], [live("Река", RIVER)], [p1, page(9, "чужая", "3")]);
    expect(r.ready.length).toBe(1);
  });
  test("следующая страница уровня 3 не правится", () => {
    const body = "'''РЕКА''' начинается на первой странице скана и идёт долго, а заканчивается на следующей странице скана очень далеко";
    const p1 = page(12, `<section begin="река"/>'''РЕКА''' начинается на первой странице скана и идёт долго,`);
    const p2 = page(13, `а заканчивается на следующей странице скана очень далеко<section end=""/>`, "3");
    const r = planMigration([article("Река", [12])], [live("Река", body)], [p1, p2]);
    expect(r.held[0].why).toContain("не на уровне 1");
  });
  test("две статьи на одной странице объединяются в одну правку", () => {
    const p = page(8, `<section begin="река"/>${OCR_RIVER}<section end="река"/>\n<section begin="озеро"/>'''ОЗЕРО''' большое и глубокое<section end="озеро"/>`);
    const r = planMigration([article("Река", [8]), article("Озеро", [8])], [live("Река", RIVER), live("Озеро", "'''ОЗЕРО''' большое и глубокое")], [p]);
    expect(r.ready.length).toBe(2);
    const edits = pageEdits(r.ready, [p]);
    expect(edits.length).toBe(1);
    expect(edits[0].count).toBe(2);
    expect(edits[0].text.match(/\{\{tq\|3\}\}/g)!.length).toBe(2);
  });
  test("значок не мешает следующей статье и не попадает в поток", () => {
    const p = page(8, `<section begin="а"/>т<section end="а"/> {{tq|3}}\n<section begin="б"/>у<section end="б"/>`);
    expect("plan" in planTransclusion("а", [p])).toBe(true);
    expect(buildStream([p]).text).not.toContain("tq");
  });
  test("страница другого уровня не правится", () => {
    expect(held(one(`<section begin="река"/>${OCR_RIVER}<section end="река"/>`, RIVER, "3"))).toContain("не на уровне 1");
  });
  test("уже перенесённая статья пропускается", () => {
    const r = planMigration([article("Река", [8])], [live("Река", `<pages index="F.pdf" from=8 to=8 fromsection="река" tosection="река" />`)], [page(8, "")]);
    expect(r.done).toEqual(["Река"]);
    expect(r.ready).toEqual([]);
  });
  test("страница уже правлена: остаётся только статья", () => {
    const p = page(8, `<section begin="река"/>${RIVER}<section end="река"/> {{tq|3}}`);
    const r = planMigration([article("Река", [8])], [live("Река", RIVER)], [p]);
    expect(r.ready.length).toBe(1);
    expect(pageEdits(r.ready, [p])).toEqual([]);
    expect(r.ready[0].articleText).toContain("<pages");
  });
  test("задержки: нет секции, разные имена, повтор, подпись, чужой текст, сноска", () => {
    expect(held(one("просто текст"))).toContain("нет секции");
    expect(held(one(`<section begin="река"/>${OCR_RIVER}<section end="рекаа"/>`))).toContain("другим именем");
    expect(held(one(`<section begin="река"/>а<section end="река"/><section begin="река"/>б<section end="река"/>`))).toContain("повторяется");
    expect(held(one(`<section begin="река"/>${OCR_RIVER} А. Брюсов.<section end="река"/>`, `${RIVER} А. Брюсов.`))).toContain("подпись");
    expect(held(one(`<section begin="река"/>${OCR_RIVER} {{БСЭ1/Автор|Б. Иванов}}<section end="река"/>`))).toContain("шаблон автора");
    expect(held(one(`<section begin="река"/>совсем другой текст про далёкие горы и леса<section end="река"/>`))).toContain("другой текст");
    expect(held(one(`<section begin="река"/>${OCR_RIVER}<section end="река"/>`, `${RIVER}<ref>сноска</ref>`))).toContain("сноска");
    expect(held(one(`<section begin="река"/>${OCR_RIVER}<section end="река"/> А. Брюсов.\n<section begin="б"/>б<section end="б"/>`))).toContain("вне секций");
  });
  test("статья без секции в prepare задерживается сразу", () => {
    const r = planMigration([article("Река", [8], { weak: true })], [live("Река", RIVER)], [page(8, `<section begin="река"/>т<section end="река"/>`)]);
    expect(r.held[0].why).toContain("вручную");
  });
  test("КАЧЕСТВО 4 доправляется только у статей, перенесённых этим скриптом", () => {
    const tag = `<pages index="F.pdf" from=8 to=8 fromsection="река" tosection="река" />`;
    const empty = { ...live("Река", tag), content: live("Река", tag).content.replace("= 3", "=") };
    const four = { ...live("Озеро", tag), content: live("Озеро", tag).content.replace("= 3", "= 4") };
    const foreign = live("Чужая", tag);
    const plain = { ...live("Текст", RIVER), content: live("Текст", RIVER).content.replace("= 3", "=") };
    const moved = new Set(["БСЭ1/Река", "БСЭ1/Озеро", "БСЭ1/Текст"]);
    const fixes = qualityFixes([empty, four, foreign, plain], moved);
    expect(fixes.map((x) => x.title)).toEqual(["БСЭ1/Река"]);
    expect(fixes[0].text).toBe(empty.content.replace("КАЧЕСТВО     =", "КАЧЕСТВО     = 4"));
    expect(fixes[0]).toMatchObject({ revid: 7, timestamp: "2026-11-04T01:00:00Z" });
  });
  test("правки применяются с конца и не сдвигают друг друга", () => {
    expect(applyChanges("абвгд", [{ start: 0, end: 1, text: "ЖЖ" }, { start: 3, end: 4, text: "" }])).toBe("ЖЖбвд");
  });
});

describe("запуск на поддельном API", () => {
  let server: ReturnType<typeof Bun.serve>, vols: string, liveContent: string, edits: Record<string, string>[], parses: Record<string, string>[], rendered: string;
  const P8 = page(8, `<section begin="река"/>${OCR_RIVER}<section end="река"/>`);
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const p: Record<string, string> = Object.fromEntries(new URLSearchParams(await req.text()));
        if (p.list === "usercontribs") return Response.json({ query: { usercontribs: [{ title: "БСЭ1/Река" }, { title: "БСЭ1/Чужой том" }] } });
        if (p.prop === "revisions") return Response.json({ query: { pages: p.titles.split("|").map((title) => {
          const content = title.startsWith("БСЭ1/") ? liveContent : P8.content;
          return { title, revisions: [{ revid: 55, timestamp: "2026-11-04T02:00:00Z", slots: { main: { content } } }] };
        }) } });
        if (p.action === "parse") { parses.push(p); return Response.json({ parse: { text: rendered } }); }
        if (p.action === "edit") { edits.push(p); return Response.json({ edit: { result: "Success", newrevid: 1 } }); }
        if (p.action === "login") return Response.json({ login: { result: "Success" } });
        if (p.meta === "tokens") return Response.json({ query: { tokens: { logintoken: "L", csrftoken: "C" } } });
        return Response.json({ error: { code: "unexpected" } });
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(async () => {
    vols = mkdtempSync(join(tmpdir(), "bse-migrate-"));
    edits = []; parses = []; liveContent = live("Река", RIVER).content;
    rendered = `<div class="prp-pages-output"><span class="noprint pagenumber" data-page-number="8" data-page-name="x" data-page-index="8" data-page-quality="1">[8]</span> <b>РЕКА</b> (Ravi), большая река в Индии, приток Ченаба.</div>`;
    await Bun.write(`${vols}/48/articles.jsonl`, JSON.stringify(article("Река", [8])) + "\n");
  });
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", resolve(import.meta.dir, "migrate.ts"), "--vol", "48", ...args], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, WS_TEST_MODE: "1", WS_API: `http://localhost:${server.port}/`, WS_VOLS: vols, WS_RETRY_MS: "1", WS_BOT_USER: "u", WS_BOT_PASS: "p" },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    rmSync(join(vols, "48", "migrate"), { recursive: true, force: true });
    return { code, out: out + err };
  };
  test("без --publish ничего не правится, отчёт создан", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(edits.length).toBe(0);
    expect(await Bun.file(`${vols}/48/migrate-report.md`).text()).toContain("| Река | 8 | река | нет |");
  });
  test("без reviewed.txt публикация ничего не правит", async () => {
    const r = await run("--publish", "--limit", "5", "--pause", "0");
    expect(r.code).toBe(0);
    expect(r.out).toContain("reviewed.txt");
    expect(edits.length).toBe(0);
  });
  test("сначала страница, затем сверка, затем статья; конфликт правок ловит сайт", async () => {
    await Bun.write(`${vols}/48/reviewed.txt`, "Река\n");
    const r = await run("--publish", "--limit", "5", "--pause", "0");
    expect(r.code).toBe(0);
    expect(edits.map((e) => e.title)).toEqual([`Страница:${FILE}/8`, "БСЭ1/Река"]);
    expect(edits[0]).toMatchObject({ baserevid: "55", basetimestamp: "2026-11-04T02:00:00Z", nocreate: "1", assert: "user" });
    expect(edits[0].text).toContain("{{tq|3}}");
    expect(edits[0].text).toContain(`level="1"`);
    expect(edits[1].text).toContain("<pages");
    expect(parses.length).toBe(1);
  });
  test("сайт показал не то: статья не правится, запуск останавливается", async () => {
    await Bun.write(`${vols}/48/reviewed.txt`, "Река\n");
    rendered = `<div><span class="noprint pagenumber" data-page-number="8" data-page-name="x" data-page-index="8" data-page-quality="1">[8]</span> <b>РЕКА</b> и целая соседняя статья про совсем другое дело здесь же.</div>`;
    const r = await run("--publish", "--limit", "5", "--pause", "0");
    expect(r.code).toBe(1);
    expect(r.out).toContain("ОСТАНОВКА");
    expect(edits.map((e) => e.title)).toEqual([`Страница:${FILE}/8`]);
  });
  test("перенесённая раньше статья с пустым КАЧЕСТВО получает 4, остальное не трогается", async () => {
    liveContent = live("Река", `<pages index="F.pdf" from=8 to=8 fromsection="река" tosection="река" />`).content.replace("= 3", "=");
    await Bun.write(`${vols}/48/migrate-journal.jsonl`, JSON.stringify({ title: "БСЭ1/Река", result: "article-edited" }) + "\n");
    const dry = await run();
    expect(dry.out).toContain("поправить КАЧЕСТВО: 1");
    expect(edits.length).toBe(0);
    const r = await run("--publish", "--limit", "5", "--pause", "0");
    expect(r.code).toBe(0);
    expect(edits.map((e) => e.title)).toEqual(["БСЭ1/Река"]);
    expect(edits[0]).toMatchObject({ baserevid: "55", nocreate: "1", minor: "1" });
    expect(edits[0].text).toContain("| КАЧЕСТВО     = 4\n");
    expect(edits[0].text.replace("= 4", "=")).toBe(liveContent);
    expect(parses.length).toBe(0);
  });
  test("--quality-only не переносит новые статьи даже из reviewed.txt", async () => {
    await Bun.write(`${vols}/48/reviewed.txt`, "Река\n");
    const r = await run("--publish", "--quality-only", "--pause", "0");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Нечего публиковать");
    expect(edits.length).toBe(0);
  });
  test("лимит обязателен, без флага бота не больше 20", async () => {
    await Bun.write(`${vols}/48/reviewed.txt`, "Река\n");
    expect((await run("--publish", "--pause", "0")).out).toContain("--limit");
    expect((await run("--publish", "--limit", "21", "--pause", "0")).out).toContain("не больше 20");
    expect(edits.length).toBe(0);
  });
});
