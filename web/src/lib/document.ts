// Conversion between the store's cell model and the server "document" shape,
// plus the contents REST calls used for loading and autosave. The store's
// Output type intentionally matches the server's document output shape, so
// outputs pass through unchanged.

import type { CellState, CellType, Output } from "./store";

interface DocCell {
  id: string;
  cell_type: string;
  source: string;
  outputs: Output[];
  execution_count: number | null;
}

interface NotebookDoc {
  cells: DocCell[];
  metadata: Record<string, unknown>;
}

export function documentToCells(doc: { cells?: DocCell[] }): CellState[] {
  return (doc.cells ?? []).map((c) => {
    const cell_type: CellType = c.cell_type === "markdown" ? "markdown" : "code";
    return {
      id: c.id,
      cell_type,
      source: c.source ?? "",
      outputs: cell_type === "code" ? (c.outputs ?? []) : [],
      execution_state: "idle",
      execution_count: c.execution_count ?? null,
      // Markdown loaded from disk starts rendered; empty markdown opens for edit.
      rendered: cell_type === "markdown" && (c.source ?? "").length > 0,
    };
  });
}

function cellsToDocument(cells: CellState[]): NotebookDoc {
  return {
    cells: cells.map((c) => ({
      id: c.id,
      cell_type: c.cell_type,
      source: c.source,
      outputs: c.cell_type === "code" ? c.outputs : [],
      execution_count: c.execution_count,
    })),
    metadata: {},
  };
}

export async function loadDocument(notebookId: string): Promise<CellState[]> {
  const r = await fetch(`/api/contents/${notebookId}`);
  if (!r.ok) throw new Error(`load failed: ${r.status}`);
  return documentToCells(await r.json());
}

export async function saveDocument(
  notebookId: string,
  cells: CellState[],
): Promise<void> {
  const r = await fetch(`/api/contents/${notebookId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cellsToDocument(cells)),
  });
  if (!r.ok) throw new Error(`save failed: ${r.status}`);
}

export interface KernelSpec {
  name: string;
  display_name: string;
  language: string;
}

export async function loadKernelSpecs(): Promise<{
  default: string;
  kernelspecs: KernelSpec[];
}> {
  const r = await fetch("/api/kernelspecs");
  if (!r.ok) throw new Error(`kernelspecs failed: ${r.status}`);
  return r.json();
}
