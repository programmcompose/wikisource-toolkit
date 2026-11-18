import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { decide, frame, parseReviewed, raiseLevel, sectionGaps } from "./pilot-upload";

const head = (level = "1") => `<noinclude><pagequality level="${level}" user="Vladis13" />__NOINDEX__<div class="text"></noinclude>`;
const foot = `<noinclude><!-- -->\n<references /></div></noinclude>`;
const page = (body: string, level = "1") => `${head(level)}${body}${foot}`;

describe("решение по странице", () => {
  const model = page("Размеченный текст"), snapshot = page("Сырой OCR");
  test("страница уровня 1 без чужих правок готова", () => {
    expect(decide(model, snapshot, snapshot, []).status).toBe("ready");
  });
  test("уже залитая страница пропускается, в том числе при другом конце строки", () => {
    expect(decide(model, snapshot, model.replace(/\n/g, "\r\n"), []).status).toBe("done");
  });
  test("страница, которую правили после снимка, задерживается", () => {
    expect(decide(model, snapshot, page("Правка участника"), []).why).toContain("после снимка");
  });
  test("вычитанная страница не перезаписывается", () => {
    expect(decide(model, snapshot, page("Сырой OCR", "3"), []).why).toContain("уровень 3");
  });
  test("разметка не может поднять уровень", () => {
    expect(decide(page("Текст", "3"), snapshot, snapshot, []).why).toContain("уровень не 1");
  });
  test("разметка не может менять шапку и подвал", () => {
    expect(decide(`${head()}Текст<noinclude>другой подвал</noinclude>`, snapshot, snapshot, []).why).toContain("шапку");
  });
  test("страницу, включённую в статью, не трогаем", () => {
    expect(decide(model, snapshot, snapshot, ["БСЭ1/Хубэй"]).why).toContain("БСЭ1/Хубэй");
  });
  test("страницы нет на сайте", () => {
    expect(decide(model, snapshot, null, []).status).toBe("held");
  });
  test("служебная часть не зависит от текста", () => {
    expect(frame(page("а"))).toBe(frame(page("б")));
    expect(frame("без шапки")).toBeNull();
  });
});

describe("публикация после сверки", () => {
  const model = page("Размеченный текст"), snapshot = page("Сырой OCR");
  const target = raiseLevel(model, "SlovarBot");
  test("уровень поднимается до 3, текст не меняется", () => {
    expect(target).toBe(page("Размеченный текст", "3").replace('user="Vladis13"', 'user="SlovarBot"'));
    expect(() => raiseLevel(page("Текст", "3"), "SlovarBot")).toThrow();
  });
  test("страница OCR уровня 1 готова к заливке с уровнем 3", () => {
    expect(decide(model, snapshot, snapshot, [], target).status).toBe("ready");
  });
  test("своя проба уровня 1 поднимается до 3, если её не правили", () => {
    expect(decide(model, snapshot, model, [], target).status).toBe("ready");
    expect(decide(model, snapshot, page("Правка участника"), [], target).status).toBe("held");
  });
  test("страница, уже залитая с уровнем 3, пропускается", () => {
    expect(decide(model, snapshot, target, [], target).status).toBe("done");
  });
  test("страницу, вычитанную другим участником, не трогаем", () => {
    expect(decide(model, snapshot, page("Сырой OCR", "3"), [], target).why).toContain("уровень 3");
  });
  test("список сверенных: номера, комментарии, пустые строки", () => {
    expect(parseReviewed("244\n# сверено 10 ноября\n\n245 # формула проверена\r\n")).toEqual([244, 245]);
    expect(() => parseReviewed("244, 245")).toThrow();
  });
});

describe("разрывы секций", () => {
  test("показывает секции без пары на соседних страницах", () => {
    const model = page(`Текст<section end="а"/><section begin="б"/>Текст`);
    expect(sectionGaps(model, page("OCR"), `<section begin="а"/>`, `<section end="б"/>`)).toEqual([]);
    expect(sectionGaps(model, page("OCR"), "", "")).toHaveLength(2);
  });
  test("показывает секции соседей, которые разметка оставила без пары", () => {
    const live = page(`<section end="х"/>Текст<section begin="у"/>`);
    expect(sectionGaps(page("Текст"), live, `<section begin="х"/>`, `<section end="у"/>`)).toHaveLength(2);
    expect(sectionGaps(page("Текст"), live, "", "")).toEqual([]);
  });
});

