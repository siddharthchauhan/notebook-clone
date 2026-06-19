import { useStore, type CellMetadata, type SqlConnection } from "../lib/store";
import { generateConnectorCode } from "../lib/connectors";
import type { NotebookSocket } from "../lib/ws";
import type { Checkpoint, KernelSpec } from "../lib/document";
import type { PanelTab } from "./SidePanel";

interface ToolbarProps {
  socket: NotebookSocket;
  notebookId: string;
  kernelSpecs: KernelSpec[];
  kernelName: string | null;
  onChangeKernel: (name: string) => void;
  saveState: "saved" | "saving" | "dirty";
  checkpoints: Checkpoint[];
  onCreateCheckpoint: () => void;
  onRestoreCheckpoint: (checkpointId: string) => void;
  onToggleBrowser: () => void;
  onTogglePanel: (tab: PanelTab) => void;
  onExport: (fmt: "ipynb" | "html") => void;
}

export function Toolbar({
  socket,
  notebookId,
  kernelSpecs,
  kernelName,
  onChangeKernel,
  saveState,
  checkpoints,
  onCreateCheckpoint,
  onRestoreCheckpoint,
  onToggleBrowser,
  onTogglePanel,
  onExport,
}: ToolbarProps) {
  const connected = useStore((s) => s.connected);
  const kernelStatus = useStore((s) => s.kernelStatus);
  const aiAvailable = useStore((s) => s.aiAvailable);
  const reactive = useStore((s) => s.reactive);

  // Run every block top-to-bottom, each by its kind: markdown renders, inputs
  // bind their variable, SQL compiles to pandas, code runs as-is. The kernel
  // serializes the shell channel, so order is preserved across the awaits.
  const runAll = async () => {
    const state = useStore.getState();
    for (const cell of state.cells) {
      const m = (cell.metadata ?? {}) as CellMetadata;
      if (cell.cell_type === "markdown") {
        state.setRendered(cell.id, true);
      } else if (cell.cell_type === "input") {
        const name = (m.var_name ?? "").trim();
        if (name) {
          try {
            await socket.setVariable(name, (m.value ?? "") as boolean | number | string);
          } catch {
            /* skip a failed bind */
          }
        }
      } else if (cell.cell_type === "sql") {
        const conn: SqlConnection = m.connection ?? { type: "sqlite" };
        const params: Record<string, string> = { query: cell.source, var: m.result_var || "df" };
        if (conn.type === "sqlalchemy") params.url = conn.url ?? "";
        else params.db_path = conn.db_path ?? "";
        try {
          const code = await generateConnectorCode(
            conn.type === "sqlalchemy" ? "sqlalchemy" : "sqlite",
            params,
          );
          state.clearOutputs(cell.id);
          state.markQueued(cell.id);
          socket.execute(cell.id, code);
        } catch {
          /* skip a misconfigured SQL block */
        }
      } else {
        state.clearOutputs(cell.id);
        state.markQueued(cell.id);
        socket.execute(cell.id, cell.source);
      }
    }
    useStore.getState().touchVariables();
  };

  const restore = (id: string) => {
    if (!id) return;
    if (window.confirm("Restore this checkpoint? Current cells will be replaced.")) {
      onRestoreCheckpoint(id);
    }
  };

  const statusLabel = !connected
    ? "disconnected"
    : kernelStatus === "restarting"
      ? "restarting…"
      : kernelStatus === "ready"
        ? "ready"
        : kernelStatus;
  const statusClass = connected && kernelStatus === "ready" ? "ok" : "warn";

  return (
    <header className="toolbar">
      <strong className="brand">Notebook Clone</strong>

      <button className="btn-notebooks" onClick={onToggleBrowser} title="Browse notebooks">
        ☰ {notebookId}
      </button>

      <div className="toolbar-group">
        <button onClick={runAll} title="Run all cells">⏩ Run all</button>
        <button onClick={() => socket.interrupt()} title="Interrupt the kernel">■ Interrupt</button>
        <button onClick={() => socket.restart()} title="Restart the kernel">⟳ Restart</button>
        <button className="btn-add-cell" onClick={() => useStore.getState().addCell(null, "code")} title="Add a code cell">+ Cell</button>
        <button className="btn-add-sql" onClick={() => useStore.getState().addCell(null, "sql")} title="Add a SQL block">+ SQL</button>
        <button className="btn-add-input" onClick={() => useStore.getState().addCell(null, "input")} title="Add an input block">+ Input</button>
        <button
          className={`btn-reactive${reactive ? " on" : ""}`}
          onClick={() => useStore.getState().setReactive(!reactive)}
          title="Reactive mode: when a block changes, re-run the blocks that depend on it"
        >
          ⚡ Reactive{reactive ? " on" : ""}
        </button>
      </div>

      <div className="toolbar-group">
        <button onClick={onCreateCheckpoint} title="Save a checkpoint">⚑ Checkpoint</button>
        <select
          className="restore-select"
          value=""
          onChange={(e) => restore(e.target.value)}
          disabled={checkpoints.length === 0}
          title="Restore a checkpoint"
        >
          <option value="">{checkpoints.length ? "Restore…" : "No checkpoints"}</option>
          {checkpoints.map((c) => (
            <option key={c.id} value={c.id}>
              {new Date(c.last_modified).toLocaleString()}
            </option>
          ))}
        </select>
        <select
          className="export-select"
          value=""
          onChange={(e) => {
            if (e.target.value) onExport(e.target.value as "ipynb" | "html");
          }}
          title="Export this notebook"
        >
          <option value="">Export…</option>
          <option value="ipynb">.ipynb</option>
          <option value="html">HTML</option>
        </select>
      </div>

      <div className="toolbar-group">
        <button className="btn-variables" onClick={() => onTogglePanel("variables")} title="Variable explorer">
          🔎 Variables
        </button>
        <button className="btn-data" onClick={() => onTogglePanel("data")} title="Load data">
          🔌 Data
        </button>
        {aiAvailable && (
          <button className="btn-chat" onClick={() => onTogglePanel("chat")} title="AI chat">
            ✨ Chat
          </button>
        )}
      </div>

      <span className="spacer" />

      <label className="kernel-picker">
        Kernel:{" "}
        <select
          value={kernelName ?? ""}
          onChange={(e) => onChangeKernel(e.target.value)}
          disabled={kernelSpecs.length <= 1}
          title={kernelSpecs.length <= 1 ? "Only one kernel available" : "Switch kernel (restarts the session)"}
        >
          {kernelSpecs.map((k) => (
            <option key={k.name} value={k.name}>
              {k.display_name}
            </option>
          ))}
        </select>
      </label>

      <span className={`save-state ${saveState}`}>
        {saveState === "saving" ? "saving…" : saveState === "dirty" ? "unsaved" : "saved"}
      </span>

      <span className={`conn ${statusClass}`} title="Kernel status">
        ● {statusLabel}
      </span>
    </header>
  );
}
