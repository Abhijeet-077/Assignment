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

    // Discover available models for this key and pick best
    let models = await listModelsForKey(key);
    if (!models.length) models = [sanitizeModel(RAW_CHAT_MODEL), "gemini-1.5-pro"];
    const alts = prioritize(models);

    let lastError: any = null;
    for (const model of alts) {
      // Probe metadata
      const meta = await fetch(`${GOOGLE_BASE}/models/${model}`, { method: "GET", headers: { "x-goog-api-key": key } });
      if (!meta.ok) { lastError = { which: "meta", status: meta.status, text: await meta.text().catch(()=>"") }; if (meta.status===403||meta.status===404) continue; }
      // Probe generation
      const gen = await fetch(`${GOOGLE_BASE}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } }),
      });
      if (gen.ok) {
        return NextResponse.json({ ok: true, modelUsed: model }, { status: 200 });
      } else {
        const text = await gen.text().catch(()=>"");
        lastError = { which: "gen", status: gen.status, text };
        if (gen.status===403||gen.status===404) continue;
      }
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

