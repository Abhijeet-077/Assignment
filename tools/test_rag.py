import json
from api import rag as ragmod

queries = [
    ("NEC", "What is the NEC requirement for GFCI outlets in kitchens?"),
    ("Wattmonk", "What services does Wattmonk provide?"),
    ("General", "Tell me a joke about electricity.")
]

for label, q in queries:
    state = {"query": q}
    res = ragmod._graph.invoke(state)
    print("--", label, "--")
    print(json.dumps({k: res.get(k) for k in ['intent','mode']}, ensure_ascii=False))
    docs = res.get('docs', [])
    scores = res.get('scores', [])
    print("docs:", len(docs))
    for i, d in enumerate(docs[:3]):
        md = d.get('metadata', {}) if isinstance(d, dict) else {}
        print(i+1, md.get('source', ''), md.get('file', ''), (d.get('text','') if isinstance(d, dict) else '')[:120].replace('\n',' '), scores[i] if i < len(scores) else None)
    print()

