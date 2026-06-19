import { create } from "zustand";
import type { ClientEvent } from "./protocol";
import type { CommentT } from "./comments";

// Output shape is identical to the server "document" output shape, so loading
// and autosaving are direct pass-throughs (see lib/document.ts).
export type Output =
  | { kind: "stream"; name: string; text: string }
  | { kind: "display"; data: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] };

export type CellType = "code" | "markdown" | "sql" | "input" | "chart" | "kpi";
export type ExecutionState = "idle" | "busy" | "starting" | "queued";

// Per-block config (Deepnote-style blocks). SQL blocks carry their connection
// and target variable; input blocks carry a control + the global they bind.
export interface SqlConnection {
  type: "sqlite" | "sqlalchemy";
  db_path?: string;
  url?: string;
}
export type InputType = "text" | "slider" | "select" | "checkbox";
export interface CellMetadata {
  // sql block
  connection?: SqlConnection;
  result_var?: string;
  // input block
  input_type?: InputType;
  var_name?: string;
  value?: boolean | number | string;
  options?: string[]; // select choices
  min?: number;
  max?: number;
  step?: number;
  // chart block
  df?: string; // source DataFrame variable
  chart_type?: string;
  x?: string;
  y?: string;
  title?: string;
  // kpi block
  expression?: string;
  label?: string;
  number_format?: string;
  [k: string]: unknown;
}

export interface CellState {
  id: string;
  cell_type: CellType;
  source: string;
  outputs: Output[];
  execution_state: ExecutionState;
  execution_count: number | null;
  rendered: boolean; // markdown cells: showing the rendered view vs. editor
  metadata?: CellMetadata; // block config (e.g. SQL connection + result var)
  remoteEpoch?: number; // bumps when a collaborator edits this cell's source
}

// One collaborator on a notebook (presence roster).
export interface Peer {
  client_id: string;
  name: string;
  color: string;
}

// A document edit broadcast to collaborators. The server relays these opaquely;
// only the client interprets them (see applyRemoteOp).
export type DocOp =
  | { op: "source"; cell_id: string; source: string }
  | { op: "add"; after_id: string | null; cell: CellState }
  | { op: "delete"; cell_id: string }
  | { op: "move"; cell_id: string; dir: -1 | 1 }
  | { op: "type"; cell_id: string; cell_type: CellType }
  | { op: "metadata"; cell_id: string; patch: CellMetadata }
  | { op: "rendered"; cell_id: string; rendered: boolean };

// Sensible starting config per block type (SQL → SQLite into `df`; input → a
// 0–100 slider bound to `x`).
function defaultMetadata(cell_type: CellType): CellMetadata | undefined {
  if (cell_type === "sql") {
    return { connection: { type: "sqlite", db_path: "" }, result_var: "df" };
  }
  if (cell_type === "input") {
    return { input_type: "slider", var_name: "x", value: 50, min: 0, max: 100, step: 1 };
  }
  if (cell_type === "chart") {
    return { df: "", chart_type: "line", x: "", y: "" };
  }
  if (cell_type === "kpi") {
    return { expression: "", label: "Metric" };
  }
  return undefined;
}

export type KernelStatus = "connecting" | "ready" | "restarting" | "dead";

function newId(): string {
  return crypto.randomUUID();
}

export function emptyCell(cell_type: CellType = "code", source = ""): CellState {
  return {
    id: newId(),
    cell_type,
    source,
    outputs: [],
    execution_state: "idle",
    execution_count: null,
    // New cells open in edit mode; a markdown cell seeded with content (e.g.
    // from AI) opens rendered so it reads as finished, not a draft.
    rendered: cell_type === "markdown" && source.length > 0,
    metadata: defaultMetadata(cell_type),
  };
}

