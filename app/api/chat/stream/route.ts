import { NextRequest } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const CHAT_MODEL = process.env.CHAT_MODEL || "gemini-1.5-flash";
const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";

function sanitizeModel(model: string): string {
  const base = model.replace(/-00\d$/i, "");
  const allowed = new Set(["gemini-1.5-flash", "gemini-1.5-pro"]);
  return allowed.has(base) ? base : "gemini-1.5-flash";
}

const modelCache = new Map<string, { model: string; alts: string[]; ts: number }>();
const MODEL_TTL_MS = 30 * 60 * 1000;
function normName(name: string): string { return sanitizeModel(name.replace(/^models\//, "")); }
async function listModelsForKey(key: string): Promise<string[]> {
  try {
    const res = await fetch(`${GOOGLE_BASE}/models`, { headers: { "x-goog-api-key": key } });
    if (!res.ok) return [];
    const j = await res.json();
    const names = (j?.models || []).map((m: any) => m?.name).filter(Boolean).map(normName).filter((n: string)=> n.startsWith("gemini"));
    return Array.from(new Set(names));
  } catch { return []; }
}
function prioritize(models: string[]): string[] {
  const order = (m: string) => (m === "gemini-1.5-flash" ? 1 : m === "gemini-1.5-pro" ? 2 : m.startsWith("gemini-1.5-") ? 3 : m.startsWith("gemini-1.0-") ? 4 : 9);
  return models.slice().sort((a,b)=> order(a)-order(b));
}
async function getBestModelForKey(key: string): Promise<{ model: string; alts: string[] }>{
  const frag = key.slice(0,8);
  const ex = modelCache.get(frag); const now = Date.now();
  if (ex && now - ex.ts < MODEL_TTL_MS) return { model: ex.model, alts: ex.alts };
  let models = await listModelsForKey(key);
  if (!models.length) models = [sanitizeModel(CHAT_MODEL), "gemini-1.5-pro"];
  const pr = prioritize(models); const best = pr[0] || sanitizeModel(CHAT_MODEL);
  modelCache.set(frag, { model: best, alts: pr, ts: now });
  return { model: best, alts: pr };
}

function pickPythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPy = path.join(process.cwd(), ".venv", "bin", "python");
  try { if (fs.existsSync(venvPy)) return venvPy; } catch {}
  return "python3";
}

async function callRagCLI(messages: any[], apiKey?: string) {
  return await new Promise<any>((resolve) => {
    try {
      const py = pickPythonBin();
      const proc = spawn(py, ["tools/rag_cli.py"], { cwd: process.cwd(), env: process.env });
      let out = ""; let err = "";
      proc.stdout.on("data", (d) => (out += d.toString()));
      proc.stderr.on("data", (d) => (err += d.toString()));
      proc.on("close", () => {
        try { resolve(JSON.parse(out || "{}")); } catch { resolve(null); }
      });
      proc.stdin.write(JSON.stringify({ messages, apiKey }));
      proc.stdin.end();
    } catch { resolve(null); }
  });
}

async function callRagService(messages: any[], apiKey?: string) {
  const httpBase = process.env.RAG_HTTP_ENDPOINT || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : process.env.RAG_BASE_URL);
  if (httpBase) {
    try {
      const res = await fetch(`${httpBase}/api/rag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, apiKey }),
      });
      if (res.ok) return await res.json();
    } catch {}
  }
  return await callRagCLI(messages, apiKey);
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const body = await req.json();
        const messages = body?.messages;
        const providedKey = req.headers.get("x-api-key") || body?.apiKey;
        if (!Array.isArray(messages) || messages.length === 0) {
          throw new Error("No messages provided");
        }
        const last = messages[messages.length - 1];
        const userQuery: string = last.content ?? "";

        // Get RAG context like /api/chat to ensure streaming uses retrieved docs
        const rag = await callRagService(messages, providedKey);
        const top = (rag?.docs ?? []).slice(0, 4);
        const mode: "rag" | "general" = rag?.mode || (top.some((c: any) => (c.score ?? 0) > 0.35) ? "rag" : "general");
        const intent = rag?.intent || "general";
        const system = `You are a helpful assistant.\n\nRules:\n- If domain-specific (NEC or Wattmonk) and context is provided, answer STRICTLY from the provided context. If unsure, say so and offer to clarify.\n- Start with a concise answer, then optional bullet Sources: [source, file, chunk-id].`;
        const contextBlock = mode === "rag" && top.length
          ? `Context (ranked):\n${top.map((c: any) => `[#${c.id}] [${c.source}] [${c.file}]\n${c.text}`).join("\n\n---\n\n")}`
          : "";
        const domainGuide = intent === "nec"
          ? "Focus on National Electrical Code guidelines; prefer citing sections if known."
          : intent === "wattmonk"
          ? "Focus on Wattmonk policies, services, SLAs, and internal information."
          : "General conversation when no relevant context is found.";
        const prompt = `${system}\n\nUser question:\n${userQuery}\n\n${contextBlock || "(No special context)"}\n\nGuidance: ${domainGuide}\n\nRespond clearly and cite sources if any.`;

        // Prepare meta; will emit after a working model stream is established
        const maxScore = Math.max(0, ...top.map((c: any) => c.score ?? 0));
        const confidence = Math.max(0.3, Math.min(0.98, 0.5 + maxScore * 0.5));

        const key = (providedKey && !["YOUR_GOOGLE_API_KEY","REPLACE_ME","REDACTED"].includes(providedKey)) ? providedKey : process.env.GOOGLE_API_KEY;
        if (!key || ["YOUR_GOOGLE_API_KEY","REPLACE_ME","REDACTED"].includes(key)) throw new Error("Missing or placeholder GOOGLE_API_KEY");
        const { model, alts } = await getBestModelForKey(key);
        const contents = [ { role: "user", parts: [{ text: prompt }] } ];
        let chosen = model; let success = false;
        for (const m of (alts.length ? alts : [model])) {
          const url = `${GOOGLE_BASE}/models/${m}:streamGenerateContent`;
          const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify({ contents }) });
          if (!res.ok || !res.body) {
            let bodyTxt = ""; try { bodyTxt = await res.text(); } catch {}
            if (res.status === 403 || res.status === 404) { chosen = m; continue; }
            controller.enqueue(encoder.encode(`event: error\n` + `data: ${JSON.stringify({ status: res.status, error: bodyTxt?.slice?.(0, 300) || 'No details' })}\n\n`));
            const fallback = { candidates: [{ content: { parts: [{ text: "I’m having trouble reaching the model right now. Please verify your API key permissions and quota." }] } }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(fallback)}\n\n`));
            controller.enqueue(encoder.encode(`event: end\n\n`));
            controller.close();
            return;
          }
          // Emit meta as soon as we have a working stream, with modelUsed
          controller.enqueue(encoder.encode(`event: meta\n` + `data: ${JSON.stringify({ sources: top, confidence, intent, mode, modelUsed: m })}\n\n`));
          const reader = res.body.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          }
          controller.enqueue(encoder.encode(`event: end\n\n`));
          controller.close();
          success = true; chosen = m;
          break;
        }
        if (!success) {
          controller.enqueue(encoder.encode(`event: error\n` + `data: ${JSON.stringify({ error: 'All candidate models failed for this key.' })}\n\n`));
          controller.enqueue(encoder.encode(`event: end\n\n`));
          controller.close();
        }
      } catch (e: any) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: e.message || String(e) })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

