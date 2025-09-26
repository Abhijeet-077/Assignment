import os
import json
from typing import Any, Dict, List, Tuple
from dotenv import load_dotenv

# Vercel Python Serverless Function
# Exposed at /api/rag

from langchain_community.vectorstores import FAISS
from langchain_google_genai import GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.docstore.document import Document
from langchain.schema import BaseMessage
from langchain.retrievers.document_compressors import DocumentCompressorPipeline
from langchain.retrievers import ContextualCompressionRetriever
from langchain_core.vectorstores.utils import maximal_marginal_relevance

from langgraph.graph import StateGraph, END

load_dotenv()

ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, "data", "faiss")

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
EMBED_MODEL = os.getenv("EMBED_MODEL", "models/text-embedding-004")
CHAT_MODEL = os.getenv("CHAT_MODEL", "gemini-1.5-flash")

def sanitize_model(name: str) -> str:
    import re
    base = re.sub(r"-00\d$", "", name or "")
    allowed = {"gemini-1.5-flash", "gemini-1.5-pro"}
    return base if base in allowed else "gemini-1.5-flash"

# Allow per-request override from Node client
KEY_OVERRIDE = None  # type: ignore

def get_key():
    return KEY_OVERRIDE or os.getenv("GOOGLE_API_KEY")

# ----------------------- Utilities -----------------------

def classify_intent(q: str) -> str:
    s = (q or "").lower()
    if any(k in s for k in [" nec ", "national electrical code", "nfpa 70", "article "]):
        return "nec"
    if any(k in s for k in ["wattmonk", "policy", "sla", "pricing", "services", "turnaround"]):
        return "wattmonk"
    return "general"


def load_vs(name: str):
    path = os.path.join(DATA_DIR, name)
    if not os.path.exists(path):
        return None
    key = get_key()
    embeddings = GoogleGenerativeAIEmbeddings(model=EMBED_MODEL, google_api_key=key) if key else None
    try:
        vs = FAISS.load_local(path, embeddings=embeddings, allow_dangerous_deserialization=True)
        return vs
    except Exception:
        return None


def retrieve(query: str, hint: str, k: int = 6) -> Tuple[List[Document], List[float]]:
    pools = []
    if hint == "nec":
        nec = load_vs("nec")
        if nec: pools.append(nec)
    elif hint == "wattmonk":
        wm = load_vs("wattmonk")
        if wm: pools.append(wm)
    else:
        nec = load_vs("nec")
        wm = load_vs("wattmonk")
        if nec: pools.append(nec)
        if wm: pools.append(wm)

    if not pools:
        return [], []

    # concat results by score, do MMR selection at the end
    candidates: List[Tuple[Document, float]] = []
    for vs in pools:
        try:
            docs_and_scores = vs.similarity_search_with_score(query, k=k*2)
            candidates.extend(docs_and_scores)
        except Exception:
            continue

    if not candidates:
        return [], []

    # Simplify: avoid extra embedding calls; rely on FAISS ranking to reduce quota usage
    candidates.sort(key=lambda x: x[1])  # lower distance better
    docs = [d for d,_ in candidates[:k]]
    scores = [1.0/(1.0+s) for _,s in candidates[:k]]
    return docs, scores


def decide_mode(scores: List[float], intent: str) -> str:
    max_s = max(scores) if scores else 0.0
    if intent in ("nec", "wattmonk") and max_s > 0.25:
        return "rag"
    if max_s > 0.7:
        return "rag"
    return "general"


ENABLE_MEMORY_SUMMARY = os.getenv("ENABLE_MEMORY_SUMMARY", "0") == "1"

def summarize_history(messages: List[Dict[str, str]], model_name: str = CHAT_MODEL) -> str:
    if not ENABLE_MEMORY_SUMMARY:
        return ""
    key = get_key()
    if not messages or not key:
        return ""
    # Throttle: only summarize every 6th message to limit cost
    if len(messages) % 6 != 0:
        return ""
    model = ChatGoogleGenerativeAI(model=sanitize_model(model_name), google_api_key=key, temperature=0.3)
    last = messages[-20:]
    text = "\n".join([f"{m.get('role')}: {m.get('content')}" for m in last])
    prompt = ("Summarize the following conversation briefly but keep key facts, user goals, constraints, and any conclusions.\n\n" + text)
    try:
        out = model.invoke(prompt)
        return getattr(out, 'content', '') or ''
    except Exception:
        return ""

# ----------------------- LangGraph (lightweight router) -----------------------

def build_graph():
    def _start(state: Dict[str, Any]):
        q = state.get("query", "")
        state["intent"] = classify_intent(q)
        return state

    def _retrieve(state: Dict[str, Any]):
        q = state.get("query", "")
        intent = state.get("intent", "general")
        docs, scores = retrieve(q, intent)
        state["docs"] = [
            {
                "text": d.page_content,
                "source": d.metadata.get("source") or d.metadata.get("file", ""),
                "metadata": d.metadata,
            } for d in docs
        ]
        state["scores"] = scores
        state["mode"] = decide_mode(scores, intent)
        return state

    def _end(state: Dict[str, Any]):
        return state

    g = StateGraph(dict)
    g.add_node("start", _start)
    g.add_node("retrieve", _retrieve)
    g.set_entry_point("start")
    g.add_edge("start", "retrieve")
    g.add_edge("retrieve", END)
    return g.compile()

_graph = build_graph()

# ----------------------- Handler -----------------------

def handler(request):  # vercel python serverless entry
    from flask import Response
    global KEY_OVERRIDE
    try:
        if request.method == "OPTIONS":
            return Response(status=200, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"})
        body_text = request.get_data(as_text=True) or "{}"
        data = json.loads(body_text)
        KEY_OVERRIDE = data.get("apiKey") or None
        messages = data.get("messages", [])
        query = messages[-1].get("content") if messages else data.get("query", "")
        state = {"query": query}
        result = _graph.invoke(state)
        memory_summary = summarize_history(messages)

        # Shape response for Node orchestrator
        docs = result.get("docs", [])
        scores = result.get("scores", [])
        out_docs = []
        for i, d in enumerate(docs):
            out_docs.append({
                "id": i+1,
                "text": d.get("text", ""),
                "source": (d.get("metadata", {}) or {}).get("source") or d.get("source") or "",
                "file": (d.get("metadata", {}) or {}).get("file", ""),
                "score": scores[i] if i < len(scores) else 0.0,
            })

        resp = {
            "intent": result.get("intent", "general"),
            "mode": result.get("mode", "general"),
            "docs": out_docs,
            "memory_summary": memory_summary,
        }
        return Response(response=json.dumps(resp), status=200, headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"})
    except Exception as e:
        return Response(response=json.dumps({"error": str(e)}), status=500, headers={"Content-Type": "application/json"})
    finally:
        try:
            KEY_OVERRIDE = None
        except Exception:
            pass

# Vercel requires a top-level named `handler` function

# For local ad-hoc run
if __name__ == "__main__":
    class DummyReq:
        method = "POST"
        def get_data(self, as_text=False):
            return json.dumps({"messages": [{"role":"user","content":"What does NEC say about grounding?"}]})
    print(handler(DummyReq()).get_data(as_text=True))

