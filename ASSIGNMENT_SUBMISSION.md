# RAG Chatbot — Assignment Submission

Note: Replace the placeholders below with your links before submission.
- GitHub Repository URL: <ADD_LINK_HERE>
- Live Demo (Direct Link): <ADD_LINK_HERE>

## 1) Project Overview
A production-ready Retrieval-Augmented Generation (RAG) chatbot built with Next.js (App Router) and a Python serverless function, designed for Vercel deployment. It supports:
- Hybrid conversation: General chat and RAG for NEC code and Wattmonk knowledge
- FAISS-based vector search with Google text-embedding-004
- Streaming responses from Google Gemini 1.5 Flash via SSE
- Client-provided API Key (no server env required) with persistent localStorage and validation
- Transparent RAG citations (sources + confidence)
- Modern, user-friendly UI/UX with a rainbow loading sphere and centered chat layout

## 2) Key Features
- RAG with FAISS:
  - Prebuilt FAISS indexes shipped in `data/faiss/nec` and `data/faiss/wattmonk`
  - Python runtime loads indexes, retrieves ranked context, and returns docs + scores
- Dual runtime orchestration:
  - Node.js API routes for chat and streaming
  - Python serverless function (`/api/rag`) for retrieval pipeline
- Client-side API Key Modal (no server env required):
  - On first load (if no server key configured), users are prompted for a Google Gemini API key
  - Key stored securely in browser localStorage
  - Key format check (starts with `AIza...`) and live validation via `/api/validate-key`
  - Settings button in the input bar to update the key at any time
- Streaming UX:
  - Rainbow RGB sphere while waiting for first streamed token
  - Progressive text updates (SSE)
- RAG Transparency:
  - Source chips (source, file, id, score)
  - Confidence score per response
- Safety & Resilience:
  - Optional per-key rate limiting (IP + key-fragment) on `/api/chat`
  - Fallback to server `GOOGLE_API_KEY` when provided
  - Graceful error messaging for invalid/expired keys

## 3) Architecture
- Next.js 14 App Router (TypeScript)
  - `app/api/chat/route.ts` — Non-streaming chat endpoint
  - `app/api/chat/stream/route.ts` — Streaming chat endpoint (SSE)
  - `app/api/health/route.ts` — Simple health and config probe
  - `app/api/validate-key/route.ts` — Safe key validation endpoint
  - `app/page.tsx` — Chat UI, key modal, loaders, sources, confidence
- Python (Vercel-compatible serverless)
  - `api/rag.py` — Loads FAISS, retrieves context, returns ranked docs; accepts per-request API key
  - `tools/rag_cli.py` — Local CLI adapter for dev without HTTP
- Data
  - `data/faiss/` — FAISS artifacts for NEC and Wattmonk corpora

## 4) Client-Provided API Key Flow
- When server has no key and no local key:
  - A modal appears on load and cannot be dismissed until a valid key is saved
- Validation
  - Basic pattern check (starts with `AIza`, reasonable length)
  - Server-side validation via `/api/validate-key` calling Google’s model metadata endpoint
- Persistence
  - Key stored in `localStorage` as `gm_api_key`
- Usage
  - All chat requests send key in `x-api-key` header and `apiKey` body; the server and Python function use it per request
- Security Notes
  - The key never persists on the server; it is used only for the active request
  - Users are warned not to share their keys; storage is local to the browser

## 5) How To Run Locally
Prerequisites: Node 18+, Python 3.10+, and the FAISS artifacts committed in `data/faiss/**`.

1) Install Node dependencies
- `npm install`

2) (Optional) Create `.env` if you want a server-side key
- `GOOGLE_API_KEY=YOUR_KEY` (when present, client modal will not show by default)

3) Start the dev server
- `npm run dev`
- Open http://localhost:3000

4) First-time key prompt (if no server key)
- Enter your Gemini API key in the modal and click “Save & Continue”

5) Try both modes
- RAG examples
  - “NEC GFCI kitchen requirements?”
  - “What services does Wattmonk provide?”
- General example
  - “Tell me a clean joke about electricity.”

## 6) Vercel Readiness (No auto deploy performed)
- Serverless compatibility verified for both Node and Python routes
- FAISS artifacts included under `data/faiss/**`
- Runtime key handling:
  - Uses `GOOGLE_API_KEY` if provided in Vercel env
  - Otherwise accepts client-provided key via request
- Validate after deploy:
  - GET `/api/health` → `{ ok: true, hasKey: boolean }`
  - Modal appears on the site if `hasKey: false` and no local key is stored

## 7) Notable Files Changed for This Assignment
- `app/page.tsx`
  - Added API Key modal + localStorage flow and settings button
  - Integrated key into streaming and non-streaming requests
  - Rainbow sphere loading indicator
- `app/api/chat/route.ts`
  - Accepts `x-api-key`/`apiKey`; forwards to Python RAG; per-key rate limiting
- `app/api/chat/stream/route.ts`
  - Accepts `x-api-key`/`apiKey`; uses the key for SSE calls; forwards to Python RAG
- `app/api/validate-key/route.ts`
  - Validates user-provided keys safely
- `api/rag.py`
  - Added `KEY_OVERRIDE` and `get_key()` for per-request keys; reset in `finally`
- `tools/rag_cli.py`
  - Passes `apiKey` through to Python function for local dev

## 8) Testing Performed
- TypeScript compile: fixed JSX errors in `app/page.tsx` (modal placement)
- Manual checks:
  - Modal shows when no server key and no local key; blocked until valid key
  - Key validation path returns appropriate success/error states
  - Streaming renders with rainbow sphere until first token arrives
  - RAG sources and confidence render correctly
  - Updating the key via settings button takes effect immediately

## 9) Known Limitations and Next Steps
- If FAISS wheel fails in Vercel Python install, pin a compatible `faiss-cpu` version or switch to a hosted vector DB
- Basic per-key/IP rate limiting added only for `/api/chat`; can be mirrored for `/api/chat/stream`
- Consider adding a visible “Reset API Key” in the modal header
- Optional telemetry: request/latency metrics and error monitoring

## 10) Submission Checklist
- [ ] Replace GitHub Repository URL with your public repository link
- [ ] Replace Live Demo URL with the Vercel deployment link
- [ ] Verify the modal flow on a fresh browser profile
- [ ] Verify RAG answers include sources and confidence
- [ ] Verify streaming works and the loading sphere hides on first token

