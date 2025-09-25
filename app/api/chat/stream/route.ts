import { NextRequest } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const GEMINI_MODEL = "gemini-1.5-flash";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

function pickPythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPy = path.join(process.cwd(), ".venv", "bin", "python");
  try { if (fs.existsSync(venvPy)) return venvPy; } catch {}
  return "python3";
}

async function callRagCLI(messages: any[]) {
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
      proc.stdin.write(JSON.stringify({ messages }));
      proc.stdin.end();
    } catch { resolve(null); }
  });
}

async function callRagService(messages: any[]) {
  const httpBase = process.env.RAG_HTTP_ENDPOINT || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : process.env.RAG_BASE_URL);
  if (httpBase) {
    try {
      const res = await fetch(`${httpBase}/api/rag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      if (res.ok) return await res.json();
    } catch {}
  }
  return await callRagCLI(messages);
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const { messages } = await req.json();
        if (!Array.isArray(messages) || messages.length === 0) {
          throw new Error("No messages provided");
        }
        const last = messages[messages.length - 1];
        const userQuery: string = last.content ?? "";

        // Get RAG context like /api/chat to ensure streaming uses retrieved docs
        const rag = await callRagService(messages);
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

        // Emit meta first so client can show sources/confidence immediately
        const maxScore = Math.max(0, ...top.map((c: any) => c.score ?? 0));
        const confidence = Math.max(0.3, Math.min(0.98, 0.5 + maxScore * 0.5));
        controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({ sources: top, confidence, intent, mode })}\n\n`));

        if (!GOOGLE_API_KEY || ["YOUR_GOOGLE_API_KEY","REPLACE_ME","REDACTED"].includes(GOOGLE_API_KEY)) throw new Error("Missing or placeholder GOOGLE_API_KEY");
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${GOOGLE_API_KEY}`;
        const contents = [
          { role: "user", parts: [{ text: prompt }] },
        ];
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents }) });
        if (!res.ok || !res.body) {
          // Fallback: emit a single chunk as if it were a Gemini event so UI still renders text
          const fallback = { candidates: [{ content: { parts: [{ text: "I’m having trouble reaching the model right now. Here’s a quick summary based on available context." }] } }] };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(fallback)}\n\n`));
          controller.enqueue(encoder.encode(`event: end\n\n`));
          controller.close();
          return;
        }
        const reader = res.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = new TextDecoder().decode(value);
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        }
        controller.enqueue(encoder.encode(`event: end\n\n`));
        controller.close();
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

