import { useEffect, useState } from "react";
import {
  useStore,
  type CellMetadata,
  type CellState,
  type CellType,
  type InputType,
  type SqlConnection,
} from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import { Editor } from "./Editor";
import { OutputView } from "./outputs";
import { AiAssist } from "./AiAssist";
import { generateConnectorCode } from "../lib/connectors";
import { generateChartCode, CHART_TYPES } from "../lib/charts";
import { generateKpiCode } from "../lib/kpi";
import { reactiveRerun } from "../lib/reactive";
import { renderMarkdown } from "../lib/markdown";
import { stripAnsi } from "../lib/ansi";

// Code, SQL, chart, and KPI blocks run code and show an [n] prompt + outputs.
function isExecutable(t: CellType): boolean {
  return t === "code" || t === "sql" || t === "chart" || t === "kpi";
}

// Bind an input block's variable in the kernel from its current metadata. Runs
// silently (store_history=False server-side), so it never advances [n]; we nudge
// the variable explorer to refresh afterward.
async function bindInput(cellId: string, socket: NotebookSocket) {
  const cell = useStore.getState().cells.find((c) => c.id === cellId);
  const m = (cell?.metadata ?? {}) as CellMetadata;
  const name = (m.var_name ?? "").trim();
  if (!name) return;
  try {
    await socket.setVariable(name, (m.value ?? "") as boolean | number | string);
    useStore.getState().touchVariables();
    void reactiveRerun(cellId, socket); // re-run cells that read this variable
  } catch {
    /* a failed bind is non-fatal; the next change retries */
  }
}

export function Cell({ cellId, socket }: { cellId: string; socket: NotebookSocket }) {
  const cell = useStore((s) => s.cells.find((c) => c.id === cellId));
  const appMode = useStore((s) => s.appMode);
  const [inspect, setInspect] = useState<string | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  if (!cell) return null;

  // App view: drop the editor + chrome; show only what an app would — rendered
  // markdown, live input controls, and block outputs (charts, tables, prints).
  if (appMode) return <AppCell cell={cell} socket={socket} />;

  // A chart block compiles to matplotlib (via /api/charts) and runs through the
  // normal execute path, so the figure renders inline like any plot.
  const runChart = async () => {
    const latest = useStore.getState().cells.find((c) => c.id === cellId);
    if (!latest) return;
    if (latest.execution_state === "busy" || latest.execution_state === "queued") return;
    const m = (latest.metadata ?? {}) as CellMetadata;
    setChartError(null);
    try {
      const code = await generateChartCode({
        df: m.df ?? "",
        chart_type: m.chart_type ?? "line",
        x: m.x ?? "",
        y: m.y ?? "",
        title: m.title ?? "",
      });
      const st = useStore.getState();
      st.clearOutputs(cellId);
      st.markQueued(cellId);
      socket.execute(cellId, code);
      void reactiveRerun(cellId, socket);
    } catch (e) {
      setChartError(e instanceof Error ? e.message : "could not render chart");
    }
  };

  // A KPI block evaluates an expression and renders a big number (HTML output).
  const runKpi = async () => {
    const latest = useStore.getState().cells.find((c) => c.id === cellId);
    if (!latest) return;
    if (latest.execution_state === "busy" || latest.execution_state === "queued") return;
    const m = (latest.metadata ?? {}) as CellMetadata;
    setChartError(null);
    try {
      const code = await generateKpiCode({
        expression: m.expression ?? "",
        label: m.label ?? "",
        number_format: m.number_format ?? "",
      });
      const st = useStore.getState();
      st.clearOutputs(cellId);
      st.markQueued(cellId);
      socket.execute(cellId, code);
      void reactiveRerun(cellId, socket);
    } catch (e) {
      setChartError(e instanceof Error ? e.message : "could not render KPI");
    }
  };

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
      void reactiveRerun(cellId, socket); // re-run cells that read this DataFrame
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
    if (latest.cell_type === "input") {
      void bindInput(cellId, socket);
      return;
    }
    if (latest.cell_type === "chart") {
      void runChart();
      return;
    }
    if (latest.cell_type === "kpi") {
      void runKpi();
      return;
    }
    // Already running or waiting its turn — don't double-submit.
    if (latest.execution_state === "busy" || latest.execution_state === "queued") return;
    setInspect(null);
    state.clearOutputs(cellId);
    state.markQueued(cellId);
    socket.execute(cellId, latest.source);
    void reactiveRerun(cellId, socket); // re-run dependents of this cell's writes
  };

  const showRenderedMarkdown = cell.cell_type === "markdown" && cell.rendered;

  return (
    <div className={`cell ${cell.cell_type}`}>
      <CellToolbar cell={cell} onRun={run} />
      <div className="cell-body">
        {cell.cell_type === "sql" && (
          <SqlConfig cellId={cell.id} metadata={cell.metadata} />
        )}

        {cell.cell_type === "input" ? (
          <InputBlock cellId={cell.id} metadata={cell.metadata} socket={socket} />
        ) : cell.cell_type === "chart" ? (
          <ChartConfig cellId={cell.id} metadata={cell.metadata} socket={socket} />
        ) : cell.cell_type === "kpi" ? (
          <KpiConfig cellId={cell.id} metadata={cell.metadata} />
        ) : showRenderedMarkdown ? (
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
        {chartError && <div className="sql-error">{chartError}</div>}

        {inspect != null && (
          <div className="inspect-panel">
            <button className="inspect-close" onClick={() => setInspect(null)}>
              ×
            </button>
            <pre>{stripAnsi(inspect) || "(no documentation found)"}</pre>
          </div>
        )}

        {isExecutable(cell.cell_type) && (
          <OutputView outputs={cell.outputs} manager={socket.widgets} />
        )}

        <AiAssist cell={cell} />
      </div>
    </div>
  );
}

// Presentation view of one cell: markdown reads as prose, inputs stay
// interactive, and executable blocks show only their output. Cells with nothing
// to present (e.g. an empty or output-less code cell) render nothing.
function AppCell({ cell, socket }: { cell: CellState; socket: NotebookSocket }) {
  if (cell.cell_type === "markdown") {
    if (!cell.source.trim()) return null;
    return (
      <div className="app-cell markdown">
        <div
          className="markdown-rendered"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(cell.source) }}
        />
      </div>
    );
  }
  if (cell.cell_type === "input") {
    return (
      <div className="app-cell input">
        <InputBlock cellId={cell.id} metadata={cell.metadata} socket={socket} compact />
      </div>
    );
  }
  // code / sql / chart: present the output, or nothing if there isn't one yet.
  if (!cell.outputs.length) return null;
  return (
    <div className={`app-cell ${cell.cell_type}`}>
      <OutputView outputs={cell.outputs} manager={socket.widgets} />
    </div>
  );
}

