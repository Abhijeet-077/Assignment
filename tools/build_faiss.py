import os
import pathlib
import json
from typing import List
from dotenv import load_dotenv

from langchain_community.document_loaders import PyPDFLoader, Docx2txtLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_community.vectorstores import FAISS

load_dotenv()

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "faiss"
DATA_DIR.mkdir(parents=True, exist_ok=True)

NEC_PATH = ROOT / "2017-NEC-Code-2.pdf"
WM_PATH = ROOT / "Wattmonk Information.docx"

CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "1200"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "200"))

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
if not GOOGLE_API_KEY:
    print("[WARN] GOOGLE_API_KEY not set. This script requires a valid key for embeddings.")


def load_docs() -> List:
    docs = []
    if NEC_PATH.exists():
        print("Loading NEC PDF...")
        docs += PyPDFLoader(str(NEC_PATH)).load()
    else:
        print("[WARN] NEC PDF not found at", NEC_PATH)
    if WM_PATH.exists():
        print("Loading Wattmonk DOCX...")
        docs += Docx2txtLoader(str(WM_PATH)).load()
    else:
        print("[WARN] Wattmonk DOCX not found at", WM_PATH)
    return docs


def build_index(name: str, docs: List):
    if not docs:
        (DATA_DIR / name).mkdir(parents=True, exist_ok=True)
        (DATA_DIR / name / "EMPTY").write_text("no-data")
        print(f"[INFO] Created empty index folder for {name}")
        return

    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
    chunks = splitter.split_documents(docs)
    print(f"Split into {len(chunks)} chunks for {name}")

    max_chunks_env = os.getenv("MAX_CHUNKS")
    if max_chunks_env:
        try:
            mc = int(max_chunks_env)
            if mc > 0:
                chunks = chunks[:mc]
                print(f"Capped to first {mc} chunks via MAX_CHUNKS")
        except Exception:
            pass

    embeddings = GoogleGenerativeAIEmbeddings(model="models/text-embedding-004", google_api_key=GOOGLE_API_KEY)
    vs = FAISS.from_documents(chunks, embeddings)

    out_dir = DATA_DIR / name
    vs.save_local(str(out_dir))
    print(f"Saved FAISS index to {out_dir}")


def main():
    all_docs = load_docs()
    nec_docs = [d for d in all_docs if "NEC" in (d.metadata.get("source", "") + d.page_content[:100]) or str(NEC_PATH.name) in d.metadata.get("source", "")]
    wm_docs = [d for d in all_docs if "Wattmonk" in (d.metadata.get("source", "") + d.page_content[:100]) or str(WM_PATH.name) in d.metadata.get("source", "")]

    # Fallback: if heuristics fail, just split by file ext
    if not nec_docs and NEC_PATH.exists():
        nec_docs = PyPDFLoader(str(NEC_PATH)).load()
    if not wm_docs and WM_PATH.exists():
        wm_docs = Docx2txtLoader(str(WM_PATH)).load()

    build_index("nec", nec_docs)
    build_index("wattmonk", wm_docs)


if __name__ == "__main__":
    main()

