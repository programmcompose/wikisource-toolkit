// Черновая разметка томов ССЭ по текстовому слою PDF. На сайте ничего не меняет.
// bun sse/extract.ts            — все тома
// Вход: sse/text/tN.layout.txt (pdftotext -layout -enc UTF-8). Выход: sse/vols/N/{pages.tsv,headwords.tsv,report.md}, sse/drafts/словник-N.wiki
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const VOLS: Record<number, { range: string; year: string; maxCol: number }> = {
  1: { range: "А — Ж", year: "1929", maxCol: 988 },
  2: { range: "З — К", year: "1931", maxCol: 1152 },
  3: { range: "Л — Н", year: "1932", maxCol: 804 },
  4: { range: "О — С", year: "1992", maxCol: 1082 },
};

// Латинские двойники заглавных букв, которые OCR ставит вместо кириллицы.
const LOOK: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У", "3": "З" };
export function normHead(s: string): string {
  let t = s.replace(/JI/g, "Л").replace(/bI|Ь1|ЬI/g, "Ы").replace(/[ABCEHKMOPTXY]/g, (c) => LOOK[c] ?? c);
  t = t.replace(/\s+/g, " ").replace(/\s*-\s*/g, "-").trim();
  return t;
}
const UP = "A-ZА-ЯЁ";

type Page = { pdf: number; kind: "text" | "plate" | "blank"; lines: number; header: string; hdrCols: number[]; cols: [number, number] | null; colSrc: "header" | "interp" | "" };
type Head = { word: string; raw: string; pdf: number; col: number | null; side: "L" | "R"; ref: string; doubt: boolean; snippet: string };

// OCR разрывает слова пробелами: «ТЮ РЬМ А», «М ЕСТОРОЖ ДЕНИЕ». Обрывки до 2 букв приклеиваем к соседу.
export function joinSplit(w: string): string {
  const t = w.split(" ");
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const cur = t[i];
    if (cur.length <= 2 && i + 1 < t.length && /^[А-ЯЁ]+$/.test(cur) && !/^(И|В|НА|ПО|ДО|ОТ|ЗА|ИЗ)$/.test(cur)) { t[i + 1] = cur + t[i + 1]; continue; }
    if (cur.length <= 1 && out.length && i === t.length - 1) { out[out.length - 1] += cur; continue; }
    if (/^([ЬЪЫ]|Й$)/.test(cur) && out.length) { out[out.length - 1] += cur; continue; }
    out.push(cur);
  }
  return out.join(" ");
}

// Позиция начала правого столбца: самая частая позиция, где после ≥3 пробелов начинается текст.
function rightStart(lines: string[]): number {
  const cnt = new Map<number, number>();
  for (const l of lines) {
    const re = /\s{3,}(\S)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l))) {
      const p = m.index + m[0].length - 1;
      if (p >= 30 && p <= 110) cnt.set(p, (cnt.get(p) ?? 0) + 1);
    }
  }
  // сглаживаем по соседним позициям ±2
  let best = 0, bestScore = 0;
  for (const p of cnt.keys()) {
    let s = 0;
    for (let d = -2; d <= 2; d++) s += cnt.get(p + d) ?? 0;
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return bestScore >= 8 ? best - 2 : 0;
}

export function splitColumns(lines: string[]): { L: string[]; R: string[] } {
  const rs = rightStart(lines);
  if (!rs) return { L: lines, R: [] };
  const L: string[] = [], R: string[] = [];
  for (const l of lines) {
    if (l.length <= rs) { L.push(l); continue; }
    // ищем границу: пробелы около rs
    let cut = rs;
    while (cut > 0 && l[cut - 1] !== " " && cut > rs - 6) cut--;
    L.push(l.slice(0, cut).trimEnd());
    R.push(l.slice(cut));
  }
  return { L, R };
}

const HEAD_RE = new RegExp(`^\\s{2,}[«"„]?((?:[${UP}][${UP}’'\\-]{2,}|JI[${UP}]{1,})(?:[ \\-](?:[${UP}][${UP}’'\\-]*|JI[${UP}]*))*)»?\\s*(?=[,(—–\\-]|\\s+[а-яёa-z(])(.*)$`);

