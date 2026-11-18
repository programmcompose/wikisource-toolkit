// bun test pipeline
// Заливка проверяется на локальном поддельном API: к Викитеке тесты не обращаются.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { selectIndexes } from "./lib";
import { align, buildStream, changedShare, findComplex, findSignature, fixRazr, parseSlovnik, renderArticle } from "./parse";
import { classify } from "./prepare";

describe("словник", () => {
  const text = `{{Отексте|НАЗВАНИЕ = X}}
<div class=wordlist1>
== Ж ==
{{Статья в другом словнике|Железняков, Виктор|}}
* Железо ''13—32'' {{БСЭ1/Автор статьи в словнике| А. Раковский
|автор2=  Л. П.
|автор3=  М. Павлов}}
* {{Статья в словнике2|Железо торговое||32}}
* {{Статья в словнике2|Желеньский, Владислав|Желеньский|82}}
* {{Статья в словнике2|Жесткость, в технике|Жесткость||307—308|}}
* {{Статья в словнике2|Жигули||389—390}}  {{БСЭ1/Автор статьи в словнике| Е. Милановский}}
<!-- * {{Статья в словнике2|Скрытая||1}} -->
* Что-то непонятное
</div>`;
  const { entries, unparsed } = parseSlovnik(text);
  test("разбирает все виды строк", () => {
    expect(entries.map((e) => e.title)).toEqual(["Железо", "Железо торговое", "Желеньский, Владислав", "Жесткость, в технике", "Жигули"]);
    expect(unparsed).toEqual(["* Что-то непонятное"]);
  });
  test("статья без ссылки не считается ссылкой и хранит всех авторов", () => {
    expect(entries[0].linked).toBe(false);
    expect(entries[0].authors).toEqual(["А. Раковский", "Л. П.", "М. Павлов"]);
    expect(entries[0].colEnd).toBe(32);
  });
  test("автор находится и у строки со ссылкой", () => {
    expect(entries[4].linked).toBe(true);
    expect(entries[4].authors).toEqual(["Е. Милановский"]);
  });
  test("пометка АП, скобки и опечатка в кавычках дают закрытую статью", () => {
    const p = parseSlovnik(`* {{БСЭ1/АП-мини|мини=1}} Гистограмма ''115'' {{БСЭ1/Автор статьи в словнике| Б. Я. }}
* Центральный комитет [ЦК ВКП(б)] ''532—560'' {{БСЭ1/Автор статьи в словнике| И. И. }}
* Челябинский завод ''164—168' {{БСЭ1/Автор статьи в словнике|Б. С.  |автор2=   Д. Ш.}}
* ...`);
    expect(p.entries.map((e) => [e.title, e.linked, e.cols])).toEqual([
      ["Гистограмма", false, "115"],
      ["Центральный комитет [ЦК ВКП(б)]", false, "532—560"],
      ["Челябинский завод", false, "164—168"],
    ]);
    expect(p.unparsed).toEqual(["* ..."]);
  });
  test("столбцы и заглавное слово при лишнем параметре", () => {
    expect(entries[3].head).toBe("Жесткость");
    expect(entries[3].cols).toBe("307—308");
    expect(entries[2].head).toBe("Желеньский");
  });
});

const page = (n: number, body: string, level = "1") => ({
  file: "F.pdf", n,
  content: `<noinclude><pagequality level="${level}" user="X" />__NOINDEX__<div class="text"></noinclude>${body}<noinclude><references /></div></noinclude>`,
});
const entry = (seq: number, title: string, colStart: number, extra: object = {}) =>
  ({ seq, title, head: title.split(",")[0], cols: String(colStart), colStart, colEnd: colStart, authors: [], linked: true, ...extra });

