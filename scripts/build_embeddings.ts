import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

async function embed(text: string): Promise<number[]> {
  if (!GOOGLE_API_KEY) throw new Error('Missing GOOGLE_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedText?key=${GOOGLE_API_KEY}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`Embed error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const emb = data?.embedding?.value ?? data?.embedding?.values ?? [];
  return emb as number[];
}

function chunkText(text: string, size = 1200, overlap = 200) {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + size);
    const slice = text.slice(i, end).trim();
    if (slice.length > 50) chunks.push(slice);
    i += size - overlap;
  }
  return chunks;
}

async function extractPDF(filePath: string) {
  const buf = fs.readFileSync(filePath);
  const out = await pdfParse(buf);
  return out.text || '';
}

async function extractDOCX(filePath: string) {
  const buf = fs.readFileSync(filePath);
  const out = await mammoth.extractRawText({ buffer: buf });
  return out.value || '';
}

async function build() {
  const necPath = path.join(process.cwd(), '2017-NEC-Code-2.pdf');
  const wmPath = path.join(process.cwd(), 'Wattmonk Information.docx');

  const necText = fs.existsSync(necPath) ? await extractPDF(necPath) : '';
  const wmText = fs.existsSync(wmPath) ? await extractDOCX(wmPath) : '';

  const outDir = path.join(process.cwd(), 'public', 'embeddings');
  fs.mkdirSync(outDir, { recursive: true });

  async function processOne(label: 'NEC'|'WATTMONK', file: string, text: string, outName: string) {
    const chunks = chunkText(text);
    const out: any[] = [];
    let idx = 0;
    for (const ch of chunks) {
      idx++;
      const vector = await embed(ch);
      out.push({ id: `${label}-${idx}`, source: label, file, text: ch, vector });
    }
    fs.writeFileSync(path.join(outDir, outName), JSON.stringify(out));
  }

  if (necText) {
    console.log('Embedding NEC...');
    await processOne('NEC', path.basename(necPath), necText, 'nec.json');
  } else {
    console.warn('NEC PDF not found or empty. Skipping.');
    fs.writeFileSync(path.join(outDir, 'nec.json'), JSON.stringify([]));
  }

  if (wmText) {
    console.log('Embedding Wattmonk...');
    await processOne('WATTMONK', path.basename(wmPath), wmText, 'wattmonk.json');
  } else {
    console.warn('Wattmonk DOCX not found or empty. Skipping.');
    fs.writeFileSync(path.join(outDir, 'wattmonk.json'), JSON.stringify([]));
  }

  console.log('Done.');
}

build().catch((e) => { console.error(e); process.exit(1); });

