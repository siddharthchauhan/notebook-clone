import { create } from "zustand";
import type { ClientEvent } from "./protocol";

// A cell's outputs are a heterogeneous, ordered list — exactly like a real
// notebook. Each variant maps to one renderer in components/outputs.
export type Output =
  | { kind: "stream"; name: string; text: string }
  | { kind: "display"; data: Record<string, unknown> }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] };

export type ExecutionState = "idle" | "busy" | "starting";

export interface CellState {
  id: string;
  source: string;
  outputs: Output[];
  execution_state: ExecutionState;
}

interface NotebookStore {
  cells: CellState[];
  connected: boolean;

  setConnected: (connected: boolean) => void;
  setCells: (cells: CellState[]) => void;
  setSource: (cellId: string, source: string) => void;
  clearOutputs: (cellId: string) => void;

  /** Apply one server event, routing it to its cell by `cell_id`. */
  applyEvent: (event: ClientEvent) => void;
}

function mapCell(
  cells: CellState[],
  cellId: string,
  fn: (cell: CellState) => CellState,
): CellState[] {
  return cells.map((cell) => (cell.id === cellId ? fn(cell) : cell));
}

export const useStore = create<NotebookStore>((set) => ({
  cells: [],
  connected: false,

  setConnected: (connected) => set({ connected }),
  setCells: (cells) => set({ cells }),

  setSource: (cellId, source) =>
    set((state) => ({
      cells: mapCell(state.cells, cellId, (cell) => ({ ...cell, source })),
    })),

  clearOutputs: (cellId) =>
    set((state) => ({
      cells: mapCell(state.cells, cellId, (cell) => ({ ...cell, outputs: [] })),
    })),

  applyEvent: (event) =>
    set((state) => {
      // Events without an owning cell (e.g. the kernel's own startup status)
      // carry cell_id === null and are ignored for per-cell routing.
      if (event.cell_id == null) return {};

      const cellId = event.cell_id;
      switch (event.type) {
        case "status":
          return {
            cells: mapCell(state.cells, cellId, (cell) => ({
              ...cell,
              execution_state: event.execution_state as ExecutionState,
            })),
          };

        case "stream":
          // INVARIANT: stream output is append-only. Coalesce consecutive
          // chunks of the same stream (stdout/stderr); never replace.
          return {
            cells: mapCell(state.cells, cellId, (cell) => {
              const last = cell.outputs[cell.outputs.length - 1];
              if (last && last.kind === "stream" && last.name === event.name) {
                const merged: Output = { ...last, text: last.text + event.text };
                return { ...cell, outputs: [...cell.outputs.slice(0, -1), merged] };
              }
              return {
                ...cell,
                outputs: [
                  ...cell.outputs,
                  { kind: "stream", name: event.name, text: event.text },
                ],
              };
            }),
          };

        case "display":
          return {
            cells: mapCell(state.cells, cellId, (cell) => ({
              ...cell,
              outputs: [...cell.outputs, { kind: "display", data: event.data }],
            })),
          };

        case "error":
          return {
            cells: mapCell(state.cells, cellId, (cell) => ({
              ...cell,
              outputs: [
                ...cell.outputs,
                {
                  kind: "error",
                  ename: event.ename,
                  evalue: event.evalue,
                  traceback: event.traceback,
                },
              ],
            })),
          };

        default:
          return {};
      }
    }),
}));
