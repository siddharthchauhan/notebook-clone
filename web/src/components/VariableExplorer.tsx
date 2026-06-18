import { useCallback, useEffect, useState } from "react";
import { useStore } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import type { VariableInfo } from "../lib/protocol";
import { stripAnsi } from "../lib/ansi";

function asString(v: unknown): string {
  return typeof v === "string" ? v : Array.isArray(v) ? v.join("") : String(v ?? "");
}

// Lists the kernel's user-defined data variables. Refreshes on connect, on a
// manual button, and automatically whenever a cell finishes executing (detected
// via the summed execution counts changing — edits don't move that number).
// Click a variable to inspect its full value; filter by name; delete from the
// kernel namespace.
export function VariableExplorer({ socket }: { socket: NotebookSocket }) {
  const [vars, setVars] = useState<VariableInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [inspect, setInspect] = useState<{ name: string; text: string } | null>(null);
  const connected = useStore((s) => s.connected);
  const ranToken = useStore((s) =>
    s.cells.reduce((sum, c) => sum + (c.execution_count ?? 0), 0),
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setVars((await socket.variables()).variables);
    } catch {
      setVars([]);
    } finally {
      setBusy(false);
    }
  }, [socket]);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, ranToken, refresh]);

  const showInspect = async (name: string) => {
    if (inspect?.name === name) {
      setInspect(null);
      return;
    }
    setInspect({ name, text: "…" });
    try {
      const r = await socket.inspect(name, name.length);
      setInspect({
        name,
        text: r.found ? stripAnsi(asString(r.data["text/plain"])) : "(no info)",
      });
    } catch {
      setInspect({ name, text: "(inspect failed)" });
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    try {
      setVars((await socket.deleteVariable(name)).variables);
      if (inspect?.name === name) setInspect(null);
    } catch {
      /* best-effort */
    } finally {
      setBusy(false);
    }
  };

  const shown = (vars ?? []).filter((v) =>
    v.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="var-explorer">
      <div className="var-head">
        <span>
          Variables{vars ? ` (${shown.length}/${vars.length})` : ""}
        </span>
        <button className="var-refresh" onClick={() => void refresh()} disabled={busy}>
          {busy ? "…" : "↻"}
        </button>
      </div>

      <input
        className="var-filter"
        placeholder="Filter…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {vars && shown.length === 0 ? (
        <div className="var-empty">
          {vars.length === 0 ? "No variables yet — run a cell." : "No matches."}
        </div>
      ) : (
        <table className="var-table">
          <tbody>
            {shown.map((v) => (
              <tr key={v.name} className="var-row">
                <td className="var-name">
                  <button
                    className="var-inspect"
                    title="Inspect value"
                    onClick={() => void showInspect(v.name)}
                  >
                    {v.name}
                  </button>
                </td>
                <td className="var-type">
                  {v.type}
                  {v.size != null ? ` [${v.size}]` : ""}
                </td>
                <td className="var-repr" title={v.repr}>
                  {v.repr}
                </td>
                <td className="var-actions">
                  <button
                    className="var-del"
                    title="Delete from kernel"
                    onClick={() => void remove(v.name)}
                  >
                    🗑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {inspect && (
        <div className="var-inspect-panel">
          <div className="var-inspect-head">
            <span>{inspect.name}</span>
            <button onClick={() => setInspect(null)} title="Close">
              ×
            </button>
          </div>
          <pre>{inspect.text || "…"}</pre>
        </div>
      )}
    </div>
  );
}
