// Conversion between the store's cell model and the server "document" shape,
// plus the contents REST calls used for loading and autosave. The store's
// Output type intentionally matches the server's document output shape, so
// outputs pass through unchanged.

import type { CellMetadata, CellState, CellType, Output } from "./store";

interface DocCell {
  id: string;
  cell_type: string;
  source: string;
  outputs: Output[];
  execution_count: number | null;
  metadata?: CellMetadata;
}

interface NotebookDoc {
  cells: DocCell[];
  metadata: Record<string, unknown>;
}

// Only code and SQL blocks run code and carry outputs; markdown/input don't.
function hasOutputs(t: CellType): boolean {
  return t === "code" || t === "sql";
}

function toCellType(t: string): CellType {
  return t === "markdown" || t === "sql" || t === "input" ? t : "code";
}

export function documentToCells(doc: { cells?: DocCell[] }): CellState[] {
  return (doc.cells ?? []).map((c) => {
    const cell_type = toCellType(c.cell_type);
    return {
      id: c.id,
      cell_type,
      source: c.source ?? "",
      outputs: hasOutputs(cell_type) ? (c.outputs ?? []) : [],
      execution_state: "idle",
      execution_count: c.execution_count ?? null,
      // Markdown loaded from disk starts rendered; empty markdown opens for edit.
      rendered: cell_type === "markdown" && (c.source ?? "").length > 0,
      metadata: c.metadata,
    };
  });
}

function cellsToDocument(cells: CellState[]): NotebookDoc {
  return {
    cells: cells.map((c) => ({
      id: c.id,
      cell_type: c.cell_type,
      source: c.source,
      outputs: hasOutputs(c.cell_type) ? c.outputs : [],
      execution_count: c.execution_count,
      metadata: c.metadata ?? {},
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

export interface Checkpoint {
  id: string;
  last_modified: string;
}

export async function listCheckpoints(notebookId: string): Promise<Checkpoint[]> {
  const r = await fetch(`/api/contents/${notebookId}/checkpoints`);
  if (!r.ok) throw new Error(`list checkpoints failed: ${r.status}`);
  return r.json();
}

export async function createCheckpoint(notebookId: string): Promise<Checkpoint> {
  const r = await fetch(`/api/contents/${notebookId}/checkpoints`, { method: "POST" });
  if (!r.ok) throw new Error(`create checkpoint failed: ${r.status}`);
  return r.json();
}

export async function restoreCheckpoint(
  notebookId: string,
  checkpointId: string,
): Promise<CellState[]> {
  const r = await fetch(
    `/api/contents/${notebookId}/checkpoints/${checkpointId}/restore`,
    { method: "POST" },
  );
  if (!r.ok) throw new Error(`restore checkpoint failed: ${r.status}`);
  return documentToCells(await r.json());
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

// ----------------------------------------------------------- notebooks --- //

export interface NotebookEntry {
  id: string;
  last_modified: string;
}

export async function listNotebooks(): Promise<NotebookEntry[]> {
  const r = await fetch("/api/notebooks");
  if (!r.ok) throw new Error(`list notebooks failed: ${r.status}`);
  return r.json();
}

export async function createNotebook(name: string): Promise<NotebookEntry> {
  const r = await fetch("/api/notebooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (r.status === 409) throw new Error("A notebook with that name already exists");
  if (!r.ok) throw new Error(`create notebook failed: ${r.status}`);
  return r.json();
}

export async function deleteNotebook(id: string): Promise<void> {
  const r = await fetch(`/api/notebooks/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete notebook failed: ${r.status}`);
}

export function exportNotebookUrl(id: string, fmt: "ipynb" | "html"): string {
  return `/api/contents/${encodeURIComponent(id)}/export/${fmt}`;
}
