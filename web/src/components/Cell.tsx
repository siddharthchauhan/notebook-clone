import { useStore } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import { Editor } from "./Editor";
import { OutputView } from "./outputs";

interface CellProps {
  cellId: string;
  socket: NotebookSocket;
}

export function Cell({ cellId, socket }: CellProps) {
  const cell = useStore((s) => s.cells.find((c) => c.id === cellId));
  if (!cell) return null;

  const busy = cell.execution_state === "busy";

  const run = () => {
    const state = useStore.getState();
    const latest = state.cells.find((c) => c.id === cellId);
    if (!latest || latest.execution_state === "busy") return;
    // Clear prior outputs at submit time, then send the current source.
    state.clearOutputs(cellId);
    socket.execute(cellId, latest.source);
  };

  return (
    <div className="cell">
      <div className="cell-toolbar">
        <button className="run-btn" onClick={run} disabled={busy}>
          {busy ? "Running…" : "▶ Run"}
        </button>
        {busy && <span className="spinner" role="status" aria-label="busy" />}
        <span className="hint">Shift+Enter to run</span>
      </div>
      <Editor cellId={cellId} initialValue={cell.source} onRun={run} />
      <OutputView outputs={cell.outputs} />
    </div>
  );
}
