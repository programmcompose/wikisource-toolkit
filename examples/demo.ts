import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { classify } from "../pipeline/prepare";
import { BSE1 } from "../pipeline/profile";
import type { Entry } from "../pipeline/parse";

const edition = "Учебный индекс.pdf";
const output = join(import.meta.dir, "..", ".demo");
const volumes = join(output, "vols");
const volume = join(volumes, "07");
const review = join(output, "review");
const evaluation = join(output, "eval");
const headwords = ["Река", "Озеро", "Мост"];
const river = "РЕКА, поток воды в естественном русле. От истока вода течёт к устью. После дождя уровень воды растёт.";
const lake = "ОЗЕРО, водоём в естественном углублении.";
const bridge = "МОСТ, сооружение для перехода через реку.";
const wiki = (body: string) =>
  `<noinclude><pagequality level="3" user="Пример" /><div class="text"></noinclude>${body}<noinclude></div></noinclude>`;
const bodies = [
  `<section begin="река"/>'''РЕКА,''' поток воды в естественном русле. От истока вода течёт к устью.`,
  `После дождя уровень воды растёт.<section end="река"/>\n<section begin="озеро"/>${lake.replace("ОЗЕРО,", "'''ОЗЕРО,'''")}<section end="озеро42"/>`,
  `<section begin="мост"/>'''МОСТ,''' сооружение для перехода через реку.<section end="мост"/>`,
];
const preview = [
  "РЕКА, поток воды в естественном русле. От истока вода течёт к устью.",
  `После дождя уровень воды растёт. ${lake}`,
  bridge,
];
const pages = bodies.map((body, i) => ({ n: i + 1, file: edition, content: wiki(body) }));
const entries: Entry[] = headwords.map((title, i) => ({
  seq: i + 1, title, head: title, authors: [], linked: true,
  cols: String(2 * i + 1), colStart: 2 * i + 1, colEnd: 2 * i + 1,
}));
const existing = new Set([`${BSE1.articlePrefix}Мост`]);
const articles = classify(7, 1930, entries, new Map(headwords.map((title) => {
  const page = `${BSE1.articlePrefix}${title}`;
  return [page, existing.has(page)];
})), pages);

for (const dir of [volume, join(review, "ocr"), join(review, "model"), join(review, "scans"), ...["gold", "ocr", "model"].map((name) => join(evaluation, name))]) {
  await mkdir(dir, { recursive: true });
}
await Bun.write(join(volume, "pages.json"), JSON.stringify(pages));
await Bun.write(join(volume, "articles.jsonl"), articles.map((a) => JSON.stringify(a)).join("\n") + "\n");
await Bun.write(join(review, "notes.json"), JSON.stringify({
  1: { why: "Статья продолжается на следующей странице.", notes: ["⚠ Проверить: в OCR слово «к» было распознано как «в»."] },
  2: { why: "Две статьи на одной странице.", notes: ["⚠ Проверить: имя конца секции содержит номер столбца 42."] },
  3: { why: "Статья уже есть в учебной вики.", notes: [] },
}));
for (const page of pages) {
  await Bun.write(join(review, "model", `${page.n}.wiki`), page.content);
  await Bun.write(join(review, "ocr", `${page.n}.wiki`), page.content.replace("течёт к устью", "течёт в устью"));
  await Bun.write(join(review, "scans", `${page.n}.jpg`), Bun.file(join(import.meta.dir, "scans", `${page.n}.jpg`)));
}
const sample = { id: "demo", vol: "07", file: edition, n: 1, user: "Учебный эталон", level: 3, goldRev: 2, ocrRev: 1, ocrUser: "Учебный OCR" };
await Bun.write(join(evaluation, "sample.jsonl"), JSON.stringify(sample) + "\n");
await Bun.write(join(evaluation, "gold", "demo.txt"), preview[0]);
await Bun.write(join(evaluation, "ocr", "demo.txt"), preview[0].replace("течёт к устью", "течёт в устью"));
await Bun.write(join(evaluation, "model", "demo.txt"), preview[0]);

let edits = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const params = new URLSearchParams(await request.text());
    const title = params.get("title") ?? "";
    if (params.get("action") === "parse") {
      if (title === `${BSE1.articlePrefix}Река`) {
        const markers = [1, 2].map((n) => `<span data-page-number="${n}" data-page-quality="3"></span>`).join("");
        return Response.json({ parse: { text: `${markers}<p>${river}</p>` } });
      }
      const number = Number(title.split("/").at(-1));
      if (title.startsWith(`${BSE1.pageNamespace}:`) && preview[number - 1]) {
        return Response.json({ parse: { templates: [], text: `<p>${preview[number - 1]}</p>` } });
      }
    }
    if (params.get("action") === "query" && params.has("titles")) {
      const pages = params.get("titles")!.split("|").map((title) => ({ title, missing: !existing.has(title) }));
      return Response.json({ query: { pages } });
    }
    if (params.get("action") === "edit") edits++;
    return Response.json({ error: { code: "unexpected_demo_request" } }, { status: 400 });
  },
});

const run = async (script: string, ...args: string[]) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "pipeline", script), ...args], {
    env: {
      ...process.env, WS_API: String(server.url), WS_VOLS: volumes, WS_EVAL: evaluation,
      WS_TEST_MODE: "1", WS_RETRY_MS: "1", WS_BOT_USER: "", WS_BOT_PASS: "",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited) throw new Error(`Ошибка при запуске ${script}`);
};

try {
  await run("pilot.ts", "--dir", review, "--file", edition);
  await run("transclude.ts", "--vol", "7");
  await run("upload.ts", "--vol", "7", "--manifest", "pages");
  await run("eval.ts", "score");
  const checks = (await Bun.file(join(volume, "checks.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
  const expected = ["ready", "section_end_mismatch", "exists"];
  if (checks.map((row) => row.code ?? row.status).join() !== expected.join() || edits) {
    throw new Error("Результат примера расходится с ожидаемым");
  }
  console.log("Готово: .demo/review/index.html, .demo/vols/07/checks.jsonl, .demo/eval/report.md");
} finally {
  server.stop(true);
}
