import { useRef, useState } from "react";
import { useStore, type CellState } from "../lib/store";
import { streamAI, type AiAction } from "../lib/ai";
import { renderMarkdown } from "../lib/markdown";

// Per-cell AI controls (Phase 3). Generate/Fix/Edit stream into a live preview
// and, on completion, drop the result in as a new code cell below — the
// original cell is never overwritten. Explain streams Markdown into the panel.
// The whole component is hidden when the server has no AI configured.

type Preview = { mode: "code" | "text"; text: string };

export function AiAssist({ cell }: { cell: CellState }) {
  const aiAvailable = useStore((s) => s.aiAvailable);
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (!aiAvailable || cell.cell_type !== "code") return null;

  const hasError = cell.outputs.some((o) => o.kind === "error");

  const run = async (action: AiAction) => {
    if (busy) return;
    if (action === "generate" && !instruction.trim()) return;
    setError(null);
    setBusy(true);
    const mode: Preview["mode"] = action === "explain" ? "text" : "code";
    setPreview({ mode, text: "" });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const errorOutput = cell.outputs.find((o) => o.kind === "error");
    const traceback =
      action === "fix" && errorOutput?.kind === "error" ? errorOutput.traceback : [];

    let acc = "";
    try {
      await streamAI(
        { action, instruction, code: cell.source, traceback },
        {
          signal: ctrl.signal,
          onToken: (t) => {
            acc += t;
            setPreview({ mode, text: acc });
          },
        },
      );
      if (mode === "code" && acc.trim()) {
        // Land the generated code as a fresh cell below; Editor mounts with it.
        useStore.getState().addCell(cell.id, "code", acc.replace(/\s+$/, "") + "\n");
        setPreview(null);
        setOpen(false);
        setInstruction("");
      }
    } catch (e) {
      const err = e as Error;
      if (err.name !== "AbortError") setError(err.message || String(e));
      setPreview(null);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  if (!open) {
    return (
      <div className="ai-row">
        <button className="ai-toggle" onClick={() => setOpen(true)} title="AI assist">
          ✨ AI
        </button>
      </div>
    );
  }

  return (
    <div className="ai-bar">
      <div className="ai-controls">
        <input
          className="ai-input"
          placeholder="Describe code to generate…"
          value={instruction}
          disabled={busy}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run("generate")}
        />
        <button
          className="ai-generate"
          onClick={() => run("generate")}
          disabled={busy || !instruction.trim()}
        >
          Generate
        </button>
        <button className="ai-explain" onClick={() => run("explain")} disabled={busy}>
          Explain
        </button>
        {hasError && (
          <button className="ai-fix" onClick={() => run("fix")} disabled={busy}>
            Fix error
          </button>
        )}
        {busy ? (
          <button className="ai-cancel" onClick={() => abortRef.current?.abort()}>
            Cancel
          </button>
        ) : (
          <button
            className="ai-close"
            onClick={() => {
              setOpen(false);
              setPreview(null);
              setError(null);
            }}
            title="Close"
          >
            ×
          </button>
        )}
      </div>

      {error && <div className="ai-error">{error}</div>}

      {preview &&
        (preview.mode === "text" ? (
          <div
            className="ai-preview text"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(preview.text || "…"),
            }}
          />
        ) : (
          <pre className="ai-preview code">{preview.text || "…"}</pre>
        ))}
    </div>
  );
}