interface NotebookStore {
  cells: CellState[];
  connected: boolean;
  kernelStatus: KernelStatus;
  kernelName: string | null;
  aiAvailable: boolean; // whether the server has AI assist configured
  revision: number; // bumps on persistable changes; drives autosave
  variablesRevision: number; // bumps when a binding changes the kernel silently
  reactive: boolean; // when on, a block's dependents re-run after it changes
  appMode: boolean; // presentation view: hide code/chrome, show outputs + inputs
  autoRunMs: number; // 0 = off; otherwise run-all on this interval (live dashboards)
  notebookId: string; // current notebook (also used by comment REST calls)
  comments: Record<string, CommentT[]>; // per-cell threads, keyed by cell id
  peers: Peer[]; // other collaborators currently on this notebook

  setConnected: (connected: boolean) => void;
  setPeers: (peers: Peer[]) => void;
  setBroadcaster: (fn: ((op: DocOp) => void) | null) => void;
  applyRemoteOp: (op: DocOp) => void;
  setReactive: (reactive: boolean) => void;
  setAppMode: (appMode: boolean) => void;
  setAutoRunMs: (ms: number) => void;
  setNotebookId: (id: string) => void;
  setComments: (comments: Record<string, CommentT[]>) => void;
  addCommentLocal: (comment: CommentT) => void;
  removeCommentLocal: (commentId: string) => void;
  touchVariables: () => void;
  setKernel: (status: KernelStatus, name?: string | null) => void;
  setAiAvailable: (available: boolean) => void;
  setCells: (cells: CellState[]) => void;

  setSource: (cellId: string, source: string) => void;
  addCell: (afterId: string | null, cell_type: CellType, source?: string) => string;
  deleteCell: (cellId: string) => void;
  moveCell: (cellId: string, dir: -1 | 1) => void;
  setCellType: (cellId: string, cell_type: CellType) => void;
  setCellMetadata: (cellId: string, patch: CellMetadata) => void;
  setRendered: (cellId: string, rendered: boolean) => void;
  clearOutputs: (cellId: string) => void;
  markQueued: (cellId: string) => void;

  applyEvent: (event: ClientEvent) => void;
}

function mapCell(
  cells: CellState[],
  cellId: string,
  fn: (cell: CellState) => CellState,
): CellState[] {
  return cells.map((c) => (c.id === cellId ? fn(c) : c));
}

// Collaboration: doc edits are broadcast to peers via this hook (set by the app
// once the socket is up). `applyingRemote` guards against echoing a remote edit
// straight back out as a local one.
let _broadcaster: ((op: DocOp) => void) | null = null;
let applyingRemote = false;
function emit(op: DocOp): void {
  if (!applyingRemote) _broadcaster?.(op);
}