describe("нарезка", () => {
  test("лишние секции остаются внутри статьи, омонимы идут по порядку", () => {
    const s = buildStream([page(1, `<section begin="жираф"/>'''ЖИРАФ,''' созвездие.<section end=""/><section begin="сша"/>'''США''' внутри.<section end=""/><section begin="жираф"/>'''ЖИРАФ,''' род.<section end=""/>`)]);
    const es = [entry(1, "Жираф, созвездие", 1), entry(2, "Жираф, род", 1)];
    const m = align(es, s.sections.filter((x) => !x.weak));
    expect(m[0]).toBe(0);
    expect(m[1]).toBe(2);
  });
  test("короткий заголовок находит секцию с полным названием из словника (Уде, т. 55; Диц, т. 22)", () => {
    const s = buildStream([page(1, `<section begin="диц, иоган"/>'''ДИЦ''' (Dietz), Иоган.<section end="диц, иоган"/><section begin="диц, фридрих"/>'''ДИЦ''' (Diez), Фридрих.<section end="диц, фридрих"/>`)]);
    const m = align([entry(1, "Диц, Иоган", 1), entry(2, "Диц, Фридрих", 1)], s.sections.filter((x) => !x.weak));
    expect(m).toEqual([0, 1]);
  });
  test("секция с ошибкой распознавания всё равно находится", () => {
    const s = buildStream([page(1, `<section begin="флоренции"/>'''ФЛОРЕНЦИЙ''' текст<section end=""/>`)]);
    expect(align([entry(1, "Флоренций", 1)], s.sections)[0]).toBe(0);
  });
  test("статья без секции находится по прописным буквам, даже слипшись с другим столбцом", () => {
    const s = buildStream([page(1, `<section begin="радио"/>'''РАДИО,''' текст универРАДИУС, расстояние.<section end=""/>`)]);
    const m = align([entry(1, "Радио", 1), entry(2, "Радиус", 1)], s.sections);
    expect(s.sections[m[1]].weak).toBe(true);
    expect(s.text.slice(s.sections[m[1]].offset)).toStartWith("РАДИУС");
  });
  test("перенос слова между страницами склеивается", () => {
    expect(buildStream([page(1, "фон-"), page(2, "ды")]).text).toBe("фонды");
    expect(buildStream([page(1, "дом"), page(2, "стоит")]).text).toBe("дом стоит");
  });
});

describe("авторские права", () => {
  const status = new Map([["БСЭ1/Чистая", false], ["БСЭ1/Подписанная", false], ["БСЭ1/ВСловнике", false], ["БСЭ1/Есть", true], ["БСЭ1/Похожая", false]]);
  const body = [
    `<section begin="чистая"/>'''ЧИСТАЯ,''' обычный текст статьи без подписи и прочего.<section end=""/>`,
    `<section begin="подписанная"/>'''ПОДПИСАННАЯ,''' текст.\n\n{{right|{{БСЭ1/Автор|А. Жадовский.}}}}<section end=""/>`,
    `<section begin="всловнике"/>'''ВСЛОВНИКЕ,''' текст.<section end=""/>`,
    `<section begin="безссылки"/>'''БЕЗССЫЛКИ,''' текст.<section end=""/>`,
    `<section begin="есть"/>'''ЕСТЬ,''' текст.<section end=""/>`,
    `<section begin="похожая"/>'''ПОХОЖАЯ,''' текст статьи. Г. Недошивин.<section end=""/>`,
  ].join("");
  const es = [
    entry(1, "Чистая", 1), entry(2, "Подписанная", 1), entry(3, "ВСловнике", 1, { authors: ["И. И."] }),
    entry(4, "БезСсылки", 1, { linked: false }), entry(5, "Есть", 1), entry(6, "Похожая", 1),
  ];
  const got = Object.fromEntries(classify(1, 1930, es, status, [page(1, body)]).map((a) => [a.title, a.status]));
  test("кандидат только чистая статья", () => expect(got["Чистая"]).toBe("candidate"));
  test("подпись в тексте закрывает статью", () => expect(got["Подписанная"]).toBe("blocked"));
  test("автор в словнике закрывает статью", () => expect(got["ВСловнике"]).toBe("blocked"));
  test("статья без ссылки закрыта", () => expect(got["БезСсылки"]).toBe("blocked"));
  test("существующая страница пропускается", () => expect(got["Есть"]).toBe("exists"));
  test("похожее на подпись идёт на разбор", () => expect(got["Похожая"]).toBe("review"));
  test("«См. Глаз.» не подпись", () => {
    expect(findSignature("Ресничное тело. См. Глаз.")).toBeNull();
    expect(findSignature("Текст.\nВ. Бухина.")?.sure).toBe(false);
  });
});

