// Reactive execution: when a block changes, re-run the blocks downstream of it.
//
// Dependencies come from each block's read/write sets. Code cells are analyzed
// server-side (Python AST at /api/analyze); SQL and input blocks declare their
// single write (result var / bound variable) from metadata. A block B is
// downstream of A when B reads a name A writes — computed transitively, in
// notebook order, so a chain A → B → C re-runs in order.

import { useStore, type CellState, type CellMetadata } from "./store";
import { compileBlockCode } from "./run";
import type { NotebookSocket } from "./ws";

export interface Deps {
  reads: string[];
  writes: string[];
}

export async function analyzeCells(cells: CellState[]): Promise<Map<string, Deps>> {
  // Code cells and KPI expressions are Python — analyze them for reads/writes via
  // the AST endpoint. Other blocks' reads/writes are known from their metadata.
  const codeCells = cells
    .filter((c) => c.cell_type === "code" || c.cell_type === "kpi")
    .map((c) => ({
      id: c.id,
      source:
        c.cell_type === "kpi"
          ? ((c.metadata?.expression as string) ?? "")
          : c.source,
    }));

  const serverDeps: Record<string, Deps> = {};
  if (codeCells.length) {
    try {
      const r = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cells: codeCells }),
      });
      if (r.ok) {
        const data = (await r.json()) as { cells: Array<{ id: string } & Deps> };
        for (const d of data.cells) serverDeps[d.id] = { reads: d.reads, writes: d.writes };
      }
    } catch {
      /* analysis unavailable → treat code cells as dependency-free */
    }
  }

  const map = new Map<string, Deps>();
  for (const c of cells) {
    const m = (c.metadata ?? {}) as CellMetadata;
    if (c.cell_type === "code") {
      map.set(c.id, serverDeps[c.id] ?? { reads: [], writes: [] });
    } else if (c.cell_type === "sql") {
      map.set(c.id, { reads: [], writes: [m.result_var || "df"] });
    } else if (c.cell_type === "input") {
      const v = (m.var_name ?? "").trim();
      map.set(c.id, { reads: [], writes: v ? [v] : [] });
    } else if (c.cell_type === "chart") {
      // A chart reads its source DataFrame, so it re-runs when that frame changes.
      const d = (m.df ?? "").trim();
      map.set(c.id, { reads: d ? [d] : [], writes: [] });
    } else if (c.cell_type === "kpi") {
      // A KPI reads the names in its expression (analyzed above); it writes none.
      map.set(c.id, { reads: serverDeps[c.id]?.reads ?? [], writes: [] });
    } else {
      map.set(c.id, { reads: [], writes: [] });
    }
  }
  return map;
}

// Cells after `changedId` that (transitively) read a name it writes, in order.
export function downstreamOf(
  changedId: string,
  cells: CellState[],
  deps: Map<string, Deps>,
): string[] {
  const idx = cells.findIndex((c) => c.id === changedId);
  if (idx < 0) return [];
  const dirty = new Set(deps.get(changedId)?.writes ?? []);
  if (dirty.size === 0) return [];

  const out: string[] = [];
  for (let i = idx + 1; i < cells.length; i++) {
    const c = cells[i];
    const d = deps.get(c.id);
    if (!d) continue;
    if (d.reads.some((n) => dirty.has(n))) {
      out.push(c.id);
      for (const w of d.writes) dirty.add(w); // propagate down the chain
    }
  }
  return out;
}

// Re-run everything downstream of `changedId` (no-op unless reactive mode is on).
// Cells are enqueued in notebook order; the kernel runs the shell channel FIFO,
// so the just-triggered block lands before its dependents.
export async function reactiveRerun(
  changedId: string,
  socket: NotebookSocket,
): Promise<void> {
  if (!useStore.getState().reactive) return;
  const cells = useStore.getState().cells;
  const deps = await analyzeCells(cells);
  const ids = downstreamOf(changedId, cells, deps);
  for (const id of ids) {
    const cell = useStore.getState().cells.find((c) => c.id === id);
    if (!cell) continue;
    const code = await compileBlockCode(cell);
    if (code == null) continue;
    const st = useStore.getState();
    st.clearOutputs(id);
    st.markQueued(id);
    socket.execute(id, code);
  }
}