export const useStore = create<NotebookStore>((set, get) => ({
  cells: [],
  connected: false,
  kernelStatus: "connecting",
  kernelName: null,
  aiAvailable: false,
  revision: 0,
  variablesRevision: 0,
  reactive: false,
  appMode: false,
  autoRunMs: 0,
  notebookId: "default",
  comments: {},
  peers: [],

  setConnected: (connected) => set({ connected }),
  setPeers: (peers) => set({ peers }),
  setBroadcaster: (fn) => {
    _broadcaster = fn;
  },

  // Apply a collaborator's edit without re-broadcasting it. Source edits bump the
  // cell's remoteEpoch so a non-focused editor knows to refresh its text.
  applyRemoteOp: (op) => {
    applyingRemote = true;
    try {
      const s = get();
      switch (op.op) {
        case "source":
          s.setSource(op.cell_id, op.source);
          set((st) => ({
            cells: mapCell(st.cells, op.cell_id, (c) => ({
              ...c,
              remoteEpoch: (c.remoteEpoch ?? 0) + 1,
            })),
          }));
          break;
        case "add":
          set((st) => {
            if (st.cells.some((c) => c.id === op.cell.id)) return {} as Partial<NotebookStore>;
            const idx = op.after_id ? st.cells.findIndex((c) => c.id === op.after_id) : -1;
            const at = idx === -1 ? st.cells.length : idx + 1;
            return {
              cells: [...st.cells.slice(0, at), op.cell, ...st.cells.slice(at)],
              revision: st.revision + 1,
            };
          });
          break;
        case "delete":
          s.deleteCell(op.cell_id);
          break;
        case "move":
          s.moveCell(op.cell_id, op.dir);
          break;
        case "type":
          s.setCellType(op.cell_id, op.cell_type);
          break;
        case "metadata":
          s.setCellMetadata(op.cell_id, op.patch);
          break;
        case "rendered":
          s.setRendered(op.cell_id, op.rendered);
          break;
      }
    } finally {
      applyingRemote = false;
    }
  },
  setReactive: (reactive) => set({ reactive }),
  // Entering app view turns on reactivity so inputs drive the dashboard live.
  setAppMode: (appMode) => set((s) => ({ appMode, reactive: appMode || s.reactive })),
  setAutoRunMs: (autoRunMs) => set({ autoRunMs }),
  setNotebookId: (notebookId) => set({ notebookId }),
  setComments: (comments) => set({ comments }),
  addCommentLocal: (comment) =>
    set((s) => ({
      comments: {
        ...s.comments,
        [comment.cell_id]: [...(s.comments[comment.cell_id] ?? []), comment],
      },
    })),
  removeCommentLocal: (commentId) =>
    set((s) => {
      const next: Record<string, CommentT[]> = {};
      for (const [cid, list] of Object.entries(s.comments)) {
        const kept = list.filter((c) => c.id !== commentId);
        if (kept.length) next[cid] = kept;
      }
      return { comments: next };
    }),
  touchVariables: () => set((s) => ({ variablesRevision: s.variablesRevision + 1 })),
  setKernel: (kernelStatus, name) =>
    set((s) => ({ kernelStatus, kernelName: name ?? s.kernelName })),
  setAiAvailable: (aiAvailable) => set({ aiAvailable }),
  // A wholesale document load (initial, checkpoint restore, notebook switch) is
  // a clean baseline — reset the autosave revision so it doesn't immediately
  // re-save freshly loaded content.
  setCells: (cells) => set({ cells, revision: 0 }),

  setSource: (cellId, source) => {
    set((s) => ({
      cells: mapCell(s.cells, cellId, (c) => ({ ...c, source })),
      revision: s.revision + 1,
    }));
    emit({ op: "source", cell_id: cellId, source });
  },

  addCell: (afterId, cell_type, source = "") => {
    const cell = emptyCell(cell_type, source);
    set((s) => {
      const idx = afterId ? s.cells.findIndex((c) => c.id === afterId) : -1;
      const at = idx === -1 ? s.cells.length : idx + 1;
      const cells = [...s.cells.slice(0, at), cell, ...s.cells.slice(at)];
      return { cells, revision: s.revision + 1 };
    });
    emit({ op: "add", after_id: afterId, cell });
    return cell.id;
  },

  deleteCell: (cellId) => {
    set((s) => ({
      cells: s.cells.filter((c) => c.id !== cellId),
      revision: s.revision + 1,
    }));
    emit({ op: "delete", cell_id: cellId });
  },

  moveCell: (cellId, dir) => {
    set((s) => {
      const idx = s.cells.findIndex((c) => c.id === cellId);
      const target = idx + dir;
      if (idx === -1 || target < 0 || target >= s.cells.length) return {};
      const cells = [...s.cells];
      [cells[idx], cells[target]] = [cells[target], cells[idx]];
      return { cells, revision: s.revision + 1 };
    });
    emit({ op: "move", cell_id: cellId, dir });
  },

  setCellType: (cellId, cell_type) => {
    set((s) => ({
      cells: mapCell(s.cells, cellId, (c) => ({
        ...c,
        cell_type,
        outputs: cell_type === "markdown" ? [] : c.outputs,
        rendered: cell_type === "markdown" ? false : c.rendered,
        // Seed block config when switching into a block type that needs it.
        metadata: c.metadata ?? defaultMetadata(cell_type),
      })),
      revision: s.revision + 1,
    }));
    emit({ op: "type", cell_id: cellId, cell_type });
  },

  setCellMetadata: (cellId, patch) => {
    set((s) => ({
      cells: mapCell(s.cells, cellId, (c) => ({
        ...c,
        metadata: { ...(c.metadata ?? {}), ...patch },
      })),
      revision: s.revision + 1,
    }));
    emit({ op: "metadata", cell_id: cellId, patch });
  },

  setRendered: (cellId, rendered) => {
    set((s) => ({ cells: mapCell(s.cells, cellId, (c) => ({ ...c, rendered })) }));
    emit({ op: "rendered", cell_id: cellId, rendered });
  },

  clearOutputs: (cellId) =>
    set((s) => ({
      cells: mapCell(s.cells, cellId, (c) => ({ ...c, outputs: [] })),
    })),

  // Submitted to the kernel but not yet running. The kernel processes
  // execute_requests FIFO; the incoming busy/idle status overrides this.
  markQueued: (cellId) =>
    set((s) => ({
      cells: mapCell(s.cells, cellId, (c) => ({ ...c, execution_state: "queued" })),
    })),

  applyEvent: (event) => {
    // Kernel-level lifecycle, not tied to a cell.
    if (event.type === "kernel_status") {
      get().setKernel(event.state as KernelStatus, event.kernel_name);
      return;
    }
    // complete/inspect/variables/columns replies are resolved in ws.ts, not here.
    if (
      event.type === "complete_reply" ||
      event.type === "inspect_reply" ||
      event.type === "variables_reply" ||
      event.type === "variable_children_reply" ||
      event.type === "columns_reply"
    )
      return;
    // ipywidgets comm events are handled by the widget manager (see ws.ts),
    // never the cell store.
    // Collaboration events are handled in ws.ts (applyRemoteOp / setPeers).
    if (event.type === "doc_op" || event.type === "presence") return;
    if (
      event.type === "comm_open" ||
      event.type === "comm_msg" ||
      event.type === "comm_close"
    )
      return;
    if (event.cell_id == null) return;
    const cellId = event.cell_id;

    set((s) => {
      switch (event.type) {
        case "status":
          return {
            cells: mapCell(s.cells, cellId, (c) => ({
              ...c,
              execution_state: event.execution_state as ExecutionState,
            })),
            // Persist outputs once a run settles.
            revision: event.execution_state === "idle" ? s.revision + 1 : s.revision,
          };

        case "exec_input":
          return {
            cells: mapCell(s.cells, cellId, (c) => ({
              ...c,
              execution_count: event.execution_count,
            })),
          };

        case "stream":
          // Append-only; coalesce consecutive same-stream chunks.
          return {
            cells: mapCell(s.cells, cellId, (c) => {
              const last = c.outputs[c.outputs.length - 1];
              if (last && last.kind === "stream" && last.name === event.name) {
                const merged: Output = { ...last, text: last.text + event.text };
                return { ...c, outputs: [...c.outputs.slice(0, -1), merged] };
              }
              return {
                ...c,
                outputs: [...c.outputs, { kind: "stream", name: event.name, text: event.text }],
              };
            }),
          };

        case "display":
          return {
            cells: mapCell(s.cells, cellId, (c) => ({
              ...c,
              outputs: [
                ...c.outputs,
                { kind: "display", data: event.data, metadata: event.metadata },
              ],
            })),
          };

        case "error":
          return {
            cells: mapCell(s.cells, cellId, (c) => ({
              ...c,
              outputs: [
                ...c.outputs,
                {
                  kind: "error",
                  ename: event.ename,
                  evalue: event.evalue,
                  traceback: event.traceback,
                },
              ],
            })),
          };

        case "clear_output":
          return { cells: mapCell(s.cells, cellId, (c) => ({ ...c, outputs: [] })) };

        default:
          return {};
      }
    });
  },
}));

// Dev-only test hook: lets e2e tests set cell source without fighting the
// editor's auto-indent. Stripped from production builds.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __store?: typeof useStore }).__store = useStore;
}
