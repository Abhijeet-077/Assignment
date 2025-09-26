export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";

const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";
const RAW_CHAT_MODEL = process.env.CHAT_MODEL || "gemini-1.5-flash";

function sanitizeModel(model: string): string {
  // Strip Vertex-style version suffixes like -001/-002 and map to AI Studio stable names
  const base = model.replace(/-00\d$/i, "");
  const allowed = new Set(["gemini-1.5-flash", "gemini-1.5-pro"]);
  return allowed.has(base) ? base : "gemini-1.5-flash";
}

// Per-key discovery cache (server memory)
const modelCache = new Map<string, { model: string; alts: string[]; models: string[]; ts: number }>();
const MODEL_TTL_MS = 30 * 60 * 1000;

async function listModelsForKey(key: string): Promise<string[]> {
  try {
    const res = await fetch(`${GOOGLE_BASE}/models`, { headers: { "x-goog-api-key": key } });
    if (!res.ok) return [];
    const j = await res.json();
    const raw: string[] = (j?.models || []).map((m: any) => m?.name).filter(Boolean);
    const names = raw.map((n)=> sanitizeModel(String(n).replace(/^models\//, ""))).filter((n)=> n.startsWith("gemini"));
    return Array.from(new Set(names));
  } catch { return []; }
}
function prioritize(models: string[]): string[] {
  const order = (m: string) => (m === "gemini-1.5-flash" ? 1 : m === "gemini-1.5-pro" ? 2 : m.startsWith("gemini-1.5-") ? 3 : m.startsWith("gemini-1.0-") ? 4 : 9);
  return models.slice().sort((a,b)=> order(a)-order(b));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const key = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!/^AIza[0-9A-Za-z\-_]{20,}$/.test(key)) {
      return NextResponse.json({ ok: false, error: "Invalid format" }, { status: 200 });
    }

    // Use cache
    const frag = key.slice(0,8);
    const cached = modelCache.get(frag);
    const now = Date.now();

    // Discover available models for this key and pick best
    let models = cached && (now - cached.ts < MODEL_TTL_MS) ? cached.models : await listModelsForKey(key);
    if (!models.length) models = [sanitizeModel(RAW_CHAT_MODEL), "gemini-1.5-pro"];
    const alts = prioritize(models);

    // Single-step validation: direct generateContent only, no metadata probe
    let lastError: any = null;
    for (const model of alts) {
      const gen = await fetch(`${GOOGLE_BASE}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } }),
      });
      if (gen.ok) {
        modelCache.set(frag, { model, alts, models, ts: now });
        return NextResponse.json({ ok: true, modelUsed: model, availableModels: alts }, { status: 200 });
      }
      const text = await gen.text().catch(()=>"");
      // Treat 429 as a valid key but rate-limited; allow user to proceed
      if (gen.status === 429) {
        modelCache.set(frag, { model, alts, models, ts: now });
        let msg = text;
        try { const j = JSON.parse(text); msg = j?.error?.message || text; } catch {}
        return NextResponse.json({ ok: true, modelUsed: model, availableModels: alts, rateLimited: true, note: msg?.slice?.(0, 200) }, { status: 200 });
      }
      // If the model is not accessible, try next
      if (gen.status === 403 || gen.status === 404) { lastError = { status: gen.status, text }; continue; }
      // Other errors: capture and stop trying more to avoid extra calls during validation
      lastError = { status: gen.status, text };
      break;
    }

    const status = lastError?.status || 400;
    let error = lastError?.text || "Model not usable for this key";
    let code = "";
    try { const j = JSON.parse(error); error = j?.error?.message || error; code = j?.error?.status || ""; } catch {}
    return NextResponse.json({ ok: false, status, code, error }, { status: 200 });

  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown" }, { status: 200 });
  }
}

