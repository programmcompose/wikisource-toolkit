import { expect, test } from "bun:test";
import { fixCoauthors, fixDash, fixEllipsis, fixLsafe, fixNd, fixPercent, fixStyle, lintStyle } from "./style";

test("{{нд}} остаётся только при неполном слоге", () => {
  expect(fixNd("у нек{{нд}}рых из них")).toBe("у нек-рых из них");
  expect(fixNd("к{{нд}}рый")).toBe("к{{нд}}рый");
  expect(fixNd("76{{нд}}''мм'' пушка")).toBe("76{{нд}}''мм'' пушка");
  expect(fixNd("3{{нд}}линейная")).toBe("3{{нд}}линейная");
  expect(fixNd("о{{нд}}во")).toBe("о{{нд}}во");
});

test("многоточие, проценты, тире", () => {
  expect(fixEllipsis("Triasformation...,")).toBe("Triasformation…,");
  expect(fixEllipsis("....")).toBe("....");
  expect(fixPercent("на 50%-ным и 5 %")).toBe("на 50&thinsp;%-ным и 5&thinsp;%");
  expect(fixDash("Д. — Saurischia")).toBe("Д.&nbsp;— Saurischia");
  expect(fixDash("Д.&nbsp;— Saurischia")).toBe("Д.&nbsp;— Saurischia");
  expect(fixDash("этого, — писал")).toBe("этого,&nbsp;— писал");
  expect(fixDash("связь», —CO—NH—, при")).toBe("связь», —CO—NH—, при");
  expect(fixDash("| — |")).toBe("| — |");
  expect(fixDash("1907—08, М.—Л.")).toBe("1907—08, М.—Л.");
});

test("соавторы", () => {
  expect(fixCoauthors("{{right|{{БСЭ1/Автор|В. Менер и А. Гартман-Вейнберг.}}}}"))
    .toBe("{{right|{{БСЭ1/Автор|В. Менер}} и {{БСЭ1/Автор|А. Гартман-Вейнберг.}}}}");
  expect(fixCoauthors("{{БСЭ1/Автор|Н. Идельсон.}}")).toBe("{{БСЭ1/Автор|Н. Идельсон.}}");
});

test("формулы и шапка не меняются", () => {
  const t = '<noinclude><pagequality level="3" user="SlovarBot" /></noinclude>a 5% <math>x...y 5%</math> b...';
  const r = fixStyle(t);
  expect(r.text).toBe('<noinclude><pagequality level="3" user="SlovarBot" /></noinclude>a 5&thinsp;% <math>x...y 5%</math> b…');
  expect(r.changes).toEqual(["многоточие «…»", "тонкий пробел перед %"]);
});

test("razr2 перед знаком", () => {
  expect(fixStyle("{{razr|валков}}, 1)").text).toBe("{{razr2|валков}}, 1)");
});

test("ссылки по словнику", () => {
  expect(fixLsafe("''{{lsafe|Бисмарк}}''")).toBe("''{{lsafe|Бисмарк, Отто Эдуард Леопольд|Бисмарк}}''");
  expect(fixLsafe("{{lsafe|Дагер|Дагером}}")).toBe("{{lsafe|Дагер, Луи Жак Манде|Дагером}}");
  expect(fixLsafe("{{lsafe|Ассимиляция|ассимиляции}} и {{lsafe|Ассимиляция|ассимиляция}}"))
    .toBe("{{lsafe|Ассимиляция, в биологии|ассимиляции}} и {{lsafe|Ассимиляция, в языкознании|ассимиляция}}");
  expect(fixLsafe("{{lsafe|Оргазм|оргазма}}")).toBe("{{lsafe|Оргазм|оргазма}}");
  expect(fixLsafe("{{lsafe|Интернэшенел Никель Ко оф Канада Лимитед|Интернэшенел Никель {{Ко}} оф Канада Лимитед}}"))
    .toBe("{{lsafe|Интернешенал никел Ко оф Канада лимитед|Интернэшенел Никель {{Ко}} оф Канада Лимитед}}");
  expect(fixLsafe("{{lsafe|Водородные ионы}}")).toBe("{{lsafe|Водородный ион|Водородные ионы}}");
});

test("предупреждения", () => {
  expect(lintStyle("на 2/3 раствором")).toEqual(["дробь «2/3» набрать символом (½, ⅔) или шаблоном"]);
  expect(lintStyle("Sонntag")[0]).toContain("смешаны");
  expect(lintStyle("<math>2/3</math>")).toEqual([]);
});
