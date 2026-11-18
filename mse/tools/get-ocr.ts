// bun mse/tools/get-ocr.ts — скачивает текстовый слой (djvu.txt) всех томов МСЭ1 и МСЭ2 с archive.org в mse/ocr/
const UA = "BSE1-pipeline/0.2 (https://ru.wikisource.org/wiki/User:SlovarBot)";
const jobs: [string, string, string][] = [];
for (let v = 1; v <= 10; v++) {
  const id = v === 1 ? "mre-1" : `mre_${v}`;
  jobs.push([`1-${String(v).padStart(2, "0")}`, id, `mre_${v}_djvu.txt`]);
}
const meta: any = await (await fetch("https://archive.org/metadata/2-.-11-1947", { headers: { "User-Agent": UA } })).json();
for (const f of meta.files) {
  const m = f.name.match(/Том (\d\d) .*_djvu\.txt$/);
  if (m) jobs.push([`2-${m[1]}`, "2-.-11-1947", f.name]);
}
for (const [key, id, name] of jobs) {
  const out = `mse/ocr/${key}.txt`;
  if (await Bun.file(out).exists()) { console.log("есть", out); continue; }
  const url = `https://archive.org/download/${id}/${name.split("/").map(encodeURIComponent).join("/")}`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) { console.log("ошибка", r.status, key, url); continue; }
  await Bun.write(out, await r.arrayBuffer());
  console.log("ok", out, (await Bun.file(out).size) >> 20, "MB");
  await Bun.sleep(1000);
}
