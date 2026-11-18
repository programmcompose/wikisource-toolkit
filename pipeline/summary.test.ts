import { expect, test } from "bun:test";
import { isCrossReference, pageLevel, parseAuthorTable, tailLooksSigned, term, verdict, type AuthorRow } from "./summary";

const row = (over: Partial<AuthorRow>): AuthorRow => ({ who: "", as: "", vov: false, titles: [], ...over });

test("таблица авторов: разбирает строки, годы и статьи только из третьего столбца", () => {
  const text = `'''Таблица'''
{| class="wide sortable"
! Автор !! Упомянут как !! Статьи !! Авторские права
|-
| [[w:Аалто|Аалто]] || В. Аалто||* [[БСЭ1/Финский язык|Финский язык]]  (''и Г. Александров'') || {{БСЭ1/АП-мини|ГОД=1937|ГОДРЕАБИЛИТАЦИИ=1955}}
|-
|  || А. Абрамов|| * [[БСЭ1/Чулочное производство|Чулочное]];<br> * [[БСЭ1/Шёлк]] || {{БСЭ1/АП-мини}}
|-
| Б. Б. || см. [[БСЭ1/Чужая статья]] || * [[БСЭ1/Своя]] || {{БСЭ1/АП-мини|ГОД=1950|ВОВ=1}}
|}`;
  const { rows, skipped } = parseAuthorTable(text);
  expect(skipped).toBe(0);
  expect(rows.length).toBe(3);
  expect(rows[0]).toMatchObject({ as: "В. Аалто", year: 1937, rehab: 1955, vov: false, titles: ["Финский язык"] });
  expect(rows[1]).toMatchObject({ as: "А. Абрамов", titles: ["Чулочное производство", "Шёлк"] });
  expect(rows[1].year).toBeUndefined();
  expect(rows[2]).toMatchObject({ year: 1950, vov: true, titles: ["Своя"] });
});

test("срок охраны считается как в шаблоне АП-мини", () => {
  expect(term(row({ year: 1930 }), 2026)).toBe("pd");
  expect(term(row({ year: 1956 }), 2026)).toBe("protected");
  expect(term(row({ year: 1937, rehab: 1956 }), 2026)).toBe("protected");
  expect(term(row({ year: 1937, rehab: 1955 }), 2026)).toBe("pd");
  expect(term(row({ year: 1952, vov: true }), 2026)).toBe("protected");
  expect(term(row({}), 2026)).toBe("unknown");
  expect(term(undefined, 2026)).toBe("unknown");
});

test("сомнительные сроки идут на проверку", () => {
  expect(term(row({ year: 1955 }), 2026)).toBe("check");
  expect(term(row({ year: 1952 }), 2026)).toBe("check");
  expect(term(row({ year: 1951 }), 2026)).toBe("pd");
  expect(term(row({ year: 1938 }), 2026)).toBe("check");
  expect(term(row({ year: 1942 }), 2026)).toBe("pd");
});

test("статья открыта, только если известны все соавторы", () => {
  const pd = row({ year: 1930 }), prot = row({ year: 1990 }), unk = row({}), chk = row({ year: 1938 });
  expect(verdict(1, [pd], 2026)).toBe("pd");
  expect(verdict(2, [pd], 2026)).toBe("partial");
  expect(verdict(2, [pd, pd], 2026)).toBe("pd");
  expect(verdict(2, [pd, prot], 2026)).toBe("protected");
  expect(verdict(2, [prot], 2026)).toBe("protected");
  expect(verdict(2, [pd, unk], 2026)).toBe("unknown");
  expect(verdict(1, [chk], 2026)).toBe("check");
  expect(verdict(1, [], 2026)).toBe("norow");
});

test("предположительный автор идёт на проверку, а не считается открытым", () => {
  expect(term(row({ year: 1930, who: "Возможно [[Иван Иванов]]" }), 2026)).toBe("check");
  expect(term(row({ year: 1930, as: "И. Иванов?" }), 2026)).toBe("check");
  expect(term(row({ year: 1990, who: "Возможно [[Иван Иванов]]" }), 2026)).toBe("protected");
});

test("конец текста, похожий на подпись, и статьи-отсылки", () => {
  expect(tailLooksSigned("Текст статьи. А. Брюсов, Д. Эдинг.")).toBe(true);
  expect(tailLooksSigned("Текст статьи про лес и реку.")).toBe(false);
  expect(isCrossReference("'''ВОДЫ СТОЧНЫЕ,''' см. ''{{lsafe|Сточные воды}}''.")).toBe(true);
  expect(isCrossReference("'''ЛЕС,''' большой массив деревьев.")).toBe(false);
});

test("уровень страницы читается из разметки", () => {
  expect(pageLevel(`<noinclude><pagequality level="3" user="Egor" />`)).toBe("3");
  expect(pageLevel("текст без разметки")).toBe("?");
});
