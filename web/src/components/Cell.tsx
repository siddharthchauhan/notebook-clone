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

  const busy = cell.execution_state === "busy";

  const run = () => {
    const state = useStore.getState();
    const latest = state.cells.find((c) => c.id === cellId);
    if (!latest) return;
    if (latest.cell_type === "markdown") {
      state.setRendered(cellId, true);
      return;
    }
    if (latest.execution_state === "busy") return;
    setInspect(null);
    state.clearOutputs(cellId);
    socket.execute(cellId, latest.source);
  };

  const showRenderedMarkdown = cell.cell_type === "markdown" && cell.rendered;

  return (
    <div className={`cell ${cell.cell_type}`}>
      <CellToolbar cell={cell} busy={busy} onRun={run} />
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

function CellToolbar({
  cell,
  busy,
  onRun,
}: {
  cell: CellState;
  busy: boolean;
  onRun: () => void;
}) {
  const { addCell, deleteCell, moveCell, setCellType } = useStore.getState();

  const prompt = busy
    ? "[*]"
    : cell.execution_count != null
      ? `[${cell.execution_count}]`
      : "[ ]";

  return (
    <div className="cell-toolbar">
      <button className="run-btn" onClick={onRun} disabled={busy}>
        {cell.cell_type === "markdown" ? "▶ Render" : busy ? "Running…" : "▶ Run"}
      </button>
      {cell.cell_type === "code" && <span className="prompt">{prompt}</span>}
      {busy && <span className="spinner" role="status" aria-label="busy" />}
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
