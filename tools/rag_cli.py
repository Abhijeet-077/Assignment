import sys, os, json
from dotenv import load_dotenv

# CLI wrapper to run the RAG graph locally and print JSON to stdout
# Usage: echo '{"messages":[{"role":"user","content":"..."}]}' | python tools/rag_cli.py

load_dotenv()

def main():
    # Lazy import to reuse code from api.rag
    from api import rag as ragmod

    body_text = sys.stdin.read() or "{}"
    data = json.loads(body_text)
    messages = data.get("messages", [])
    query = messages[-1].get("content") if messages else data.get("query", "")
    state = {"query": query}
    result = ragmod._graph.invoke(state)
    memory_summary = ragmod.summarize_history(messages)

    docs = result.get("docs", [])
    scores = result.get("scores", [])
    out_docs = []
    for i, d in enumerate(docs):
        md = d.get("metadata", {}) if isinstance(d, dict) else {}
        out_docs.append({
            "id": i+1,
            "text": d.get("text", "") if isinstance(d, dict) else "",
            "source": (md or {}).get("source") or d.get("source") if isinstance(d, dict) else "",
            "file": (md or {}).get("file", ""),
            "score": scores[i] if i < len(scores) else 0.0,
        })

    resp = {
        "intent": result.get("intent", "general"),
        "mode": result.get("mode", "general"),
        "docs": out_docs,
        "memory_summary": memory_summary,
    }
    sys.stdout.write(json.dumps(resp))

if __name__ == "__main__":
    main()

