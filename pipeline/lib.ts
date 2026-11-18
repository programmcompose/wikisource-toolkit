// Общий клиент API Викитеки и пути к данным томов.
import { resolve } from "path";
import { BSE1 } from "./profile";

export const API = process.env.WS_API ?? BSE1.api;
export const USER_AGENT = process.env.WS_USER_AGENT ?? "WikisourceToolkit/0.1 (https://github.com/programmcompose/wikisource-toolkit)";
const apiUrl = new URL(API);
export const localTestMode = process.env.WS_TEST_MODE === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname);
if (process.env.WS_TEST_MODE === "1" && !localTestMode) {
  throw new Error("WS_TEST_MODE=1 требует локальный WS_API");
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const volDir = (vol: number) =>
  resolve(process.env.WS_VOLS ?? resolve(import.meta.dir, "..", "vols"), String(vol).padStart(2, "0"));

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
export const flag = (name: string) => process.argv.includes(`--${name}`);

export function volArg(): number {
  const vol = Number(arg("vol"));
  if (!Number.isInteger(vol) || vol < 1 || vol > 65) throw new Error("Укажите --vol N (1–65). Том 66 не обрабатывается: он не загружен из-за авторских прав.");
  return vol;
}

// Повторяет запрос при перегрузке сервера (429, 5xx, не JSON, maxlag, ratelimited).
// Все остальные ответы, включая отказы API, возвращает вызывающему коду.
export class Client {
  cookies = new Map<string, string>();
  constructor(private retryUnitMs = Number(process.env.WS_RETRY_MS ?? 30_000)) {}

  async call(params: Record<string, string>, post = true): Promise<any> {
    const body = new URLSearchParams({ maxlag: "5", ...params, format: "json", formatversion: "2" });
    for (let attempt = 0; attempt < 8; attempt++) {
      const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      };
      let r: Response;
      try {
        r = post ? await fetch(API, { method: "POST", body, headers, redirect: "error" }) : await fetch(`${API}?${body}`, { headers, redirect: "error" });
      } catch (e) {
        // Сетевой сбой (отказ соединения, таймаут) — как и 429/5xx, ждём и повторяем.
        const backoff = this.retryUnitMs * (attempt + 1);
        console.log(`  сеть недоступна (${String(e).slice(0, 60)}), жду ${backoff / 1000} с`);
        await sleep(backoff);
        continue;
      }
      for (const c of r.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      const retryAfter = Number(r.headers.get("retry-after")) * 1000 || 0;
      const backoff = Math.max(retryAfter, this.retryUnitMs * (attempt + 1));
      let text: string;
      try { text = await r.text(); } catch (e) {
        console.log(`  обрыв ответа (${String(e).slice(0, 60)}), жду ${backoff / 1000} с`);
        await sleep(backoff);
        continue;
      }
      let json: any;
      try { json = JSON.parse(text); } catch {
        console.log(`  сервер ответил ${r.status} без JSON, жду ${backoff / 1000} с`);
        await sleep(backoff);
        continue;
      }
      const code = json.error?.code;
      if (code === "maxlag" || code === "ratelimited" || code === "readonly") {
        console.log(`  ${code}, жду ${backoff / 1000} с`);
        await sleep(backoff);
        continue;
      }
      return json;
    }
    throw new Error("API не отвечает после 8 попыток");
  }
}

export async function login(api: Client, user: string, pass: string): Promise<void> {
  const loginToken = (await api.call({ action: "query", meta: "tokens", type: "login" })).query.tokens.logintoken;
  const res = await api.call({ action: "login", lgname: user, lgpassword: pass, lgtoken: loginToken });
  if (res.login?.result !== "Success") throw new Error(`Вход не удался: ${res.login?.result ?? "нет ответа"}. ${res.login?.reason ?? ""}`);
}
export const csrfToken = async (api: Client): Promise<string> => (await api.call({ action: "query", meta: "tokens" })).query.tokens.csrftoken;

// Индексы тома. Части одного издания (-1, -2) идут подряд; два разных издания или файла
// (том 63: 1933 и 1935; том 64 и 64-1) нужно выбрать явно через --index.
export type IndexFile = { file: string; year: number; part: number };
export function selectIndexes(all: string[], vol: number, choose?: string): IndexFile[] {
  const groups = new Map<string, IndexFile[]>();
  for (const file of all) {
    const m = file.match(/^БСЭ-1 Том (\d+)(-\d+)?\. .*\((\d{4})\)(?:-(\d+))?\.pdf$/);
    if (!m || Number(m[1]) !== vol) continue;
    if (choose && !file.includes(choose)) continue;
    const base = file.replace(/-\d+\.pdf$/, ".pdf");
    (groups.get(base) ?? groups.set(base, []).get(base)!).push({ file, year: Number(m[3]), part: Number(m[4] ?? 1) });
  }
  if (groups.size === 0) throw new Error(`Не найден индекс тома ${vol}${choose ? ` по «${choose}»` : ""}`);
  if (groups.size > 1) throw new Error(`У тома ${vol} несколько изданий, выберите через --index:\n  ${[...groups.keys()].join("\n  ")}`);
  return [...groups.values()][0].sort((a, b) => a.part - b.part);
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  const f = Bun.file(path);
  if (!(await f.exists())) return [];
  return (await f.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
