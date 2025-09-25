"use client";
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string; sources?: any[]; confidence?: number };

export default function Page() {
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Hi! I’m your RAG chatbot. Ask me NEC, Wattmonk, or general questions." },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [hasFirstToken, setHasFirstToken] = useState(false);


  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    if (!input.trim()) return;
    const userMsg: Msg = { role: "user", content: input };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setLoading(true);
    setHasFirstToken(false);

    // Attempt streaming first for better UX; fallback to non-streaming JSON
    try {
      const controller = new AbortController();
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMsg] }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error("Stream not available");

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let assistantText = "";
      let meta: any = null;
      // create placeholder assistant message
      let added = false;
      let baseIndex = -1;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value);
        // SSE lines may contain multiple events; split by double newline
        const events = chunk.split("\n\n").filter(Boolean);
        for (const ev of events) {
          if (ev.startsWith("event: meta")) {
            const m = ev.split("\n").find((l) => l.startsWith("data:"));
            if (m) meta = JSON.parse(m.replace(/^data:\s*/, ""));
            // Ensure a placeholder assistant message appears quickly
            if (!added) {
              const assistant: Msg = { role: "assistant", content: "", sources: meta?.sources, confidence: meta?.confidence };
              setMessages((msgs) => { baseIndex = msgs.length; return [...msgs, assistant]; });
              added = true;
            }
            continue;
          }
          if (ev.startsWith("event: error")) {
            throw new Error("Streaming error");
          }
          if (ev.startsWith("event: end")) {
            continue;
          }
          // Default Google stream chunks are "data: {json}"
          const line = ev.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let payload: any;
          try { payload = JSON.parse(line.replace(/^data:\s*/, "")); } catch { continue; }
          // Each chunk may have candidates with content.parts[].text
          const piece = payload?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") || "";
          if (!added) {
            const assistant: Msg = { role: "assistant", content: piece, sources: meta?.sources, confidence: meta?.confidence };
            setMessages((msgs) => { baseIndex = msgs.length; return [...msgs, assistant]; });
            added = true;
            if (piece) setHasFirstToken(true);
          } else if (piece) {
            assistantText += piece;
            setMessages((m) => {
              const copy = m.slice();
              const last = copy[baseIndex];
              copy[baseIndex] = { ...last, content: (assistantText || piece), sources: meta?.sources, confidence: meta?.confidence };
              return copy;
            });
            setHasFirstToken(true);
          }
        }
      }
      setLoading(false);
      return;
    } catch {}

    // Fallback to non-streaming
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMsg] }),
      });
      const data = await res.json();
      const assistant: Msg = { role: "assistant", content: data.text, sources: data.sources, confidence: data.confidence };
      setMessages((m) => [...m, assistant]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", content: "Sorry, something went wrong." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{
        position: "relative",
        display: "grid",
        gridTemplateRows: "1fr auto",
        width: "min(92vw, 900px)",
        height: "min(84vh, 720px)",
        background: "rgba(9,14,36,0.92)",
        border: "1px solid #223069",
        borderRadius: 16,
        boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        backdropFilter: "blur(2px)",
        zIndex: 1,
      }}>
        <div ref={listRef} style={{ padding: 16, overflowY: "auto" }}>
          <Header />
          {messages.map((m, i) => {
            const isAssistant = m.role === "assistant";
            const isEmpty = !m.content || m.content.trim() === "";
            if (isAssistant && isEmpty) return null; // no placeholder boxes
            return (
              <div key={i} style={{ margin: "12px 0" }}>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{isAssistant ? "Assistant" : "You"}</div>
                <div style={{ background: isAssistant ? "#111936" : "#1c244a", border: "1px solid #243066", padding: 12, borderRadius: 10, whiteSpace: "normal", lineHeight: 1.6 }}>
                  <RichText text={m.content} />
                  {isAssistant && m.sources?.length ? (
                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                      <div>Sources:</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                        {m.sources.map((s: any, idx: number) => (
                          <div key={idx} style={{ padding: "4px 8px", background: "#18224a", border: "1px solid #2b3a78", borderRadius: 8 }}>
                            {s.source} • {s.file} • #{s.id} • {(s.score ?? 0).toFixed(2)}
                          </div>
                        ))}
                      </div>
                      {typeof m.confidence === "number" && (
                        <div style={{ marginTop: 6 }}>Confidence: {(m.confidence * 100).toFixed(0)}%</div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {loading && !hasFirstToken && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
              <RainbowSphere />
            </div>
          )}

        </div>
        <div style={{ padding: 12, borderTop: "1px solid #22306a", background: "#0b1020", borderBottomLeftRadius: 16, borderBottomRightRadius: 16 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Ask about NEC, Wattmonk, or anything else..."
              rows={2}
              style={{
                flex: 1,
                resize: "none",
                padding: 10,
                background: "#0f1736",
                color: "#f5f7ff",
                border: "1px solid #243066",
                borderRadius: 10,
                outline: "none",
              }}
            />
            <button onClick={send} disabled={loading} style={{
              padding: "10px 16px",
              background: loading ? "#2b386f" : "#3041a7",
              color: "white",
              border: "none",
              borderRadius: 10,
              cursor: loading ? "not-allowed" : "pointer"
            }}>{loading ? "Sending..." : "Send"}</button>
          </div>
          <div style={{ color: "#9aa7ff", fontSize: 12, textAlign: "center", marginTop: 8 }}>
            Uses Google Gemini for generation and text-embedding-004 for retrieval.
          </div>
        </div>
      </div>
        <style jsx global>{`
          @keyframes spinRainbow { to { transform: rotate(360deg); } }
          .rainbow-sphere { width:56px; height:56px; border-radius:50%;
            background: conic-gradient(#ff3e3e, #ffbf00, #3dff3d, #00d4ff, #7b61ff, #ff3ef7, #ff3e3e);
            animation: spinRainbow 1.2s linear infinite;
            filter: drop-shadow(0 0 8px rgba(79,140,255,0.55)); position: relative; }
          .rainbow-sphere::after { content:''; position:absolute; inset:3px; border-radius:50%;
            background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.7), rgba(255,255,255,0.05) 35%, rgba(0,0,0,0.35) 70%); }
        `}</style>

    </div>
  );
}

function RainbowSphere() {
  return <div className="rainbow-sphere" aria-label="Loading" />;
}

function RichText({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  return (
    <div>
      {blocks.map((block, i) => {
        const lines = block.split(/\n+/).map((l) => l.trim()).filter(Boolean);
        const isNumbered = lines.length > 1 && lines.every((l) => /^\d+\.\s+/.test(l));
        const isBulleted = lines.length > 1 && lines.every((l) => /^[-*•]\s+/.test(l));
        if (isNumbered) {
          return (
            <ol key={i} style={{ margin: '0 0 8px 20px', padding: 0 }}>
              {lines.map((l, idx) => <li key={idx} style={{ margin: '4px 0' }}>{l.replace(/^\d+\.\s+/, '')}</li>)}
            </ol>
          );
        }
        if (isBulleted) {
          return (
            <ul key={i} style={{ margin: '0 0 8px 20px', padding: 0 }}>
              {lines.map((l, idx) => <li key={idx} style={{ margin: '4px 0' }}>{l.replace(/^[-*•]\s+/, '')}</li>)}
            </ul>
          );
        }
        return <p key={i} style={{ margin: '0 0 8px 0' }}>{block}</p>;
      })}
    </div>
  );
}

function Header() {
  return (
    <div style={{ maxWidth: 900, margin: "0 auto 16px auto" }}>
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Wattmonk RAG Chatbot</div>
      <div style={{ opacity: 0.8, fontSize: 13 }}>
        Multi-context RAG: NEC Code • Wattmonk • General. Sources and confidence are displayed for transparency.
      </div>
    </div>
  );
}

