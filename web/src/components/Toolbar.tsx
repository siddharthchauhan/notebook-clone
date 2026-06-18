import { useStore } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import type { Checkpoint, KernelSpec } from "../lib/document";

interface ToolbarProps {
  socket: NotebookSocket;
  kernelSpecs: KernelSpec[];
  kernelName: string | null;
  onChangeKernel: (name: string) => void;
  saveState: "saved" | "saving" | "dirty";
  checkpoints: Checkpoint[];
  onCreateCheckpoint: () => void;
  onRestoreCheckpoint: (checkpointId: string) => void;
}

export function Toolbar({
  socket,
  kernelSpecs,
  kernelName,
  onChangeKernel,
  saveState,
  checkpoints,
  onCreateCheckpoint,
  onRestoreCheckpoint,
}: ToolbarProps) {
  const connected = useStore((s) => s.connected);
  const kernelStatus = useStore((s) => s.kernelStatus);

  const runAll = () => {
    const state = useStore.getState();
    for (const cell of state.cells) {
      if (cell.cell_type === "markdown") {
        state.setRendered(cell.id, true);
      } else {
        state.clearOutputs(cell.id);
        state.markQueued(cell.id);
        socket.execute(cell.id, cell.source);
      }
    }
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

      <div className="toolbar-group">
        <button onClick={runAll} title="Run all cells">⏩ Run all</button>
        <button onClick={() => socket.interrupt()} title="Interrupt the kernel">■ Interrupt</button>
        <button onClick={() => socket.restart()} title="Restart the kernel">⟳ Restart</button>
        <button onClick={() => useStore.getState().addCell(null, "code")} title="Add a code cell">+ Cell</button>
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
