import { useStore } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import type { KernelSpec } from "../lib/document";

interface ToolbarProps {
  socket: NotebookSocket;
  kernelSpecs: KernelSpec[];
  kernelName: string | null;
  onChangeKernel: (name: string) => void;
  saveState: "saved" | "saving" | "dirty";
}

export function Toolbar({
  socket,
  kernelSpecs,
  kernelName,
  onChangeKernel,
  saveState,
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
        socket.execute(cell.id, cell.source);
      }
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
        <button onClick={runAll} title="Run all cells">
          ⏩ Run all
        </button>
        <button onClick={() => socket.interrupt()} title="Interrupt the kernel">
          ■ Interrupt
        </button>
        <button onClick={() => socket.restart()} title="Restart the kernel">
          ⟳ Restart
        </button>
        <button
          onClick={() => useStore.getState().addCell(null, "code")}
          title="Add a code cell at the end"
        >
          + Cell
        </button>
      </div>

      <span className="spacer" />

      <label className="kernel-picker">
        Kernel:{" "}
        <select
          value={kernelName ?? ""}
          onChange={(e) => onChangeKernel(e.target.value)}
          disabled={kernelSpecs.length <= 1}
          title={
            kernelSpecs.length <= 1
              ? "Only one kernel available"
              : "Switch kernel (restarts the session)"
          }
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