describe("запуск на поддельном API", () => {
  const file = "F.pdf";
  const title = (n: number) => `Страница:${file}/${n}`;
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  let edits: Record<string, string>[] = [];
  let included: Record<string, string[]> = {};
  const site: Record<string, { content: string; revid: number }> = {};
  const answer = (b: Record<string, string>) => {
    if (b.action === "login") return { login: { result: "Success" } };
    if (b.meta === "tokens") return { query: { tokens: { logintoken: "l", csrftoken: "c" } } };
    if (b.prop === "transcludedin") return { query: { pages: b.titles.split("|").map((t) => ({ title: t, transcludedin: (included[t] ?? []).map((x) => ({ title: x })) })) } };
    if (b.prop === "revisions") return { query: { pages: b.titles.split("|").map((t) => site[t] ? { title: t, revisions: [{ revid: site[t].revid, timestamp: "2026-11-05T00:00:00Z", slots: { main: { content: site[t].content } } }] } : { title: t, missing: true }) } };
    if (b.action === "edit") { edits.push(b); return { edit: { result: "Success", newrevid: 100 } }; }
    return { error: { code: "unknown" } };
  };
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", resolve(import.meta.dir, "pilot-upload.ts"), "--dir", dir, "--file", file, ...args], { env: { ...process.env, WS_TEST_MODE: "1", WS_API: `http://localhost:${server.port}/`, WS_BOT_USER: "u", WS_BOT_PASS: "p" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  };
  beforeAll(async () => {
    server = Bun.serve({ port: 0, async fetch(req) { return Response.json(answer(Object.fromEntries(new URLSearchParams(await req.text())))); } });
    dir = await mkdtemp(join(tmpdir(), "pilot-upload-"));
    await mkdir(join(dir, "model"));
    await mkdir(join(dir, "ocr"));
    for (const n of [5, 9]) {
      await Bun.write(join(dir, "model", `${n}.wiki`), page(`Разметка ${n}`));
      await Bun.write(join(dir, "ocr", `${n}.wiki`), page(`OCR ${n}`));
    }
  });
  afterAll(async () => {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    edits = [];
    included = {};
    site[title(5)] = { content: page("OCR 5"), revid: 50 };
    site[title(9)] = { content: page("OCR 9"), revid: 90 };
  });
  test("проверка ничего не публикует", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("К заливке: 2");
    expect(edits.length).toBe(0);
  });
  test("публикация требует лимита и не выходит за размер пробы", async () => {
    expect((await run("--publish")).code).not.toBe(0);
    expect((await run("--publish", "--limit", "6", "--pause", "0")).code).not.toBe(0);
    expect(edits.length).toBe(0);
  });
  test("публикация передаёт версию для обнаружения конфликта и соблюдает лимит", async () => {
    const r = await run("--publish", "--limit", "1", "--pause", "0");
    expect(r.code).toBe(0);
    expect(edits.length).toBe(1);
    expect(edits[0]).toMatchObject({ title: title(5), baserevid: "50", nocreate: "1", assert: "user", text: page("Разметка 5") });
    expect(edits[0].summary).toContain("уровень 1");
  });
  test("включение в саму страницу индекса заливке не мешает", async () => {
    included[title(5)] = [`Индекс:${file}`];
    expect((await run()).out).toContain("К заливке: 2");
  });
  test("режим сверки без reviewed.txt не запускается", async () => {
    const r = await run("--reviewed");
    expect(r.code).not.toBe(0);
    expect(edits.length).toBe(0);
  });
  test("режим сверки заливает только сверенные страницы и ставит уровень 3", async () => {
    await Bun.write(join(dir, "reviewed.txt"), "9 # сверено\n");
    try {
      const check = await run("--reviewed");
      expect(check.out).toContain("К заливке: 1");
      expect(edits.length).toBe(0);
      const r = await run("--reviewed", "--publish", "--limit", "5", "--pause", "0");
      expect(r.code).toBe(0);
      expect(edits.length).toBe(1);
      expect(edits[0].title).toBe(title(9));
      expect(edits[0].text).toContain('<pagequality level="3" user="u" />');
      expect(edits[0].text).toContain("Разметка 9");
      expect(edits[0].summary).toContain("уровень 3");
    } finally {
      await rm(join(dir, "reviewed.txt"));
    }
  });
  test("в reviewed.txt нельзя вписать страницу без разметки", async () => {
    await Bun.write(join(dir, "reviewed.txt"), "7\n");
    try {
      expect((await run("--reviewed")).code).not.toBe(0);
    } finally {
      await rm(join(dir, "reviewed.txt"));
    }
  });
  test("чужая правка и включение в статью останавливают только свою страницу", async () => {
    site[title(5)].content = page("Правка участника");
    included[title(9)] = ["БСЭ1/Статья"];
    const r = await run("--publish", "--limit", "5", "--pause", "0");
    expect(r.out).toContain("К заливке: 0");
    expect(edits.length).toBe(0);
  });
});
