import { describe, expect, test } from "bun:test";
import { sectionTags, visibleText, wordDiff, words } from "./pilot";

describe("стенд сверки", () => {
  test("видимый текст без разметки", () => {
    const wiki = `<noinclude><pagequality level="1" user="X" /></noinclude><section begin="а"/>'''АЛЬФА,''' к{{нд}}рый ''{{lsafe|Бета|беты}}'' {{razr|слово}}&nbsp;— {{перенос|уче|ние}}<section end="а"/><noinclude></noinclude>`;
    expect(words(visibleText(wiki))).toEqual(["альфа", "к-рый", "беты", "слово", "учение"]);
  });
  test("заглушка и таблица дают только текст", () => {
    const table = `{| class="dtable"\n|-\n! colspan="3" | Медь !! Цинк\n|- class=first\n| {{Dotted cell|США|n=1}} || 905 || 1,0\n|}`;
    expect(words(visibleText(`{{img|Рис. 8.}}\n${table}`))).toEqual(["рис", "8", "медь", "цинк", "сша", "905", "1,0"]);
  });
  test("перестановка столбцов не считается отличием, замена слова считается", () => {
    expect(wordDiff("один два три", "три один два")).toEqual({ added: [], removed: [], share: 1 });
    const d = wordDiff("казанский поэт", "казакский поэт");
    expect(d.added).toEqual(["казакский"]);
    expect(d.removed).toEqual(["казанский"]);
  });
  test("секции, идущие через границу страницы", () => {
    expect(sectionTags(`<section end="старая"/><section begin="а"/><section end="а"/><section begin="новая"/>`)).toEqual({ opened: ["новая"], closed: ["старая"] });
  });
});
