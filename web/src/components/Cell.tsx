import { useState } from "react";
import {
  useStore,
  type CellMetadata,
  type CellState,
  type CellType,
  type SqlConnection,
} from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import { Editor } from "./Editor";
import { OutputView } from "./outputs";
import { AiAssist } from "./AiAssist";
import { generateConnectorCode } from "../lib/connectors";
import { renderMarkdown } from "../lib/markdown";
import { stripAnsi } from "../lib/ansi";

export function Cell({ cellId, socket }: { cellId: string; socket: NotebookSocket }) {
  const cell = useStore((s) => s.cells.find((c) => c.id === cellId));
  const [inspect, setInspect] = useState<string | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  if (!cell) return null;

  // A SQL block compiles to pandas code (via the connectors endpoint) and runs
  // through the normal execute path, so its DataFrame renders like any output.
  const runSql = async () => {
    const latest = useStore.getState().cells.find((c) => c.id === cellId);
    if (!latest) return;
    if (latest.execution_state === "busy" || latest.execution_state === "queued") return;
    const meta = (latest.metadata ?? {}) as CellMetadata;
    const conn: SqlConnection = meta.connection ?? { type: "sqlite" };
    const params: Record<string, string> = {
      query: latest.source,
      var: meta.result_var || "df",
    };
    let connType: string;
    if (conn.type === "sqlalchemy") {
      connType = "sqlalchemy";
      params.url = conn.url ?? "";
    } else {
      connType = "sqlite";
      params.db_path = conn.db_path ?? "";
    }
    setSqlError(null);
    try {
      const code = await generateConnectorCode(connType, params);
      const st = useStore.getState();
      st.clearOutputs(cellId);
      st.markQueued(cellId);
      socket.execute(cellId, code);
    } catch (e) {
      setSqlError(e instanceof Error ? e.message : "could not run query");
    }
  };

  const run = () => {
    const state = useStore.getState();
    const latest = state.cells.find((c) => c.id === cellId);
    if (!latest) return;
    if (latest.cell_type === "markdown") {
      state.setRendered(cellId, true);
      return;
    }
    if (latest.cell_type === "sql") {
      void runSql();
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
        {cell.cell_type === "sql" && (
          <SqlConfig cellId={cell.id} metadata={cell.metadata} />
        )}

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

        {sqlError && <div className="sql-error">{sqlError}</div>}

        {inspect != null && (
          <div className="inspect-panel">
            <button className="inspect-close" onClick={() => setInspect(null)}>
              ×
            </button>
            <pre>{stripAnsi(inspect) || "(no documentation found)"}</pre>
          </div>
        )}

        {cell.cell_type !== "markdown" && (
          <OutputView outputs={cell.outputs} manager={socket.widgets} />
        )}

        <AiAssist cell={cell} />
      </div>
    </div>
  );
}

// The SQL block's connection picker + target-variable field. Editing updates the
// cell's block metadata (persisted in the .ipynb under cell metadata).
function SqlConfig({
  cellId,
  metadata,
}: {
  cellId: string;
  metadata?: CellMetadata;
}) {
  const conn: SqlConnection = metadata?.connection ?? { type: "sqlite" };
  const resultVar = metadata?.result_var ?? "df";
  const set = (patch: CellMetadata) =>
    useStore.getState().setCellMetadata(cellId, patch);

  return (
    <div className="sql-config">
      <select
        className="sql-conn-type"
        value={conn.type}
        onChange={(e) =>
          set({ connection: { type: e.target.value as SqlConnection["type"] } })
        }
        title="Data source"
      >
        <option value="sqlite">SQLite file</option>
        <option value="sqlalchemy">SQLAlchemy URL</option>
      </select>
      <input
        className="sql-conn-param"
        placeholder={
          conn.type === "sqlalchemy" ? "postgresql://user:pass@host/db" : "data.db"
        }
        value={(conn.type === "sqlalchemy" ? conn.url : conn.db_path) ?? ""}
        onChange={(e) =>
          set({
            connection:
              conn.type === "sqlalchemy"
                ? { type: "sqlalchemy", url: e.target.value }
                : { type: "sqlite", db_path: e.target.value },
          })
        }
      />
      <span className="sql-into">→</span>
      <input
        className="sql-var"
        title="Result DataFrame variable"
        value={resultVar}
        onChange={(e) => set({ result_var: e.target.value })}
      />
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
      {cell.cell_type !== "markdown" && (
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
        <option value="sql">SQL</option>
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
