
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export const runtime = "nodejs"; // allow fs

const GEMINI_MODEL = "gemini-1.5-flash";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Simple in-memory rate limiter and cache (best-effort in serverless)
const rateHits = new Map<string, { count: number; ts: number }>();
const simpleCache = new Map<string, any>();
const CACHE_MAX = 100;

function rateLimit(key: string, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const rec = rateHits.get(key) || { count: 0, ts: now };
  if (now - rec.ts > windowMs) { rec.count = 0; rec.ts = now; }
  rec.count += 1; rateHits.set(key, rec);
  if (rec.count > limit) throw new Error("Rate limit exceeded, try again later.");
}

async function callGemini(prompt: string, history: { role: string; content: string }[]) {
  const professionalPrefix = "Please answer professionally with short paragraphs and bullet points where suitable.";
  const sysPrompt = `${professionalPrefix}\n\n${prompt}`;
  if (!GOOGLE_API_KEY || ["YOUR_GOOGLE_API_KEY", "REPLACE_ME", "REDACTED"].includes(GOOGLE_API_KEY)) {
    return "I’m running without a valid Google API key right now. Please add GOOGLE_API_KEY in your .env to enable live model answers.";
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;
  const contents = [
    ...history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: sysPrompt }] },
  ];
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("Gemini API error", res.status, text?.slice?.(0, 400));
      return "I’m having trouble reaching the language model at the moment. Please try again in a bit.";
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("\n") ?? "";
    return text || "I couldn’t find a clear answer. Could you please rephrase or add more detail?";
  } catch (e: any) {
    console.error("Gemini call failed", e?.message || e);
    return "I’m having trouble reaching the language model at the moment. Please try again in a bit.";
  }
}

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
  // Prefer explicit HTTP endpoint if provided (e.g., Vercel prod)
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
  // Fallback to local CLI for dev if HTTP not available
  return await callRagCLI(messages);
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "anon";
    rateLimit(ip);

    const { messages } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "No messages provided" }, { status: 400 });
    }
    const last = messages[messages.length - 1];
    const userQuery: string = last.content ?? "";

    // Cache by last message content
    const cacheKey = `q:${userQuery}`;
    if (simpleCache.has(cacheKey)) {
      return NextResponse.json(simpleCache.get(cacheKey));
    }

    // Ask Python RAG service (FAISS + LangChain/LangGraph)
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

    const history = messages.slice(0, -1).map((m: any) => ({ role: m.role, content: m.content }));
    const answer = await callGemini(prompt, history);

    const maxScore = Math.max(0, ...top.map((c: any) => c.score ?? 0));
    const confidence = Math.max(0.3, Math.min(0.98, 0.5 + maxScore * 0.5));

    const payload = {
      text: answer,
      sources: top.map((t: any) => ({ id: t.id, source: t.source, file: t.file, score: t.score })),
      confidence,
      intent,
      mode,
      memory_summary: rag?.memory_summary || "",
    };
    // simple cache with size cap
    if (simpleCache.size >= CACHE_MAX) {
      const firstKey = simpleCache.keys().next().value as string | undefined;
      if (firstKey) simpleCache.delete(firstKey);
    }
    simpleCache.set(cacheKey, payload);
    return NextResponse.json(payload);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Unknown error" }, { status: 500 });
  }
}

