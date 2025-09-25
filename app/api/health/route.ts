export const runtime = "nodejs";

export async function GET() {
  const hasKey = Boolean(process.env.GOOGLE_API_KEY);
  const env = process.env.NODE_ENV || "development";
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.RAG_BASE_URL || "http://127.0.0.1:3000";
  return Response.json({ ok: true, env, hasKey, ragBase: base });
}