function headsIn(col: string[], pdf: number, side: "L" | "R", c: number | null): Head[] {
  const out: Head[] = [];
  col.forEach((line, i) => {
    const m = HEAD_RE.exec(line.replace(/\r/g, ""));
    if (!m) return;
    const raw = m[1];
    const word = joinSplit(normHead(raw));
    const doubt = /(^| )[А-ЯЁ]{1,3}( |$)/.test(normHead(raw)) || /[^А-ЯЁ \-’']/.test(word);
    if (word.replace(/[^А-ЯЁ]/g, "").length < 3) return;
    if (/^(СССР|РСФСР|ВКП|ЦК|ВЦИК|СНК|ВСНХ|ОГПУ|НКВД)$/.test(word)) return;
    const rest = (m[2] + " " + (col[i + 1] ?? "")).replace(/\s+/g, " ").trim();
    const ref = /^[,\s]*[—–-]\s*см\.\s*([^.;]+)/.exec(rest)?.[1]?.trim() ?? "";
    out.push({ word, raw, pdf, col: c, side, ref, doubt, snippet: rest.slice(0, 90) });
  });
  return out;
}

function analyse(vol: number) {
  const txt = readFileSync(join(ROOT, "text", `t${vol}.layout.txt`), "utf8");
  const pagesTxt = txt.split("\f");
  if (pagesTxt.at(-1)!.trim() === "") pagesTxt.pop();
  const pages: Page[] = [];
  const heads: Head[] = [];
  const pageCols: { L: string[]; R: string[] }[] = [];
  pagesTxt.forEach((p, i) => {
    const lines = p.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim());
    const n = lines.length;
    const kind: Page["kind"] = n === 0 ? "blank" : n < 60 ? "plate" : "text";
    let header = "", hdrCols: number[] = [];
    if (kind === "text") {
      const first = lines[0];
      const letters = first.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
      const upper = first.replace(/[^A-ZА-ЯЁ]/g, "");
      const nums = [...first.matchAll(/(?:^|\s)(\d{1,4})(?=\s|$)/g)].map((m) => +m[1]).filter((x) => x >= 1 && x <= VOLS[vol].maxCol + 30);
      if ((letters.length >= 4 && upper.length / letters.length > 0.7) || (nums.length && letters.length < 3)) {
        header = first.trim().replace(/\s+/g, " ");
        hdrCols = nums;
        lines.shift();
      }
    }
    pages.push({ pdf: i + 1, kind, lines: n, header, hdrCols, cols: null, colSrc: "" });
    pageCols.push(kind === "text" ? splitColumns(lines) : { L: [], R: [] });
  });

  // Столбцы по колонтитулу: страница = пара (2k-1, 2k).
  for (const pg of pages) {
    if (!pg.hdrCols.length) continue;
    const n = pg.hdrCols[pg.hdrCols.length - 1];
    if (n < 5) continue; // буква раздела «З» читается как «3»
    const pair: [number, number] = n % 2 === 0 ? [n - 1, n] : [n, n + 1];
    pg.cols = pair; pg.colSrc = "header";
  }
  // Заголовки статей (столбцы проставим позже).
  pages.forEach((pg, i) => {
    const { L, R } = pageCols[i];
    heads.push(...headsIn(L, pg.pdf, "L", null), ...headsIn(R, pg.pdf, "R", null));
  });
  // Опоры из «Перечня крупных статей»: «Авиация—В. Г. Болдырев 8».
  const listAnchors: string[] = [];
  const startIdx = pagesTxt.findIndex((t) => /ПЕРЕЧЕНЬ\s+КРУПНЫХ\s+СТАТЕЙ/.test(t));
  if (startIdx >= 0) {
    let listTxt = "";
    for (let i = startIdx; i < startIdx + 3 && i < pagesTxt.length; i++) {
      if (i > startIdx && /СПИСОК\s+ИЛЛЮСТРАЦИЙ|СПИСОК\s+УСЛОВНЫХ/.test(pagesTxt[i].slice(0, 400))) break;
      listTxt += " " + pagesTxt[i];
    }
    listTxt = listTxt.replace(/(?<=[а-яё])­?\s*\n\s*(?=[а-яё])/g, "").replace(/\s+/g, " ");
    const re = /([А-ЯЁ][а-яё\-]+(?:[ \-]+[а-яёА-ЯЁ\-()]+){0,5}?)\s*[—–-]\s*[^—–\d]{1,60}?\s(\d{1,4})(?=\D)/g;
    const key = (s: string) => s.toUpperCase().replace(/[^А-ЯЁ]/g, "");
    let m: RegExpExecArray | null;
    while ((m = re.exec(listTxt))) {
      const col = +m[2], k = key(m[1]);
      if (k.length < 4 || col < 1 || col > VOLS[vol].maxCol) continue;
      const cand = heads.filter((h) => key(h.word) === k);
      if (cand.length !== 1) continue;
      const h = cand[0], pg = pages[h.pdf - 1];
      if (pg.colSrc === "header") continue;
      const left = h.side === "L" ? col : col - 1;
      if (left % 2 === 0) continue; // левый столбец страницы всегда нечётный
      pg.cols = [left, left + 1]; pg.colSrc = "header"; pg.header = `перечень: ${m[1]} — ${col}`;
      listAnchors.push(`${m[1]} ${col} → PDF ${h.pdf}`);
    }
  }
  // Отбрасываем опоры, которые не согласуются с соседями (ошибки OCR).
  // Опора годится, если от предыдущей годной опоры столбцы растут не быстрее 2 на страницу PDF.
  // Берём самую длинную согласованную цепочку опор.
  const cand = pages.filter((p) => p.colSrc === "header");
  const okPair = (a: Page, b: Page) => { const s = (b.cols![0] - a.cols![0]) / (b.pdf - a.pdf); return s >= 1 && s <= 6; };
  const best = cand.map(() => 1), from = cand.map(() => -1);
  for (let i = 0; i < cand.length; i++)
    for (let j = 0; j < i; j++)
      if (okPair(cand[j], cand[i]) && best[j] + 1 > best[i]) { best[i] = best[j] + 1; from[i] = j; }
  const anchors: Page[] = [];
  for (let i = best.length ? best.indexOf(Math.max(...best)) : -1; i >= 0; i = from[i]) anchors.unshift(cand[i]);
  const rejected = cand.filter((p) => !anchors.includes(p));
  for (const p of rejected) { p.cols = null; p.colSrc = ""; }
  // Между опорами — линейно по номеру страницы PDF (вклейки и страницы без текста дают погрешность).
  for (const pg of pages) {
    if (pg.kind !== "text" || pg.colSrc === "header") continue;
    const a = [...anchors].reverse().find((x) => x.pdf < pg.pdf);
    const b = anchors.find((x) => x.pdf > pg.pdf);
    let c: number;
    if (a && b) c = a.cols![0] + ((b.cols![0] - a.cols![0]) * (pg.pdf - a.pdf)) / (b.pdf - a.pdf);
    else if (a) c = a.cols![0] + 2 * pages.slice(a.pdf, pg.pdf).filter((p) => p.kind !== "plate").length;
    else continue;
    c = Math.round(c);
    if (c % 2 === 0) c -= 1;
    pg.cols = [c, c + 1]; pg.colSrc = "interp";
  }
  // До первого колонтитула — назад.
  const firstKnown = anchors[0];
  if (firstKnown) {
    let c = firstKnown.cols![0];
    for (let i = firstKnown.pdf - 2; i >= 0; i--) {
      const pg = pages[i];
      if (pg.kind !== "text") continue;
      c -= 2;
      if (c < 1) break;
      pg.cols = [c, c + 1]; pg.colSrc = "interp";
    }
  }
  // Расхождения интерполяции с колонтитулами.
  const conflicts: string[] = [];
  let prev: Page | null = null;
  for (const pg of pages) {
    if (pg.kind !== "text" || !pg.cols) continue;
    if (prev && prev.cols && pg.cols[0] !== prev.cols[0] + 2) conflicts.push(`PDF ${prev.pdf}→${pg.pdf}: столбцы ${prev.cols.join("—")} → ${pg.cols.join("—")}`);
    prev = pg;
  }

  for (const h of heads) {
    const c = pages[h.pdf - 1].cols;
    h.col = c ? (h.side === "L" ? c[0] : c[1]) : null;
  }

  // Выход
  const dir = join(ROOT, "vols", String(vol));
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(ROOT, "drafts"), { recursive: true });
  writeFileSync(join(dir, "pages.tsv"), "pdf\tвид\tстрок\tстолбцы\tисточник\tколонтитул\n" + pages.map((p) => [p.pdf, p.kind, p.lines, p.cols?.join("—") ?? "", p.colSrc, p.header].join("\t")).join("\n") + "\n");
  writeFileSync(join(dir, "headwords.tsv"), "заголовок\tстолбец≈\tpdf\tсторона\tсм.\tсомнение\tOCR\tначало\n" + heads.map((h) => [h.word, h.col ?? "", h.pdf, h.side, h.ref, h.doubt ? "да" : "", h.raw, h.snippet].join("\t")).join("\n") + "\n");

  const count = (k: Page["kind"]) => pages.filter((p) => p.kind === k).length;
  const cap = (w: string) => w.toLowerCase().replace(/(^|[\s\-])([а-яёa-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/(?<=\s)([А-ЯЁ])(?=[а-яё]{2,})/g, (x) => x);
  const title = (w: string) => { const s = w.toLowerCase(); return s[0].toUpperCase() + s.slice(1); };
  void cap;
  const v = VOLS[vol];
  const slov = [
    `{{Отексте`,
    `|НАЗВАНИЕ = ${v.range}`,
    `|СОДЕРЖАНИЕ = [[../|Словник]] № {{SUBPAGENAME}}`,
    `|ПРЕДЫДУЩИЙ = ${vol > 1 ? `[[Викитека:Проект:ССЭ/Словник/${vol - 1}|${VOLS[vol - 1].range}]]` : ""}`,
    `|СЛЕДУЮЩИЙ = ${vol < 4 ? `[[Викитека:Проект:ССЭ/Словник/${vol + 1}|${VOLS[vol + 1].range}]]` : ""}`,
    `|ДРУГОЕ = '''Сибирская советская энциклопедия''', т. ${vol}: ${v.range}. — ${v.year}.`,
    `|НЕТ_АВТОРА =`,
    `}}`,
    ``,
    `<!-- ЧЕРНОВИК: собран автоматически из текстового слоя PDF, ${new Date().toISOString().slice(0, 10)}. Заголовки и столбцы не сверены со сканом.`,
    `     Столбцы приблизительные (точны только у страниц с колонтитулом). В комментарии: страница PDF; «?» — заголовок, искажённый OCR.`,
    `     Страницы без текстового слоя (${count("blank")}) не разобраны: их статей здесь нет. -->`,
    `<div class=wordlist1>`,
    ...heads.map((h) => `* {{Статья в словнике2|${title(h.word)}||${h.col ?? "?"}}} <!-- pdf ${h.pdf}${h.doubt ? " ?" : ""}${h.ref ? `; см. ${h.ref}` : ""} -->`),
    `</div>`,
    ``,
  ].join("\n");
  writeFileSync(join(ROOT, "drafts", `словник-${vol}.wiki`), slov);

  const hdr = pages.filter((p) => p.colSrc === "header").length;
  const textN = count("text");
  const lastCols = [...pages].reverse().find((p) => p.cols)?.cols;
  const report = [
    `# Том ${vol} (${v.range}, ${v.year}) — черновой разбор PDF`,
    ``,
    `Страниц PDF: ${pages.length}; текстовых ${textN}, вклеек/мало текста ${count("plate")}, пустых ${count("blank")}.`,
    `Столбцы по колонтитулу: ${hdr} стр.; восстановлены интерполяцией: ${pages.filter((p) => p.colSrc === "interp").length}. Последний столбец по разбору: ${lastCols?.[1] ?? "?"} (по выходным данным ${v.maxCol}).`,
    `Найдено заголовков статей: ${heads.length}; из них отсылок «см.»: ${heads.filter((h) => h.ref).length}; без номера столбца: ${heads.filter((h) => h.col === null).length}.`,
    ``,
    `Заголовков с сомнением (OCR разорвал или исказил): ${heads.filter((h) => h.doubt).length}.`,
    ``,
    `## Страницы без текстового слоя (${count("blank")})`,
    `Их нужно распознать заново (OCR или разметка ИИ по скану). Первые и последние страницы тома обычно обложка и форзацы.`,
    ``,
    pages.filter((p) => p.kind === "blank").map((p) => p.pdf).join(", "),
    ``,
    `## Опорные точки (${anchors.length}; отброшено как несогласованные: ${rejected.length})`,
    `Колонтитулы страниц и статьи из «Перечня крупных статей» (найдено в перечне: ${listAnchors.length}).`,
    ``,
    ...anchors.map((a) => `- PDF ${a.pdf}: ${a.cols!.join("—")} («${a.header}»)`),
    ``,
    `Отброшены: ${rejected.map((a) => `PDF ${a.pdf} («${a.header}»)`).join("; ") || "нет"}`,
    ``,
    `## Участки между опорами`,
    `Норма — 2 столбца на страницу PDF. Меньше 2 — в участке вклейки или лишние страницы; больше 2 — в PDF, вероятно, не хватает страниц.`,
    ``,
    `| PDF | столбцы | страниц PDF | страниц книги | разница |`,
    `|---|---|---|---|---|`,
    ...anchors.slice(1).map((b, k) => {
      const a = anchors[k], dp = b.pdf - a.pdf, db = (b.cols![0] - a.cols![0]) / 2;
      const d = dp - db;
      return `| ${a.pdf}–${b.pdf} | ${a.cols![0]}–${b.cols![0]} | ${dp} | ${db} | ${d === 0 ? "0" : d > 0 ? `+${d} (вклейки?)` : `**${d} (не хватает?)**`} |`;
    }),
    ``,
    `## Черновик \`map\` для модуля (столбец → страница PDF)`,
    `Пары берутся у опор, где меняется сдвиг. Между опорами сдвиг может меняться на вклейках: сверить по сканам.`,
    ``,
    "```lua",
    `map = {`,
    ...(() => {
      const out: string[] = [];
      let prevOff: number | null = null;
      for (const a of anchors) {
        const off = a.pdf - (a.cols![0] + 1) / 2;
        if (off !== prevOff) out.push(`\t{ ${String(a.cols![0]).padStart(4)}, ${String(a.pdf).padStart(3)} },`);
        prevOff = off;
      }
      return out;
    })(),
    `},`,
    "```",
    ``,
    `## Скачки нумерации (${conflicts.length})`,
    `Здесь интерполяция расходится с колонтитулами: вероятно, вклейка распознана как текст, пропущена страница или колонтитул прочитан неверно.`,
    ``,
    ...conflicts.slice(0, 80).map((c) => `- ${c}`),
    conflicts.length > 80 ? `- … ещё ${conflicts.length - 80}` : ``,
    ``,
  ].join("\n");
  writeFileSync(join(dir, "report.md"), report);
  console.log(`Том ${vol}: стр. ${pages.length} (текст ${textN}), колонтитулов ${hdr}, заголовков ${heads.length}, скачков ${conflicts.length}, последний столбец ${lastCols?.[1]}/${v.maxCol}`);
}

if (import.meta.main) {
  const only = process.argv.includes("--vol") ? [+process.argv[process.argv.indexOf("--vol") + 1]] : [1, 2, 3, 4];
  for (const v of only) analyse(v);
}
