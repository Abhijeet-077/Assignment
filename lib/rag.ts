import fs from "fs";
import path from "path";
import type { Intent, Chunk, RetrievalResult } from "./types";

let NEC: Chunk[] | null = null;
let WATTMONK: Chunk[] | null = null;

function loadEmbeddings(): { nec: Chunk[]; wattmonk: Chunk[] } {
  if (!NEC || !WATTMONK) {
    const necPath = path.join(process.cwd(), "public", "embeddings", "nec.json");
    const wmPath = path.join(process.cwd(), "public", "embeddings", "wattmonk.json");
    NEC = fs.existsSync(necPath) ? JSON.parse(fs.readFileSync(necPath, "utf-8")) : [];
    WATTMONK = fs.existsSync(wmPath) ? JSON.parse(fs.readFileSync(wmPath, "utf-8")) : [];
  }
  return { nec: NEC || [], wattmonk: WATTMONK || [] };
}

export function classifyIntent(q: string): Intent {
  const s = q.toLowerCase();
  if (/(\bnec\b|national electrical code|nfpa 70|article \d+)/i.test(s)) return "nec";
  if (/(\bwattmonk\b|company|policy|sla|pricing|services|turnaround)/i.test(s)) return "wattmonk";
  return "general";
}

function dot(a: number[], b: number[]) { let s = 0; for (let i=0;i<Math.min(a.length,b.length);i++) s += a[i]*b[i]; return s; }
function norm(a: number[]) { return Math.sqrt(a.reduce((s,x)=>s+x*x,0) || 1); }
function cosSim(a: number[], b: number[]) { return dot(a,b)/(norm(a)*norm(b) || 1); }

async function embed(text: string): Promise<number[]> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    // Fallback: simple hashed pseudo-embedding to allow dev without credentials
    const vec = new Array(256).fill(0).map((_,i)=>{
      let h=0; for (let c of text) { h = (h*31 + c.charCodeAt(0) + i) % 9973; }
      return (h%200-100)/100;
    });
    return vec;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedText?key=${key}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`Embed error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const emb = data?.embedding?.value ?? data?.embedding?.values ?? data?.embedding?.embedding ?? [];
  return emb as number[];
}

export async function retrieve(query: string, hint: Intent): Promise<RetrievalResult> {
  const { nec, wattmonk } = loadEmbeddings();
  // Choose candidate pool based on hint but also allow both
  const pool: Chunk[] = hint === "nec" ? nec : hint === "wattmonk" ? wattmonk : nec.concat(wattmonk);
  if (!pool.length) return { chunks: [] };
  const qv = await embed(query);
  const scored = pool.map((c) => ({
    id: c.id,
    source: c.source,
    file: c.file,
    text: c.text,
    score: cosSim(qv, c.vector || []),
  }));
  scored.sort((a,b)=>b.score - a.score);
  const top = scored.slice(0, 6).filter((x)=> x.score > 0.25);
  return { chunks: top };
}