test("признаки сложной разметки", () => expect(findComplex("{| x |} <math>a</math>")).toEqual(["таблица", "формула"]));
test("доля расхождения", () => {
  expect(changedShare("один два три", "один два три")).toBe(0);
  expect(changedShare("один два три четыре", "один два три пять")).toBe(0.25);
});
describe("разрядка", () => {
  test("слово оборачивается целиком, а не на одну букву", () => {
    expect(fixRazr("{{razr|Истори}}я")).toBe("{{razr2|История}}");
    expect(fixRazr("или {{razr|статич}}еские, органы")).toBe("или {{razr2|статические}}, органы");
    expect(fixRazr("о{{razr|стры}}й катар")).toBe("{{razr|острый}} катар");
  });
  test("перед пробелом razr, перед знаком и в конце razr2", () => {
    expect(fixRazr("{{razr2|Маркс}} и {{razr|Энгельс}}, все")).toBe("{{razr|Маркс}} и {{razr2|Энгельс}}, все");
    expect(fixRazr("{{razr|болото}}»")).toBe("{{razr2|болото}}»");
    expect(fixRazr("{{razr|слово}}")).toBe("{{razr2|слово}}");
    expect(fixRazr("{{razr2|Кукес}}&nbsp;И.")).toBe("{{razr|Кукес}}&nbsp;И.");
    expect(fixRazr("''{{razr2|курсив}}'' дальше")).toBe("''{{razr|курсив}}'' дальше");
  });
  test("фраза и повторный запуск", () => {
    const s = "{{razr2|Р. для судов}}, и {{razr2|Р. курсовые}} тоже";
    expect(fixRazr(s)).toBe("{{razr2|Р. для судов}}, и {{razr|Р. курсовые}} тоже");
    expect(fixRazr(fixRazr(s))).toBe(fixRazr(s));
  });
  test("сложное содержимое и знак на краю не трогаются лишний раз", () => {
    expect(fixRazr("{{razr|{{lsafe|А}}}} б")).toBe("{{razr|{{lsafe|А}}}} б");
    expect(fixRazr("{{razr|слово,}}далее")).toBe("{{razr2|слово,}}далее");
  });
});
test("шапка как в действующих статьях", () => {
  expect(renderArticle({ title: "Рави", body: "Текст.", quality: 2, category: "Реки" })).toBe(
    "{{БСЭ1\n| НАЗВАНИЕ     = Рави\n| СПИСОК       = \n| ПРЕДЫДУЩИЙ   = \n| СЛЕДУЮЩИЙ    = \n| ВИКИПЕДИЯ    =\n| ВИКИДАННЫЕ   =\n| ВИКИТЕКА     =\n| ВИКИСКЛАД    =\n| ВИКИСЛОВАРЬ  =\n| ВИКИЦИТАТНИК =\n| ВИКИУЧЕБНИК  =\n| ВИКИНОВОСТИ  =\n| ВИКИВИДЫ     =\n| НЕОДНОЗНАЧНОСТЬ =\n| КАЧЕСТВО     = 2\n}}\n\nТекст.\n\n[[Категория:БСЭ1:Реки]]\n",
  );
});
describe("индексы тома", () => {
  const all = ["БСЭ-1 Том 58. Флора - Франция (1936)-2.pdf", "БСЭ-1 Том 58. Флора - Франция (1936)-1.pdf", "БСЭ-1 Том 63. Э - Электрофон (1933).pdf", "БСЭ-1 Том 63. Э - Электрофон (1935).pdf"];
  test("части идут по порядку", () => expect(selectIndexes(all, 58).map((x) => x.part)).toEqual([1, 2]));
  test("два издания нужно выбрать", () => {
    expect(() => selectIndexes(all, 63)).toThrow("несколько изданий");
    expect(selectIndexes(all, 63, "(1935)")[0].year).toBe(1935);
  });
});

