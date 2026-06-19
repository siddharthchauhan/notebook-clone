import { create } from "zustand";
import type { ClientEvent } from "./protocol";

// Output shape is identical to the server "document" output shape, so loading
// and autosaving are direct pass-throughs (see lib/document.ts).
export type Output =
  | { kind: "stream"; name: string; text: string }
  | { kind: "display"; data: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] };

export type CellType = "code" | "markdown";
export type ExecutionState = "idle" | "busy" | "starting" | "queued";

export interface CellState {
  id: string;
  cell_type: CellType;
  source: string;
  outputs: Output[];
  execution_state: ExecutionState;
  execution_count: number | null;
  rendered: boolean; // markdown cells: showing the rendered view vs. editor
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
  };
}

interface NotebookStore {
  cells: CellState[];
  connected: boolean;
  kernelStatus: KernelStatus;
  kernelName: string | null;
  aiAvailable: boolean; // whether the server has AI assist configured
  revision: number; // bumps on persistable changes; drives autosave

  setConnected: (connected: boolean) => void;
  setKernel: (status: KernelStatus, name?: string | null) => void;
  setAiAvailable: (available: boolean) => void;
  setCells: (cells: CellState[]) => void;

  setSource: (cellId: string, source: string) => void;
  addCell: (afterId: string | null, cell_type: CellType, source?: string) => string;
  deleteCell: (cellId: string) => void;
  moveCell: (cellId: string, dir: -1 | 1) => void;
  setCellType: (cellId: string, cell_type: CellType) => void;
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

export const useStore = create<NotebookStore>((set, get) => ({
  cells: [],
  connected: false,
  kernelStatus: "connecting",
  kernelName: null,
  aiAvailable: false,
  revision: 0,

  setConnected: (connected) => set({ connected }),
  setKernel: (kernelStatus, name) =>
    set((s) => ({ kernelStatus, kernelName: name ?? s.kernelName })),
  setAiAvailable: (aiAvailable) => set({ aiAvailable }),
  // A wholesale document load (initial, checkpoint restore, notebook switch) is
  // a clean baseline — reset the autosave revision so it doesn't immediately
  // re-save freshly loaded content.
  setCells: (cells) => set({ cells, revision: 0 }),

  setSource: (cellId, source) =>
    set((s) => ({
      cells: mapCell(s.cells, cellId, (c) => ({ ...c, source })),
      revision: s.revision + 1,
    })),

  addCell: (afterId, cell_type, source = "") => {
    const cell = emptyCell(cell_type, source);
    set((s) => {
      const idx = afterId ? s.cells.findIndex((c) => c.id === afterId) : -1;
      const at = idx === -1 ? s.cells.length : idx + 1;
      const cells = [...s.cells.slice(0, at), cell, ...s.cells.slice(at)];
      return { cells, revision: s.revision + 1 };
    });
    return cell.id;
  },

  deleteCell: (cellId) =>
    set((s) => ({
      cells: s.cells.filter((c) => c.id !== cellId),
      revision: s.revision + 1,
    })),

  moveCell: (cellId, dir) =>
    set((s) => {
      const idx = s.cells.findIndex((c) => c.id === cellId);
      const target = idx + dir;
      if (idx === -1 || target < 0 || target >= s.cells.length) return {};
      const cells = [...s.cells];
      [cells[idx], cells[target]] = [cells[target], cells[idx]];
      return { cells, revision: s.revision + 1 };
    }),

  setCellType: (cellId, cell_type) =>
    set((s) => ({
      cells: mapCell(s.cells, cellId, (c) => ({
        ...c,
        cell_type,
        outputs: cell_type === "markdown" ? [] : c.outputs,
        rendered: cell_type === "markdown" ? false : c.rendered,
      })),
      revision: s.revision + 1,
    })),

  setRendered: (cellId, rendered) =>
    set((s) => ({ cells: mapCell(s.cells, cellId, (c) => ({ ...c, rendered })) })),

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
    // complete/inspect/variables replies are resolved in ws.ts, never here.
    if (
      event.type === "complete_reply" ||
      event.type === "inspect_reply" ||
      event.type === "variables_reply" ||
      event.type === "variable_children_reply"
    )
      return;
    // ipywidgets comm events are handled by the widget manager (see ws.ts),
    // never the cell store.
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
