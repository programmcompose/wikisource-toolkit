// bun mse/tools/compare.ts 2-11 — сравнивает черновой словник (vols/KEY/headwords.tsv) с ручным словником на Викитеке (ref/словник-E-VV.wiki)
const key = Bun.argv[2];
const [e, v] = key.split("-");
const manual = [...(await Bun.file(`mse/ref/словник-${e}-${v}.wiki`).text()).matchAll(/\{\{Статья в словнике\|([^|}]*)\|[^|}]*\|([^|}]*)/g)].map((m) => ({ t: m[1].trim(), col: m[2].trim() }));
const rows = (await Bun.file(`mse/vols/${key}/headwords.tsv`).text()).trim().split("\n").slice(1).map((l) => l.split("\t")).map((r) => ({ t: r[0], col: r[1] }));
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z0-9]/g, "");
const first = (s: string) => norm(s.split(",")[0]);
const byFull = new Map(rows.map((r) => [norm(r.t), r]));
const byFirst = new Map<string, typeof rows>();
for (const r of rows) { const k = first(r.t); byFirst.set(k, [...(byFirst.get(k) ?? []), r]); }
let full = 0, head = 0, miss: string[] = [], colOk = 0, colBad: string[] = [];
for (const m of manual) {
  let r = byFull.get(norm(m.t));
  if (r) full++;
  else { const c = byFirst.get(first(m.t)); if (c) { head++; r = c.find((x) => x.col === m.col.split("—")[0]) ?? c[0]; } }
  if (!r) { miss.push(`${m.t} (${m.col})`); continue; }
  if (m.col.split(/[—-]/)[0] === r.col) colOk++; else colBad.push(`${m.t}: словник ${m.col}, черновик ${r.col}`);
}
const lo = Math.min(...manual.map((m) => +m.col.split(/[—-]/)[0]).filter(Boolean));
const hi = Math.max(...manual.map((m) => +m.col.split(/[—-]/)[0]).filter(Boolean));
const inRange = rows.filter((r) => +r.col >= lo && +r.col <= hi);
const manualKeys = new Set(manual.map((m) => first(m.t)));
const extra = inRange.filter((r) => !manualKeys.has(first(r.t)));
console.log(`ручной словник: ${manual.length}; найдено полностью ${full}, по первому слову ${head}, не найдено ${miss.length}`);
console.log(`столбец совпал ${colOk}, расходится ${colBad.length}`);
console.log(`в черновике в том же диапазоне столбцов (${lo}–${hi}): ${inRange.length}, нет в ручном словнике: ${extra.length}`);
console.log("\nне найдены:", miss.slice(0, 40).join("; "));
console.log("\nстолбцы:", colBad.slice(0, 20).join("; "));
console.log("\nлишние:", extra.slice(0, 40).map((r) => `${r.t} (${r.col})`).join("; "));

// нечёткое сопоставление: пропущенная статья и «лишняя» в том же или соседнем столбце, расстояние правки ≤ 30% длины
function lev(a: string, b: string) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
const missObjs = manual.filter((m) => !byFull.get(norm(m.t)) && !byFirst.get(first(m.t)));
let fuzzy = 0;
const used = new Set<string>();
for (const m of missObjs) {
  const c = +m.col.split(/[—-]/)[0];
  const k = first(m.t);
  const hit = extra.find((r) => !used.has(r.t + r.col) && Math.abs(+r.col - c) <= 1 && lev(first(r.t), k) <= Math.max(1, Math.round(k.length * 0.3)));
  if (hit) { fuzzy++; used.add(hit.t + hit.col); }
}
console.log(`\nс опечатками OCR (нечётко): ещё ${fuzzy}; итого найдено ${full + head + fuzzy} из ${manual.length} (${Math.round((100 * (full + head + fuzzy)) / manual.length)}%); остались лишними ${extra.length - fuzzy}`);