// ---------- заливка на поддельном API ----------

type Req = Record<string, string>;
let server: ReturnType<typeof Bun.serve>;
let edits: Req[] = [];
let script: Record<string, () => object> = {};
let existing = new Set<string>();
let rights = ["bot"];
let maxlagOnce = false;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p: Req = Object.fromEntries(new URLSearchParams(await req.text()));
      const json = (o: object, init?: ResponseInit) => Response.json(o, init);
      if (p.action === "login") return json({ login: { result: "Success" } });
      if (p.action === "edit") {
        edits.push(p);
        if (maxlagOnce) { maxlagOnce = false; return json({ error: { code: "maxlag" } }, { headers: { "Retry-After": "0" } }); }
        const s = script[p.title];
        if (s) return json(s());
        return json({ edit: { result: "Success", newrevid: 100 + edits.length } });
      }
      if (p.meta === "tokens") return json({ query: { tokens: { logintoken: "L", csrftoken: "C" } } });
      if (p.meta === "userinfo") return json({ query: { userinfo: { rights } } });
      if (p.titles) return json({ query: { pages: p.titles.split("|").map((title) => (existing.has(title) ? { title } : { title, missing: true })) } });
      return json({ error: { code: "unexpected" } });
    },
  });
});
afterAll(() => server.stop(true));

let vols: string;
const manifest = ["А", "Б", "В"];
beforeEach(async () => {
  vols = mkdtempSync(join(tmpdir(), "bse-"));
  edits = []; script = {}; existing = new Set(); rights = ["bot"]; maxlagOnce = false;
  for (const t of manifest) await Bun.write(`${vols}/07/wiki/${t}.wiki`, `текст ${t}`);
  await Bun.write(`${vols}/07/manifest.jsonl`, manifest.map((t) => JSON.stringify({ title: t, page: `БСЭ1/${t}`, file: `wiki/${t}.wiki`, summary: "s" })).join("\n") + "\n");
});

