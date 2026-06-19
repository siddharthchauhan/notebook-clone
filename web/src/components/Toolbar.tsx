import { useStore } from "../lib/store";
import { runAllCells } from "../lib/run";
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
  const appMode = useStore((s) => s.appMode);
  const autoRunMs = useStore((s) => s.autoRunMs);
  const peers = useStore((s) => s.peers);

  const runAll = () => void runAllCells(socket);

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

      <button
        className={`btn-appmode${appMode ? " on" : ""}`}
        onClick={() => useStore.getState().setAppMode(!appMode)}
        title={appMode ? "Back to editing" : "App view: hide code, show the dashboard (reactive)"}
      >
        {appMode ? "✎ Edit" : "📊 App"}
      </button>

      <div className="toolbar-group">
        <button onClick={runAll} title="Run all cells">⏩ Run all</button>
        <select
          className="autorun-select"
          value={autoRunMs}
          onChange={(e) => useStore.getState().setAutoRunMs(Number(e.target.value))}
          title="Auto-run the whole notebook on a schedule (live dashboards)"
        >
          <option value={0}>Auto-run: off</option>
          <option value={5000}>every 5s</option>
          <option value={30000}>every 30s</option>
          <option value={60000}>every 1m</option>
        </select>
        <button onClick={() => socket.interrupt()} title="Interrupt the kernel">■ Interrupt</button>
        <button onClick={() => socket.restart()} title="Restart the kernel">⟳ Restart</button>
        {!appMode && (
          <>
            <button className="btn-add-cell" onClick={() => useStore.getState().addCell(null, "code")} title="Add a code cell">+ Cell</button>
            <button className="btn-add-sql" onClick={() => useStore.getState().addCell(null, "sql")} title="Add a SQL block">+ SQL</button>
            <button className="btn-add-input" onClick={() => useStore.getState().addCell(null, "input")} title="Add an input block">+ Input</button>
            <button className="btn-add-chart" onClick={() => useStore.getState().addCell(null, "chart")} title="Add a chart block">+ Chart</button>
            <button className="btn-add-kpi" onClick={() => useStore.getState().addCell(null, "kpi")} title="Add a big-number block">+ KPI</button>
            <button
              className={`btn-reactive${reactive ? " on" : ""}`}
              onClick={() => useStore.getState().setReactive(!reactive)}
              title="Reactive mode: when a block changes, re-run the blocks that depend on it"
            >
              ⚡ Reactive{reactive ? " on" : ""}
            </button>
          </>
        )}
      </div>

      {!appMode && (
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
      )}

      {!appMode && (
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
      )}

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

      {peers.length > 1 && (
        <div className="presence" title={`${peers.length} viewers`}>
          {peers.slice(0, 5).map((p) => (
            <span
              key={p.client_id}
              className="presence-dot"
              style={{ background: p.color }}
              title={p.name}
            >
              {p.name.charAt(0).toUpperCase()}
            </span>
          ))}
        </div>
      )}

      <span className={`conn ${statusClass}`} title="Kernel status">
        ● {statusLabel}
      </span>
    </header>
  );
}
