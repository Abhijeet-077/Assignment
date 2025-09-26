
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export const runtime = "nodejs"; // allow fs

const CHAT_MODEL = process.env.CHAT_MODEL || "gemini-1.5-flash";
const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";

function sanitizeModel(model: string): string {
  const base = model.replace(/-00\d$/i, "");
  const allowed = new Set(["gemini-1.5-flash", "gemini-1.5-pro"]);
  return allowed.has(base) ? base : "gemini-1.5-flash";
}

// Simple per-key model cache to avoid repeated discovery
const modelCache = new Map<string, { model: string; alts: string[]; ts: number }>();
const MODEL_TTL_MS = 30 * 60 * 1000; // 30 minutes

function normName(name: string): string {
  // Accept names like "models/gemini-1.5-flash" and normalize
  const n = name.replace(/^models\//, "");
  return sanitizeModel(n);
}

async function listModelsForKey(key: string): Promise<string[]> {
  try {
    const res = await fetch(`${GOOGLE_BASE}/models`, { headers: { "x-goog-api-key": key } });
    if (!res.ok) return [];
    const j = await res.json();
    const raw: string[] = (j?.models || []).map((m: any) => m?.name).filter(Boolean);
    const names = raw.map(normName).filter((n) => n.startsWith("gemini"));
    // De-duplicate
    return Array.from(new Set(names));
  } catch {
    return [];
  }
}

function prioritize(models: string[]): string[] {
  const order = (m: string) => (
    m === "gemini-1.5-flash" ? 1 :
    m === "gemini-1.5-pro" ? 2 :
    m.startsWith("gemini-1.5-") ? 3 :
    m.startsWith("gemini-1.0-") ? 4 :
    9
  );
  return models.slice().sort((a,b)=> order(a)-order(b));
}

async function getBestModelForKey(key: string): Promise<{ model: string; alts: string[] }> {
  const frag = key.slice(0, 8);
  const existing = modelCache.get(frag);
  const now = Date.now();
  if (existing && now - existing.ts < MODEL_TTL_MS) return { model: existing.model, alts: existing.alts };
  let models = await listModelsForKey(key);
  if (!models.length) {
    // Fallback to env/chat model as a last resort
    models = [sanitizeModel(CHAT_MODEL), "gemini-1.5-pro"];
  }
  const prioritized = prioritize(models);
  const best = prioritized[0] || sanitizeModel(CHAT_MODEL);
  modelCache.set(frag, { model: best, alts: prioritized, ts: now });
  return { model: best, alts: prioritized };
}

// Simple in-memory rate limiter and cache (best-effort in serverless)
const rateHits = new Map<string, { count: number; ts: number }>();
const simpleCache = new Map<string, any>();
const CACHE_MAX = 100;

function rateLimit(key: string, limit = Number(process.env.RATE_LIMIT_RPM || 10), windowMs = 60_000) {
  const now = Date.now();
  const rec = rateHits.get(key) || { count: 0, ts: now };
  if (now - rec.ts > windowMs) { rec.count = 0; rec.ts = now; }
  rec.count += 1; rateHits.set(key, rec);
  if (rec.count > limit) throw new Error("Rate limit exceeded, try again later.");
}

async function callGemini(prompt: string, history: { role: string; content: string }[], providedKey?: string): Promise<{ text: string; modelUsed: string }> {
  const professionalPrefix = "Please answer professionally with short paragraphs and bullet points where suitable.";
  const sysPrompt = `${professionalPrefix}\n\n${prompt}`;
  const key = (providedKey && !["YOUR_GOOGLE_API_KEY","REPLACE_ME","REDACTED"].includes(providedKey))
    ? providedKey
    : process.env.GOOGLE_API_KEY;
  if (!key || ["YOUR_GOOGLE_API_KEY","REPLACE_ME","REDACTED"].includes(key)) {
    return { text: "I’m running without a valid Google API key. Add it in the settings (API Key) to enable live answers.", modelUsed: sanitizeModel(CHAT_MODEL) };
  }
  const contents = [
    ...history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: sysPrompt }] },
  ];
  const frag = key.slice(0, 8);
  const base = await getBestModelForKey(key);
  const candidates = base.alts.length ? base.alts : [base.model];
  for (const model of candidates) {
    try {
      const url = `${GOOGLE_BASE}/models/${model}:generateContent`;
      let attempt = 0;
      while (true) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents }),
        });
        if (!res.ok) {
          const text = await res.text();
          console.error("Gemini API error", model, res.status, text?.slice?.(0, 400));
          if (res.status === 403 || res.status === 404) { attempt = 99; break; }
          if (res.status === 429 && attempt < 2) { attempt++; await new Promise(r=>setTimeout(r, 600 * attempt)); continue; }
          const mapped = mapGoogleError(res.status, text);
          return { text: mapped.userMessage, modelUsed: model };
        }
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("\n") ?? "";
        modelCache.set(frag, { model, alts: candidates, ts: Date.now() });
        return { text: text || "I couldnt find a clear answer. Could you please rephrase or add more detail?", modelUsed: model };
      }
      if (attempt === 99) continue;
    } catch (e: any) {
      console.error("Gemini call failed", model, e?.message || e);
      // try next model on network hiccups too
      continue;
    }
  }
  return { text: "All candidate models failed for this key. Please check your AI Studio model access and quota.", modelUsed: base.model };
}

