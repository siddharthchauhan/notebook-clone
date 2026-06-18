import { useCallback, useEffect, useState } from "react";
import { useStore } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import type { VariableInfo } from "../lib/protocol";

// Lists the kernel's user-defined data variables. Refreshes on connect, on a
// manual button, and automatically whenever a cell finishes executing (detected
// via the summed execution counts changing — edits don't move that number).
export function VariableExplorer({ socket }: { socket: NotebookSocket }) {
  const [vars, setVars] = useState<VariableInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = useStore((s) => s.connected);
  const ranToken = useStore((s) =>
    s.cells.reduce((sum, c) => sum + (c.execution_count ?? 0), 0),
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const reply = await socket.variables();
      setVars(reply.variables);
    } catch {
      setVars([]);
    } finally {
      setBusy(false);
    }
  }, [socket]);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, ranToken, refresh]);

  return (
    <div className="var-explorer">
      <div className="var-head">
        <span>Variables{vars ? ` (${vars.length})` : ""}</span>
        <button className="var-refresh" onClick={() => void refresh()} disabled={busy}>
          {busy ? "…" : "↻"}
        </button>
      </div>
      {vars && vars.length === 0 ? (
        <div className="var-empty">No variables yet — run a cell.</div>
      ) : (
        <table className="var-table">
          <tbody>
            {(vars ?? []).map((v) => (
              <tr key={v.name} className="var-row">
                <td className="var-name">{v.name}</td>
                <td className="var-type">
                  {v.type}
                  {v.size != null ? ` [${v.size}]` : ""}
                </td>
                <td className="var-repr" title={v.repr}>
                  {v.repr}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
