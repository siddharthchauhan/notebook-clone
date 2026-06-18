import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { streamChat, type ChatMessage } from "../lib/ai";
import { renderMarkdown } from "../lib/markdown";

// Conversational AI sidebar. Each turn includes the current notebook as context
// so the model can reason about the user's cells, and the assistant reply
// streams token-by-token into the last bubble.
function notebookContext(): string {
  const cells = useStore.getState().cells;
  return cells
    .map((c, i) => `# Cell ${i + 1} (${c.cell_type})\n${c.source}`)
    .join("\n\n");
}

export function AiChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history: ChatMessage[] = [...messages, { role: "user", content: text }];
    // Optimistically show the user turn plus an empty assistant bubble to fill.
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let acc = "";
    const setAssistant = (content: string) =>
      setMessages((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", content };
        return copy;
      });

    try {
      await streamChat(history, notebookContext(), {
        signal: ctrl.signal,
        onToken: (t) => {
          acc += t;
          setAssistant(acc);
        },
      });
    } catch (e) {
      const err = e as Error;
      if (err.name !== "AbortError") setAssistant(acc || `⚠️ ${err.message}`);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="ai-chat">
      <div className="chat-log">
        {messages.length === 0 && (
          <div className="chat-empty">
            Ask about your notebook — the assistant sees your cells as context.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.role === "assistant" ? (
              <div
                className="chat-md"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(m.content || "…"),
                }}
              />
            ) : (
              m.content
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          placeholder="Message the assistant…"
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button className="chat-cancel" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="chat-send" onClick={() => void send()} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
