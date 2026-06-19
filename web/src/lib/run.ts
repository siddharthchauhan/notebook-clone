// Shared block execution: compile a block to the Python it runs, and run-all.
// One place so per-cell run, reactive re-run, run-all, and scheduled runs agree
// on how each block type executes.

import { generateConnectorCode } from "./connectors";
import { generateChartCode } from "./charts";
import { generateKpiCode } from "./kpi";
import { useStore, type CellMetadata, type CellState } from "./store";
import type { NotebookSocket } from "./ws";

// The Python a block runs: code as-is; SQL/chart/KPI compiled via their codegen.
// Returns null for blocks that don't execute (markdown, input).
export async function compileBlockCode(c: CellState): Promise<string | null> {
  const m = (c.metadata ?? {}) as CellMetadata;
  if (c.cell_type === "code") return c.source;
  if (c.cell_type === "sql") {
    const conn = m.connection ?? { type: "sqlite" as const };
    const params: Record<string, string> = { query: c.source, var: m.result_var || "df" };
    if (conn.type === "sqlalchemy") params.url = conn.url ?? "";
    else params.db_path = conn.db_path ?? "";
    return generateConnectorCode(
      conn.type === "sqlalchemy" ? "sqlalchemy" : "sqlite",
      params,
    );
  }
  if (c.cell_type === "chart") {
    return generateChartCode({
      df: m.df ?? "",
      chart_type: m.chart_type ?? "line",
      x: m.x ?? "",
      y: m.y ?? "",
      title: m.title ?? "",
    });
  }
  if (c.cell_type === "kpi") {
    return generateKpiCode({
      expression: m.expression ?? "",
      label: m.label ?? "",
      number_format: m.number_format ?? "",
    });
  }
  return null;
}

// Run every block top-to-bottom, each by its kind: markdown renders, inputs bind
// their variable, and executable blocks compile + run. The kernel serializes the
// shell channel, so order holds across the awaits.
export async function runAllCells(socket: NotebookSocket): Promise<void> {
  const cells = useStore.getState().cells;
  for (const cell of cells) {
    if (cell.cell_type === "markdown") {
      useStore.getState().setRendered(cell.id, true);
      continue;
    }
    if (cell.cell_type === "input") {
      const m = (cell.metadata ?? {}) as CellMetadata;
      const name = (m.var_name ?? "").trim();
      if (name) {
        try {
          await socket.setVariable(name, (m.value ?? "") as boolean | number | string);
        } catch {
          /* skip a failed bind */
        }
      }
      continue;
    }
    let code: string | null = null;
    try {
      code = await compileBlockCode(cell);
    } catch {
      code = null; // skip a misconfigured block
    }
    if (code == null) continue;
    const st = useStore.getState();
    st.clearOutputs(cell.id);
    st.markQueued(cell.id);
    socket.execute(cell.id, code);
  }
  useStore.getState().touchVariables();
}
