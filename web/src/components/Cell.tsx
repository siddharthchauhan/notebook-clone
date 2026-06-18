import { useState } from "react";
import { useStore, type CellState, type CellType } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import { Editor } from "./Editor";
import { OutputView } from "./outputs";
import { renderMarkdown } from "../lib/markdown";
import { stripAnsi } from "../lib/ansi";

export function Cell({ cellId, socket }: { cellId: string; socket: NotebookSocket }) {
  const cell = useStore((s) => s.cells.find((c) => c.id === cellId));
  const [inspect, setInspect] = useState<string | null>(null);
  if (!cell) return null;

  const run = () => {
    const state = useStore.getState();
    const latest = state.cells.find((c) => c.id === cellId);
    if (!latest) return;
    if (latest.cell_type === "markdown") {
      state.setRendered(cellId, true);
      return;
    }
    // Already running or waiting its turn — don't double-submit.
    if (latest.execution_state === "busy" || latest.execution_state === "queued") return;
    setInspect(null);
    state.clearOutputs(cellId);
    state.markQueued(cellId);
    socket.execute(cellId, latest.source);
  };

  const showRenderedMarkdown = cell.cell_type === "markdown" && cell.rendered;

  return (
    <div className={`cell ${cell.cell_type}`}>
      <CellToolbar cell={cell} onRun={run} />
      <div className="cell-body">
        {showRenderedMarkdown ? (
          <div
            className="markdown-rendered"
            title="Double-click to edit"
            onDoubleClick={() => useStore.getState().setRendered(cellId, false)}
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(cell.source || "*empty markdown cell*"),
            }}
          />
        ) : (
          <Editor
            cellId={cell.id}
            cellType={cell.cell_type}
            initialValue={cell.source}
            socket={socket}
            onRun={run}
            onInspect={cell.cell_type === "code" ? setInspect : undefined}
          />
        )}

        {inspect != null && (
          <div className="inspect-panel">
            <button className="inspect-close" onClick={() => setInspect(null)}>
              ×
            </button>
            <pre>{stripAnsi(inspect) || "(no documentation found)"}</pre>
          </div>
        )}

        {cell.cell_type === "code" && <OutputView outputs={cell.outputs} />}
      </div>
    </div>
  );
}

function CellToolbar({ cell, onRun }: { cell: CellState; onRun: () => void }) {
  const { addCell, deleteCell, moveCell, setCellType } = useStore.getState();

  const busy = cell.execution_state === "busy";
  const queued = cell.execution_state === "queued";
  const pending = busy || queued;

  const runLabel =
    cell.cell_type === "markdown"
      ? "▶ Render"
      : busy
        ? "Running…"
        : queued
          ? "Queued…"
          : "▶ Run";

  return (
    <div className="cell-toolbar">
      <button className="run-btn" onClick={onRun} disabled={pending}>
        {runLabel}
      </button>
      {cell.cell_type === "code" && (
        <span className="prompt">{pending ? "[*]" : cell.execution_count != null ? `[${cell.execution_count}]` : "[ ]"}</span>
      )}
      {busy && <span className="spinner" role="status" aria-label="busy" />}
      {queued && <span className="queued-tag">queued</span>}
      <span className="spacer" />
      <select
        className="type-select"
        value={cell.cell_type}
        onChange={(e) => setCellType(cell.id, e.target.value as CellType)}
        title="Cell type"
      >
        <option value="code">Code</option>
        <option value="markdown">Markdown</option>
      </select>
      <button onClick={() => moveCell(cell.id, -1)} title="Move up">
        ↑
      </button>
      <button onClick={() => moveCell(cell.id, 1)} title="Move down">
        ↓
      </button>
      <button onClick={() => addCell(cell.id, "code")} title="Add cell below">
        +
      </button>
      <button onClick={() => deleteCell(cell.id)} title="Delete cell">
        🗑
      </button>
    </div>
  );
}
