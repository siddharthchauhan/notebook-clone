"""Notebook persistence via ``nbformat``, with a clean client document shape.

The browser never touches raw nbformat. The server maps between:

* **on disk**: nbformat v4 ``.ipynb`` (stable cell ids, proper output types);
* **on the wire**: a "document" — ``{cells: [{id, cell_type, source,
  outputs}], metadata}`` — where each output is the same client shape the WS
  stream/display/error events use (``{kind: "stream"|"display"|"error", ...}``).

This keeps autosave robust: the frontend serializes its own cell model and the
server is solely responsible for producing valid nbformat.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import nbformat
from nbformat import NotebookNode

NOTEBOOKS_DIR = Path(__file__).resolve().parents[2] / "notebooks"
NBFORMAT_VERSION = 4

_DEFAULT_KERNELSPEC = {
    "name": "python3",
    "display_name": "Python 3",
    "language": "python",
}


# --------------------------------------------------------------------------- #
# starter document
# --------------------------------------------------------------------------- #
def _starter_notebook() -> NotebookNode:
    nb = nbformat.v4.new_notebook()
    nb.cells = [
        nbformat.v4.new_markdown_cell(
            source="# Notebook Clone\n\nPhase 2 — edit a cell and press **Shift+Enter**."
        ),
        nbformat.v4.new_code_cell(source='print("hi")'),
    ]
    nb.metadata["kernelspec"] = dict(_DEFAULT_KERNELSPEC)
    return nb


# --------------------------------------------------------------------------- #
# output mapping  (nbformat <-> client)
# --------------------------------------------------------------------------- #
def _nb_output_to_client(o: dict) -> dict | None:
    t = o.get("output_type")
    if t == "stream":
        return {"kind": "stream", "name": o.get("name", "stdout"), "text": o.get("text", "")}
    if t in ("display_data", "execute_result"):
        return {
            "kind": "display",
            "data": dict(o.get("data", {})),
            "metadata": dict(o.get("metadata", {})),
        }
    if t == "error":
        return {
            "kind": "error",
            "ename": o.get("ename", ""),
            "evalue": o.get("evalue", ""),
            "traceback": list(o.get("traceback", [])),
        }
    return None


def _client_output_to_nb(o: dict) -> NotebookNode | None:
    kind = o.get("kind")
    if kind == "stream":
        return nbformat.v4.new_output(
            "stream", name=o.get("name", "stdout"), text=o.get("text", "")
        )
    if kind == "display":
        return nbformat.v4.new_output(
            "display_data", data=o.get("data", {}), metadata=o.get("metadata", {})
        )
    if kind == "error":
        return nbformat.v4.new_output(
            "error",
            ename=o.get("ename", ""),
            evalue=o.get("evalue", ""),
            traceback=o.get("traceback", []),
        )
    return None


def _source_to_str(source: Any) -> str:
    return "".join(source) if isinstance(source, list) else (source or "")


# --------------------------------------------------------------------------- #
# document mapping
# --------------------------------------------------------------------------- #
def notebook_to_document(nb: NotebookNode) -> dict[str, Any]:
    cells = []
    for c in nb.cells:
        cell_type = c.get("cell_type", "code")
        outputs = []
        if cell_type == "code":
            outputs = [
                mapped
                for o in c.get("outputs", [])
                if (mapped := _nb_output_to_client(o)) is not None
            ]
        cells.append(
            {
                "id": c.get("id") or uuid.uuid4().hex,
                "cell_type": cell_type,
                "source": _source_to_str(c.get("source", "")),
                "outputs": outputs,
                "execution_count": c.get("execution_count"),
            }
        )
    return {"cells": cells, "metadata": dict(nb.get("metadata", {}))}


def document_to_notebook(doc: dict[str, Any]) -> NotebookNode:
    nb = nbformat.v4.new_notebook()
    nb.metadata.update(doc.get("metadata") or {})
    nb.metadata.setdefault("kernelspec", dict(_DEFAULT_KERNELSPEC))

    cells = []
    for c in doc.get("cells", []):
        if c.get("cell_type") == "markdown":
            cell = nbformat.v4.new_markdown_cell(source=c.get("source", ""))
        else:
            cell = nbformat.v4.new_code_cell(source=c.get("source", ""))
            cell.outputs = [
                mapped
                for o in c.get("outputs", [])
                if (mapped := _client_output_to_nb(o)) is not None
            ]
            if c.get("execution_count") is not None:
                cell.execution_count = c["execution_count"]
        # Preserve the client's stable cell id (valid nbformat v4.5 id chars).
        if c.get("id"):
            cell["id"] = c["id"]
        cells.append(cell)
    nb.cells = cells
    return nb


# --------------------------------------------------------------------------- #
# disk I/O
# --------------------------------------------------------------------------- #
def _path_for(notebook_id: str) -> Path:
    safe = Path(notebook_id).name
    if not safe or safe != notebook_id:
        raise ValueError(f"invalid notebook id: {notebook_id!r}")
    return NOTEBOOKS_DIR / f"{safe}.ipynb"


def load_document(notebook_id: str) -> dict[str, Any]:
    """Load a notebook as a client document, seeding the starter if absent."""
    path = _path_for(notebook_id)
    if not path.exists():
        NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)
        nbformat.write(_starter_notebook(), path)
    nb = nbformat.read(path, as_version=NBFORMAT_VERSION)
    return notebook_to_document(nb)


def save_document(notebook_id: str, doc: dict[str, Any]) -> None:
    """Validate and persist a client document as nbformat."""
    nb = document_to_notebook(doc)
    nbformat.validate(nb)
    path = _path_for(notebook_id)
    NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)
    nbformat.write(nb, path)
