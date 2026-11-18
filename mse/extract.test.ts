import { test, expect } from "bun:test";
import { cleanTokens, resegment, assignColumns, fixFirstLetters, type PageInfo, type Head } from "./extract.ts";

test("cleanTokens: ударения, «ІѴІ» вместо «М», тире у слова", () => {
  expect(cleanTokens(["ЭБОНИ", "’Т", "(гроч.)"])).toEqual(["ЭБОНИТ", "(гроч.)"]);
  expect(cleanTokens(["ЭВКЛИ’Д—", "см."])).toEqual(["ЭВКЛИД", "—", "см."]);
  expect(cleanTokens(["ЭВДЕІѴ!0НИЗМ"])).toEqual(["ЭВДЕМОНИЗМ"]);
});

test("resegment: обрывки склеиваются, настоящие слова — нет", () => {
  const v = new Map([["командарм", 3], ["кельнский", 5], ["процесс", 500], ["китовый", 4], ["рентген", 4], ["ре", 300], ["ген", 50]]);
  expect(resegment("КОМ АНД АРМ", v)).toBe("КОМАНДАРМ");
  expect(resegment("КЁЛЬНСКИЙ ПРОЦЕСС", v)).toBe("КЁЛЬНСКИЙ ПРОЦЕСС");
  expect(resegment("КИТОВЫЙ УС", v)).toBe("КИТОВЫЙ УС");
  expect(resegment("Р Ё НТ Г Е Н", v)).toBe("РЁНТГЕН");
});

const page = (scan: number, kind: PageInfo["kind"], numL: number | null = null, numR: number | null = null): PageInfo =>
  ({ scan, kind, words: kind === "text" ? 800 : 0, header: "", numL, numR, split: 0, colL: null, colR: null, colSrc: "" });

test("assignColumns: полностраничная карта занимает номера, испорченная цифра отбрасывается", () => {
  const infos = [page(1, "text", 1, 2), page(2, "text", 3, 4), page(3, "blank"), page(4, "text", 7, 8), page(5, "text", 9, 10), page(6, "text", 1, 12), page(7, "text", 13, 14)];
  const gaps = assignColumns(infos);
  expect(gaps).toEqual([]);
  expect(infos.map((i) => i.colL)).toEqual([1, 3, 5, 7, 9, 11, 13]);
});

test("assignColumns: пропуск страницы в скане попадает в отчёт", () => {
  // столбцы 11–12 отсутствуют, нетекстовых страниц рядом нет
  const nums = [1, 3, 5, 7, 9, 13, 15, 17, 19, 21];
  const infos = nums.map((n, k) => page(k, "text", n, n + 1));
  const gaps = assignColumns(infos);
  expect(gaps).toEqual([{ fromScan: 4, toScan: 5, fromCol: 11, toCol: 12, missing: 2 }]);
  expect(infos.map((i) => i.colL)).toEqual(nums);
});

test("fixFirstLetters: «З’БРО» среди «Э…» → «Эбро», но не «Правда» среди «С…»", () => {
  const h = (title: string, scan = 1): Head => ({ title, caps: "", scan, side: "L", col: 1, doubt: [], snippet: "" });
  const heads = [h("Эбонит"), h("Збро"), h("Эбуллиоскопия"), h("Сталь"), h("Правда"), h("Стать")];
  fixFirstLetters(heads);
  expect(heads[1].title).toBe("Эбро");
  expect(heads[4].title).toBe("Правда");
});