async function runWithApi(api: string, testMode: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", resolve(import.meta.dir, "upload.ts"), "--vol", "7", "--pause", "0", ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, WS_TEST_MODE: testMode, WS_API: api, WS_VOLS: vols, WS_RETRY_MS: "1", WS_BOT_USER: "u", WS_BOT_PASS: "p" },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + err };
}
const run = (...args: string[]) => runWithApi(`http://localhost:${server.port}/`, "1", ...args);
const journal = async () => (await Bun.file(`${vols}/07/journal.jsonl`).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("заливка", () => {
  test("без --publish ничего не отправляет и не просит пароль", async () => {
    existing.add("БСЭ1/А");
    const r = await run();
    expect(r.code).toBe(0);
    expect(edits.length).toBe(0);
    expect(r.out).toContain("ничего не опубликовано");
    expect(await Bun.file(`${vols}/07/journal.jsonl`).exists()).toBe(false);
  });
  test("смена адреса API не отключает минимальную паузу", async () => {
    const r = await runWithApi(`http://localhost:${server.port}/`, "", "--publish", "--limit", "1");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Пауза не меньше");
    expect(edits).toHaveLength(0);
  });
  test("тестовый режим не допускает удалённый адрес API", async () => {
    const r = await runWithApi("https://example.invalid/w/api.php", "1");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("WS_TEST_MODE=1 требует локальный WS_API");
  });
  test("манифест не принимает файл за пределами папки разметки", async () => {
    const bad = { title: "А", page: "БСЭ1/А", file: "wiki/../../private.wiki", summary: "s" };
    await Bun.write(`${vols}/07/manifest.jsonl`, JSON.stringify(bad) + "\n");
    const r = await run("--publish", "--limit", "1");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Некорректная строка манифеста");
    expect(edits).toHaveLength(0);
  });
  test("без флага бота лимит 50", async () => {
    const r = await run("--publish", "--limit", "51");
    expect(r.code).not.toBe(0);
    expect(edits.length).toBe(0);
  });
  test("--bot без права бота останавливается до первой правки", async () => {
    rights = [];
    const r = await run("--publish", "--limit", "3", "--bot");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("нет флага бота");
    expect(edits.length).toBe(0);
  });
  test("с флагом бота передаёт bot=1, assert=bot и createonly", async () => {
    await run("--publish", "--limit", "1", "--bot");
    expect(edits[0]).toMatchObject({ bot: "1", assert: "bot", createonly: "1", title: "БСЭ1/А", token: "C" });
  });
  test("без флага бота нет bot=1", async () => {
    await run("--publish", "--limit", "1");
    expect(edits[0].bot).toBeUndefined();
    expect(edits[0].assert).toBe("user");
  });
  test("maxlag повторяется, а не останавливает", async () => {
    maxlagOnce = true;
    const r = await run("--publish", "--limit", "3");
    expect(r.code).toBe(0);
    expect((await journal()).filter((j) => j.result === "created").length).toBe(3);
  });
  test("существующие страницы не трогает", async () => {
    existing.add("БСЭ1/А");
    await run("--publish", "--limit", "3");
    expect(edits.map((e) => e.title)).toEqual(["БСЭ1/Б", "БСЭ1/В"]);
  });
  test("страница, созданная во время заливки, не останавливает работу", async () => {
    script["БСЭ1/Б"] = () => ({ error: { code: "articleexists" } });
    const r = await run("--publish", "--limit", "3");
    expect(r.code).toBe(0);
    expect((await journal()).map((j) => j.result)).toEqual(["created", "exists", "created"]);
  });
  test("капча останавливает, а повторный запуск продолжает с места остановки", async () => {
    script["БСЭ1/Б"] = () => ({ edit: { result: "Failure", captcha: { id: "1" } } });
    const r = await run("--publish", "--limit", "3");
    expect(r.code).toBe(1);
    expect(r.out).toContain("ОСТАНОВКА");
    expect(edits.map((e) => e.title)).toEqual(["БСЭ1/А", "БСЭ1/Б"]);
    script = {}; edits = [];
    const again = await run("--publish", "--limit", "3");
    expect(again.code).toBe(0);
    expect(edits.map((e) => e.title)).toEqual(["БСЭ1/Б", "БСЭ1/В"]);
  });
  test("истёкшая сессия: один повторный вход", async () => {
    let first = true;
    script["БСЭ1/А"] = () => (first ? ((first = false), { error: { code: "badtoken" } }) : { edit: { result: "Success", newrevid: 1 } });
    const r = await run("--publish", "--limit", "1");
    expect(r.code).toBe(0);
    expect(edits.length).toBe(2);
  });
  test("файл с подписью автора не уходит на сайт", async () => {
    await Bun.write(`${vols}/07/wiki/А.wiki`, "текст {{БСЭ1/Автор|И. И.}}");
    const r = await run("--publish", "--limit", "3");
    expect(r.code).toBe(1);
    expect(edits.length).toBe(0);
  });
  test("limit соблюдается", async () => {
    await run("--publish", "--limit", "2");
    expect(edits.length).toBe(2);
  });
});

afterAll(() => { try { rmSync(vols, { recursive: true, force: true }); } catch {} });
