import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "path";
import { pageRanges, retouchArticle } from "./retouch";

const head = (q: string) => `{{БСЭ1\n| НАЗВАНИЕ     = А\n| КАЧЕСТВО     =${q}\n}}\n\n`;
const tag = `<pages index="F.pdf" from=8 to=9 fromsection="а" tosection="а" />`;

describe("правка статьи", () => {
  test("КАЧЕСТВО ставится только при вычитанных страницах и только если пусто", () => {
    expect(retouchArticle(head("") + tag, true).text).toBe(head(" 3") + tag);
    expect(retouchArticle(head("") + tag, false).changes).toEqual([]);
    expect(retouchArticle(head(" 2") + tag, true).changes).toEqual([]);
  });
  test("разрядка правится, слова не меняются", () => {
    const r = retouchArticle(`${head(" 3")}{{razr2|Кукес}} И. С.`, false);
    expect(r.text).toBe(`${head(" 3")}{{razr|Кукес}} И. С.`);
    expect(r.changes.length).toBe(1);
  });
  test("диапазон страниц из тега", () => {
    expect(pageRanges(tag)).toEqual([{ file: "F.pdf", from: 8, to: 9 }]);
    expect(pageRanges("Текст без тега")).toEqual([]);
  });
});

describe("запуск на поддельном API", () => {
  let server: ReturnType<typeof Bun.serve>;
  let edits: Record<string, string>[] = [];
  const site: Record<string, { content: string; revid: number }> = {};
  const answer = (b: Record<string, string>) => {
    if (b.action === "login") return { login: { result: "Success" } };
    if (b.meta === "tokens") return { query: { tokens: { logintoken: "l", csrftoken: "c" } } };
    if (b.list === "usercontribs") return { query: { usercontribs: Object.keys(site).filter((t) => t.startsWith("БСЭ1/")).map((title) => ({ title })) } };
    if (b.prop === "revisions") return { query: { pages: b.titles.split("|").map((title) => site[title] ? { title, revisions: [{ revid: site[title].revid, slots: { main: { content: site[title].content } } }] } : { title, missing: true }) } };
    if (b.action === "edit") { edits.push(b); return { edit: { result: "Success" } }; }
    return { error: { code: "unknown" } };
  };
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", resolve(import.meta.dir, "retouch.ts"), ...args], { env: { ...process.env, WS_TEST_MODE: "1", WS_API: `http://localhost:${server.port}/`, WS_BOT_USER: "u", WS_BOT_PASS: "p" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  };
  beforeAll(() => {
    server = Bun.serve({ port: 0, async fetch(req) { return Response.json(answer(Object.fromEntries(new URLSearchParams(await req.text())))); } });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    edits = [];
    for (const k of Object.keys(site)) delete site[k];
    Object.assign(site, {
      "БСЭ1/Вычитанная": { content: head("") + tag, revid: 11 },
      "БСЭ1/Уровень один": { content: head("") + `<pages index="F.pdf" from=20 to=20 fromsection="б" tosection="б" />`, revid: 12 },
      "БСЭ1/Разрядка": { content: `${head(" 3")}{{razr2|Кукес}} И. С.`, revid: 13 },
      "БСЭ1/Готовая": { content: `${head(" 3")}{{razr|Кукес}} И. С.`, revid: 14 },
      "Страница:F.pdf/8": { content: `<pagequality level="3" user="Egor" />`, revid: 1 },
      "Страница:F.pdf/9": { content: `<pagequality level="4" user="Egor" />`, revid: 2 },
      "Страница:F.pdf/20": { content: `<pagequality level="1" user="Vladis13" />`, revid: 3 },
    });
  });
  test("проверка ничего не публикует и не требует лимита", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Нужна правка: 2");
    expect(edits.length).toBe(0);
  });
  test("публикация соблюдает лимит и передаёт версию для обнаружения конфликта", async () => {
    expect((await run("--publish")).code).not.toBe(0);
    const r = await run("--publish", "--limit", "1", "--pause", "0");
    expect(r.code).toBe(0);
    expect(edits.length).toBe(1);
    expect(edits[0]).toMatchObject({ title: "БСЭ1/Вычитанная", baserevid: "11", nocreate: "1", assert: "user" });
    expect(edits[0].text).toContain("| КАЧЕСТВО     = 3");
    expect(edits[0].summary).toContain("Текст не менялся");
  });
  test("статья на страницах уровня 1 и готовая статья не правятся", async () => {
    await run("--publish", "--limit", "10", "--pause", "0");
    expect(edits.map((e) => e.title)).toEqual(["БСЭ1/Вычитанная", "БСЭ1/Разрядка"]);
  });
});
