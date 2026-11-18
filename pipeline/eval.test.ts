import { expect, test } from "bun:test";
import { alignTokens, bootstrap, eligiblePage, normalize, pickOrder, rng, scorePage, tokenize } from "./eval";

const wrap = (body: string, level = 3, user = "Egor") => `<noinclude><pagequality level="${level}" user="${user}" /></noinclude>${body}<noinclude></noinclude>`;
const long = "слово ".repeat(400);

test("normalize убирает разметку и оформление, но не текст", () => {
  const raw = wrap(`<section begin="а" />'''АРБА,''' {{razr|повозка}} — [[БСЭ1/Воз|воз]]<section end="а" />{{tq|3}}`);
  expect(normalize(raw)).toBe("АРБА, повозка — воз");
});

test("normalize разворачивает шаблоны проекта так, как их видит читатель", () => {
  expect(normalize("к{{нд}}рый")).toBe("к-рый");
  expect(normalize("{{перенос|народ|ности}}")).toBe("народ-");
  expect(normalize("{{перенос2|диа|лект}}")).toBe("лект");
  expect(normalize("{{sfrac|1|4}} часа и ¼ часа")).toBe("1/4 часа и 1/4 часа");
  expect(normalize("{{lsafe|БСЭ1/Вино}} {{Lsafe|Попов|Поповым}}")).toBe("Вино Поповым");
  expect(normalize("паями{{Примечание ВТ|Такой статьи нет.}} (см.)")).toBe("паями (см.)");
  expect(normalize("{{Rfloat|Файл.jpg|title=Рис. 1. Мечеклюв|size=170}}")).toBe("Рис. 1. Мечеклюв");
  expect(normalize("{{poemx1||small=1|\nтуча\nбури\n|(Пушкин).}}")).toBe("туча бури (Пушкин).");
  expect(normalize("{{right|{{БСЭ1/Автор|А. Д./историк}}}}")).toBe("А. Д.");
  expect(normalize("{{der Lasa T. v.}}, Zur")).toBe("der Lasa T. v., Zur");
  expect(normalize("q<sub>1</sub> 5&thinsp;%")).toBe("q1 5 %");
});

test("латинские и кириллические двойники не считаются ошибкой, а похожая цифра считается", () => {
  expect(scorePage("вектор р XII", "вектор р XII", "вектор p ХІІ").modelWrong).toBe(0);
  expect(scorePage("на 3.", "на 3.", "на З.").modelWrong).toBe(1);
});

test("слово на другом месте не считается потерей и вставкой", () => {
  const gold = "начало подпись рисунка длинная середина и конец текста";
  const r = scorePage(gold, gold, "начало середина и конец текста подпись рисунка длинная");
  expect(r).toMatchObject({ moved: 3, modelWrong: 0, invented: 0, longDeleted: 0, longInserted: 0 });
});

test("normalize склеивает перенос в конце строки и приводит тире и кавычки", () => {
  expect(normalize("про-\nцесс «а» – б")).toBe('процесс "а" — б');
  expect(normalize("Северо-\nЗападный")).toBe("Северо- Западный");
});

test("tokenize держит вместе числа и дефисы", () => {
  expect(tokenize("В 1917—18 гг., 3,5 км; Северо-Запад.")).toEqual(["В", "1917", "—", "18", "гг", ".", ",", "3,5", "км", ";", "Северо-Запад", "."]);
});

test("alignTokens находит замену, потерю и вставку", () => {
  const a = alignTokens(["а", "б", "в", "г"], ["а", "х", "в", "у", "г"]);
  expect(a.goldTo).toEqual([0, 1, 2, 4]);
  expect(a.inserted).toEqual([3]);
  expect(alignTokens(["а", "б"], ["а"]).goldTo).toEqual([0, -1]);
});

test("scorePage разделяет исправленное, пропущенное и испорченное", () => {
  const r = scorePage("один два три четыре пять", "один дба три четыре пягь", "один два три четыре пягь");
  expect(r).toMatchObject({ goldWords: 5, ocrWrong: 2, modelWrong: 1, fixed: 1, missed: 1, damaged: 0, invented: 0 });
  const d = scorePage("один два три", "один два три", "один две три");
  expect(d).toMatchObject({ damaged: 1, fixed: 0, ocrWrong: 0, modelWrong: 1 });
});

test("scorePage отдельно считает выдуманные слова и слова из OCR", () => {
  const r = scorePage("а б в", "а б в шум", "а б в шум новое");
  expect(r.inheritedExtra).toBe(1);
  expect(r.invented).toBe(1);
});

test("scorePage видит крупную потерю, крупную вставку и ошибки в числах", () => {
  const gold = "альфа бета гамма дельта эпсилон дзета 1917";
  const r = scorePage(gold, gold, "альфа дзета 1911 шесть семь восемь девять");
  expect(r.longDeleted).toBe(4);
  expect(r.longInserted).toBe(4);
  expect(r.damagedNumbers).toBe(1);
  expect(r.modelNumbersWrong).toBe(1);
});

test("ё и е не считаются ошибкой, а регистр считается", () => {
  expect(scorePage("её", "ее", "её").ocrWrong).toBe(0);
  expect(scorePage("Москва", "москва", "Москва").fixed).toBe(1);
});

test("eligiblePage берёт только чужие вычитанные текстовые страницы", () => {
  const page = (content: string) => ({ file: "f.pdf", n: 1, content });
  expect(eligiblePage("01", page(wrap(long)))).toMatchObject({ user: "Egor", level: 3 });
  expect(eligiblePage("01", page(wrap(long, 1)))).toBeNull();
  expect(eligiblePage("01", page(wrap("мало слов")))).toBeNull();
  expect(eligiblePage("01", page(wrap(long, 3, "IYwiki")))).toBeNull();
  expect(eligiblePage("01", page(wrap(long + "{| таблица |}")))).toBeNull();
});

test("pickOrder повторяется при том же зерне и сначала обходит все тома", () => {
  const pages = [...Array(10).keys()].map((n) => ({ vol: "33", file: "f", n, user: "u", level: 3 })).concat({ vol: "01", file: "g", n: 1, user: "u", level: 3 });
  const a = pickOrder(pages, rng(7));
  expect(a).toEqual(pickOrder(pages, rng(7)));
  expect(new Set(a.slice(0, 2).map((p) => p.vol)).size).toBe(2);
  expect(a.length).toBe(pages.length);
});

test("bootstrap даёт интервал вокруг доли", () => {
  const score = (w: number) => scorePage("а ".repeat(10), "а ".repeat(10), "а ".repeat(10 - w) + "б ".repeat(w));
  const pages = [0, 1, 2, 3].map(score);
  const rate = (p: typeof pages) => p.reduce((s, x) => s + x.modelWrong, 0) / p.reduce((s, x) => s + x.goldWords, 0);
  const [lo, hi] = bootstrap(pages, rate);
  expect(lo).toBeLessThanOrEqual(0.15);
  expect(hi).toBeGreaterThanOrEqual(0.15);
});