function mapGoogleError(status: number, body: string) {
  let code = ""; let message = "";
  try { const j = JSON.parse(body); code = j?.error?.status || ""; message = j?.error?.message || ""; } catch {}
  const suggestions: Record<string, string> = {
    "401": "Invalid API key. Re-enter your Google AI Studio key.",
    "403": "Permission denied. Ensure billing is enabled and remove IP/Referrer restrictions for testing.",
    "404": "Model not found. Use gemini-1.5-flash and the Google AI Studio API, not Vertex AI endpoints.",
    "429": "Rate limited. Wait and retry or increase quota in AI Studio.",
  };
  const fallback = "The model request failed. Please verify your key, permissions, and quota.";
  const hint = suggestions[String(status)] || fallback;
  const userMessage = message ? `${hint} (${message})` : hint;
  return { status, code, message, userMessage };
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
  // Prefer explicit HTTP endpoint if provided (e.g., Vercel prod)
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
  // Fallback to local CLI for dev if HTTP not available
  return await callRagCLI(messages, apiKey);
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "anon";

    const body = await req.json();
    const messages = body?.messages;
    const providedKey = req.headers.get("x-api-key") || body?.apiKey;

    const keyFrag = providedKey ? providedKey.slice(0, 8) : "nokey";
    rateLimit(`${ip}:${keyFrag}`);

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "No messages provided" }, { status: 400 });
    }
    const last = messages[messages.length - 1];
    const userQuery: string = last.content ?? "";

    // Cache by last message content and key fragment
    const cacheKey = `q:${keyFrag}:${userQuery}`;
    if (simpleCache.has(cacheKey)) {
      return NextResponse.json(simpleCache.get(cacheKey));
    }

    // Ask Python RAG service (FAISS + LangChain/LangGraph)
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

    const history = messages.slice(0, -1).map((m: any) => ({ role: m.role, content: m.content }));
    const { text: answer, modelUsed } = await callGemini(prompt, history, providedKey);

    const maxScore = Math.max(0, ...top.map((c: any) => c.score ?? 0));
    const confidence = Math.max(0.3, Math.min(0.98, 0.5 + maxScore * 0.5));

    const payload = {
      text: answer,
      sources: top.map((t: any) => ({ id: t.id, source: t.source, file: t.file, score: t.score })),
      confidence,
      intent,
      mode,
      modelUsed,
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