// The SQL block's connection picker + target-variable field. Editing updates the
// cell's block metadata (persisted in the .ipynb under cell metadata).
function SqlConfig({ cellId, metadata }: { cellId: string; metadata?: CellMetadata }) {
  const conn: SqlConnection = metadata?.connection ?? { type: "sqlite" };
  const resultVar = metadata?.result_var ?? "df";
  const set = (patch: CellMetadata) => useStore.getState().setCellMetadata(cellId, patch);

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

// A no-code input block: a control (text/slider/select/checkbox) bound to a
// kernel global. Editing the control binds the variable immediately.
function defaultValueFor(t: InputType): boolean | number | string {
  if (t === "checkbox") return false;
  if (t === "slider") return 0;
  return "";
}

function InputBlock({
  cellId,
  metadata,
  socket,
  compact = false,
}: {
  cellId: string;
  metadata?: CellMetadata;
  socket: NotebookSocket;
  compact?: boolean;
}) {
  const m = metadata ?? {};
  const inputType = (m.input_type ?? "text") as InputType;
  const varName = m.var_name ?? "x";
  const options = m.options ?? [];
  const set = (patch: CellMetadata) => useStore.getState().setCellMetadata(cellId, patch);
  // Update the metadata, then push the new value into the kernel.
  const apply = (patch: CellMetadata) => {
    set(patch);
    void bindInput(cellId, socket);
  };
  const commit = () => void bindInput(cellId, socket);

  let control: React.ReactNode;
  if (inputType === "checkbox") {
    control = (
      <input
        className="input-checkbox"
        type="checkbox"
        checked={Boolean(m.value)}
        onChange={(e) => apply({ value: e.target.checked })}
      />
    );
  } else if (inputType === "slider") {
    control = (
      <input
        className="input-slider"
        type="range"
        min={m.min ?? 0}
        max={m.max ?? 100}
        step={m.step ?? 1}
        value={Number(m.value ?? 0)}
        onChange={(e) => set({ value: Number(e.target.value) })}
        onMouseUp={commit}
        onKeyUp={commit}
      />
    );
  } else if (inputType === "select") {
    control = (
      <select
        className="input-select"
        value={String(m.value ?? "")}
        onChange={(e) => apply({ value: e.target.value })}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        className="input-text"
        type="text"
        value={String(m.value ?? "")}
        onChange={(e) => set({ value: e.target.value })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    );
  }

  // App view shows just a labeled control — no type/variable/range editors.
  if (compact) {
    return (
      <div className="input-block compact">
        <label className="input-label">{varName}</label>
        <div className="input-control">
          {control}
          <code className="input-value">{JSON.stringify(m.value ?? null)}</code>
        </div>
      </div>
    );
  }

  return (
    <div className="input-block">
      <div className="input-config">
        <select
          className="input-type-select"
          value={inputType}
          onChange={(e) => {
            const next = e.target.value as InputType;
            apply({ input_type: next, value: defaultValueFor(next) });
          }}
          title="Input type"
        >
          <option value="text">Text</option>
          <option value="slider">Slider</option>
          <option value="select">Select</option>
          <option value="checkbox">Checkbox</option>
        </select>
        <input
          className="input-var"
          title="Variable name"
          value={varName}
          onChange={(e) => set({ var_name: e.target.value })}
          onBlur={commit}
        />
        {inputType === "slider" && (
          <span className="input-range-cfg">
            <input
              className="input-min"
              type="number"
              title="min"
              value={m.min ?? 0}
              onChange={(e) => set({ min: Number(e.target.value) })}
            />
            <input
              className="input-max"
              type="number"
              title="max"
              value={m.max ?? 100}
              onChange={(e) => set({ max: Number(e.target.value) })}
            />
            <input
              className="input-step"
              type="number"
              title="step"
              value={m.step ?? 1}
              onChange={(e) => set({ step: Number(e.target.value) })}
            />
          </span>
        )}
        {inputType === "select" && (
          <input
            className="input-options"
            placeholder="comma, separated, options"
            value={options.join(", ")}
            onChange={(e) =>
              set({
                options: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        )}
      </div>
      <div className="input-control">
        {control}
        <code className="input-value">
          {varName} = {JSON.stringify(m.value ?? null)}
        </code>
      </div>
    </div>
  );
}

// A no-code chart block: pick a DataFrame, a chart type, and X/Y columns. The
// column pickers auto-populate from the kernel (the DataFrame's actual columns).
function ChartConfig({
  cellId,
  metadata,
  socket,
}: {
  cellId: string;
  metadata?: CellMetadata;
  socket: NotebookSocket;
}) {
  const m = metadata ?? {};
  const df = m.df ?? "";
  const x = m.x ?? "";
  const y = m.y ?? "";
  const [columns, setColumns] = useState<string[]>([]);
  const set = (patch: CellMetadata) => useStore.getState().setCellMetadata(cellId, patch);

  // Fetch the frame's columns whenever the chosen DataFrame name changes.
  useEffect(() => {
    let cancelled = false;
    const name = df.trim();
    if (!name) {
      setColumns([]);
      return;
    }
    socket
      .columns(name)
      .then((r) => {
        if (!cancelled) setColumns(r.columns);
      })
      .catch(() => {
        if (!cancelled) setColumns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [df, socket]);

  // Keep the current value selectable even before columns load (or if stale).
  const colOptions = (current: string) => {
    const opts = current && !columns.includes(current) ? [current, ...columns] : columns;
    return (
      <>
        <option value="">—</option>
        {opts.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </>
    );
  };

  return (
    <div className="chart-config">
      <input
        className="chart-df"
        placeholder="DataFrame (e.g. df)"
        value={df}
        onChange={(e) => set({ df: e.target.value })}
      />
      <select
        className="chart-type"
        value={m.chart_type ?? "line"}
        onChange={(e) => set({ chart_type: e.target.value })}
        title="Chart type"
      >
        {CHART_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <label className="chart-axis">
        X
        <select className="chart-x" value={x} onChange={(e) => set({ x: e.target.value })}>
          {colOptions(x)}
        </select>
      </label>
      <label className="chart-axis">
        Y
        <select className="chart-y" value={y} onChange={(e) => set({ y: e.target.value })}>
          {colOptions(y)}
        </select>
      </label>
    </div>
  );
}

// A no-code KPI block: a Python expression + a label (and optional number
// format). Reads in the expression make it reactive — it re-runs when they move.
function KpiConfig({ cellId, metadata }: { cellId: string; metadata?: CellMetadata }) {
  const m = metadata ?? {};
  const set = (patch: CellMetadata) => useStore.getState().setCellMetadata(cellId, patch);
  return (
    <div className="kpi-config">
      <input
        className="kpi-label-input"
        placeholder="Label (e.g. Total revenue)"
        value={m.label ?? ""}
        onChange={(e) => set({ label: e.target.value })}
      />
      <input
        className="kpi-expr-input"
        placeholder="Expression (e.g. df['rev'].sum())"
        value={m.expression ?? ""}
        onChange={(e) => set({ expression: e.target.value })}
      />
      <input
        className="kpi-format-input"
        placeholder="format (e.g. ,.2f)"
        value={m.number_format ?? ""}
        onChange={(e) => set({ number_format: e.target.value })}
        title="Optional Python format spec"
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
      : cell.cell_type === "input"
        ? "Set"
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
      {isExecutable(cell.cell_type) && (
        <span className="prompt">
          {pending ? "[*]" : cell.execution_count != null ? `[${cell.execution_count}]` : "[ ]"}
        </span>
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
        <option value="input">Input</option>
        <option value="chart">Chart</option>
        <option value="kpi">KPI</option>
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
