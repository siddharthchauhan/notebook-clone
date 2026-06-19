import { useCallback, useEffect, useState } from "react";
import { useStore } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import type { VariableChild, VariableInfo } from "../lib/protocol";
import { stripAnsi } from "../lib/ansi";

function asString(v: unknown): string {
  return typeof v === "string" ? v : Array.isArray(v) ? v.join("") : String(v ?? "");
}

// Container types whose direct children the explorer can expand inline.
const EXPANDABLE = new Set(["dict", "list", "tuple", "set", "frozenset"]);

type SortKey = "name" | "type" | "size";
type ChildState = VariableChild[] | "loading" | "error";

function sortVal(v: VariableInfo, key: SortKey): string | number {
  if (key === "size") {
    const n = parseInt(v.size ?? "", 10);
    return Number.isNaN(n) ? -1 : n;
  }
  return (v[key] ?? "").toLowerCase();
}

// Lists the kernel's user-defined data variables. Refreshes on connect, on a
// manual button, and automatically whenever a cell finishes executing (detected
// via the summed execution counts changing — edits don't move that number).
// Click a name to inspect its full value; filter by name; sort by any column;
// expand a container to see its children; delete from the kernel namespace.
export function VariableExplorer({ socket }: { socket: NotebookSocket }) {
  const [vars, setVars] = useState<VariableInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [inspect, setInspect] = useState<{ name: string; text: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, ChildState>>({});
  const connected = useStore((s) => s.connected);
  const ranToken = useStore((s) =>
    s.cells.reduce((sum, c) => sum + (c.execution_count ?? 0), 0),
  );
  // Input blocks bind globals without advancing [n], so they signal refresh here.
  const variablesRevision = useStore((s) => s.variablesRevision);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setVars((await socket.variables()).variables);
      setExpanded({}); // values may have changed; drop stale child rows
    } catch {
      setVars([]);
    } finally {
      setBusy(false);
    }
  }, [socket]);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, ranToken, variablesRevision, refresh]);

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

  const toggleExpand = async (name: string) => {
    if (name in expanded) {
      setExpanded((e) => {
        const next = { ...e };
        delete next[name];
        return next;
      });
      return;
    }
    setExpanded((e) => ({ ...e, [name]: "loading" }));
    try {
      const r = await socket.variableChildren(name);
      setExpanded((e) => ({ ...e, [name]: r.children }));
    } catch {
      setExpanded((e) => ({ ...e, [name]: "error" }));
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

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));

  const shown = (vars ?? [])
    .filter((v) => v.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
      const x = sortVal(a, sort.key);
      const y = sortVal(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });

  const arrow = (key: SortKey) => (sort.key !== key ? "" : sort.dir === 1 ? " ▲" : " ▼");
  const th = (key: SortKey, label: string) => (
    <th
      className={`var-th ${sort.key === key ? "sorted" : ""}`}
      aria-sort={sort.key !== key ? "none" : sort.dir === 1 ? "ascending" : "descending"}
      onClick={() => toggleSort(key)}
    >
      {label}
      {arrow(key)}
    </th>
  );

  return (
    <div className="var-explorer">
      <div className="var-head">
        <span>Variables{vars ? ` (${shown.length}/${vars.length})` : ""}</span>
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
          <thead>
            <tr>
              {th("name", "Name")}
              {th("type", "Type")}
              <th>Value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => {
              const canExpand = EXPANDABLE.has(v.type);
              const open = v.name in expanded;
              const children = expanded[v.name];
              return [
                <tr key={v.name} className="var-row">
                  <td className="var-name">
                    {canExpand ? (
                      <button
                        className="var-expand"
                        title={open ? "Collapse" : "Expand"}
                        onClick={() => void toggleExpand(v.name)}
                      >
                        {open ? "▾" : "▸"}
                      </button>
                    ) : (
                      <span className="var-expand-spacer" />
                    )}
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
                </tr>,
                open && (
                  <tr key={`${v.name}:children`} className="var-children">
                    <td colSpan={4}>
                      {children === "loading" ? (
                        <div className="var-child-note">loading…</div>
                      ) : children === "error" || children === undefined ? (
                        <div className="var-child-note">(could not read)</div>
                      ) : children.length === 0 ? (
                        <div className="var-child-note">(empty)</div>
                      ) : (
                        <table className="var-child-table">
                          <tbody>
                            {children.map((c, i) => (
                              <tr key={i} className="var-child-row">
                                <td className="var-key">{c.key}</td>
                                <td className="var-type">
                                  {c.type}
                                  {c.size != null ? ` [${c.size}]` : ""}
                                </td>
                                <td className="var-repr" title={c.repr}>
                                  {c.repr}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                ),
              ];
            })}
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
