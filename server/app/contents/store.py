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

import datetime
import shutil
import uuid
from pathlib import Path
from typing import Any

import nbformat
from nbformat import NotebookNode

NOTEBOOKS_DIR = Path(__file__).resolve().parents[2] / "notebooks"
NBFORMAT_VERSION = 4

# Block types that persist as code cells tagged in metadata (see the mapping
# below). Kept in one place so every block round-trips without special-casing.
_BLOCK_TYPES = {"sql", "input", "chart"}

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
        nb_type = c.get("cell_type", "code")
        # Block config (SQL/input/chart/… ) is stored under cell metadata so the
        # file stays valid nbformat; block_type is surfaced as the client type.
        meta = dict(c.get("metadata", {}).get("deepnote", {}))
        block_type = meta.pop("block_type", None)
        cell_type = block_type if block_type in _BLOCK_TYPES else nb_type
        outputs = []
        if nb_type == "code":
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
                "metadata": meta,
            }
        )
    return {"cells": cells, "metadata": dict(nb.get("metadata", {}))}


def document_to_notebook(doc: dict[str, Any]) -> NotebookNode:
    nb = nbformat.v4.new_notebook()
    nb.metadata.update(doc.get("metadata") or {})
    nb.metadata.setdefault("kernelspec", dict(_DEFAULT_KERNELSPEC))

    cells = []
    for c in doc.get("cells", []):
        ctype = c.get("cell_type")
        if ctype == "markdown":
            cell = nbformat.v4.new_markdown_cell(source=c.get("source", ""))
        else:
            # code and every non-markdown block (e.g. sql) persist as code cells.
            cell = nbformat.v4.new_code_cell(source=c.get("source", ""))
            cell.outputs = [
                mapped
                for o in c.get("outputs", [])
                if (mapped := _client_output_to_nb(o)) is not None
            ]
            if c.get("execution_count") is not None:
                cell.execution_count = c["execution_count"]
        # Round-trip block type + config under cell metadata.
        deepnote = {k: v for k, v in (c.get("metadata") or {}).items()}
        if ctype not in ("code", "markdown"):
            deepnote["block_type"] = ctype
        if deepnote:
            cell.metadata["deepnote"] = deepnote
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


def read_notebook(notebook_id: str) -> NotebookNode:
    """Read a notebook from disk, seeding the starter if absent."""
    path = _path_for(notebook_id)
    if not path.exists():
        NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)
        nbformat.write(_starter_notebook(), path)
    return nbformat.read(path, as_version=NBFORMAT_VERSION)


def load_document(notebook_id: str) -> dict[str, Any]:
    """Load a notebook as a client document, seeding the starter if absent."""
    return notebook_to_document(read_notebook(notebook_id))


def save_document(notebook_id: str, doc: dict[str, Any]) -> None:
    """Validate and persist a client document as nbformat."""
    nb = document_to_notebook(doc)
    nbformat.validate(nb)
    path = _path_for(notebook_id)
    NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)
    nbformat.write(nb, path)


# --------------------------------------------------------------------------- #
# checkpoints  (versioned copies of a notebook)
# --------------------------------------------------------------------------- #
def _checkpoint_dir(notebook_id: str) -> Path:
    safe = Path(notebook_id).name
    if not safe or safe != notebook_id:
        raise ValueError(f"invalid notebook id: {notebook_id!r}")
    return NOTEBOOKS_DIR / ".checkpoints" / safe


def _iso_mtime(path: Path) -> str:
    ts = path.stat().st_mtime
    return datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).isoformat()


def create_checkpoint(notebook_id: str) -> dict[str, str]:
    """Snapshot the current saved notebook; returns ``{id, last_modified}``."""
    load_document(notebook_id)  # seed the notebook file if it doesn't exist yet
    cdir = _checkpoint_dir(notebook_id)
    cdir.mkdir(parents=True, exist_ok=True)
    cid = uuid.uuid4().hex
    dst = cdir / f"{cid}.ipynb"
    shutil.copyfile(_path_for(notebook_id), dst)
    return {"id": cid, "last_modified": _iso_mtime(dst)}


def list_checkpoints(notebook_id: str) -> list[dict[str, str]]:
    cdir = _checkpoint_dir(notebook_id)
    if not cdir.exists():
        return []
    items = [{"id": p.stem, "last_modified": _iso_mtime(p)} for p in cdir.glob("*.ipynb")]
    return sorted(items, key=lambda x: x["last_modified"], reverse=True)


def restore_checkpoint(notebook_id: str, checkpoint_id: str) -> dict[str, Any]:
    """Overwrite the notebook with a checkpoint and return the document."""
    safe_cid = Path(checkpoint_id).name
    if not safe_cid or safe_cid != checkpoint_id:
        raise ValueError(f"invalid checkpoint id: {checkpoint_id!r}")
    src = _checkpoint_dir(notebook_id) / f"{safe_cid}.ipynb"
    if not src.exists():
        raise FileNotFoundError(checkpoint_id)
    NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, _path_for(notebook_id))
    return load_document(notebook_id)


# --------------------------------------------------------------------------- #
# multi-notebook management
# --------------------------------------------------------------------------- #
def list_notebooks() -> list[dict[str, str]]:
    """List ``.ipynb`` files in the notebooks dir (newest first)."""
    if not NOTEBOOKS_DIR.exists():
        return []
    items = [
        {"id": p.stem, "last_modified": _iso_mtime(p)}
        for p in NOTEBOOKS_DIR.glob("*.ipynb")
    ]
    return sorted(items, key=lambda x: x["last_modified"], reverse=True)


def create_notebook(notebook_id: str) -> dict[str, str]:
    """Create a new starter notebook; error if the id is taken."""
    path = _path_for(notebook_id)  # also validates the id
    if path.exists():
        raise FileExistsError(notebook_id)
    NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)
    nbformat.write(_starter_notebook(), path)
    return {"id": notebook_id, "last_modified": _iso_mtime(path)}


def delete_notebook(notebook_id: str) -> None:
    """Delete a notebook and any of its checkpoints."""
    _path_for(notebook_id).unlink(missing_ok=True)
    cdir = _checkpoint_dir(notebook_id)
    if cdir.exists():
        shutil.rmtree(cdir, ignore_errors=True)


# --------------------------------------------------------------------------- #
# export
# --------------------------------------------------------------------------- #
def export_notebook(notebook_id: str, fmt: str) -> tuple[bytes, str, str]:
    """Return ``(content, media_type, filename)`` for ``fmt`` in {ipynb, html}."""
    nb = read_notebook(notebook_id)
    if fmt == "ipynb":
        return (
            nbformat.writes(nb).encode("utf-8"),
            "application/x-ipynb+json",
            f"{notebook_id}.ipynb",
        )
    if fmt == "html":
        from nbconvert import HTMLExporter  # lazy: heavy import

        body, _ = HTMLExporter(template_name="lab").from_notebook_node(nb)
        return body.encode("utf-8"), "text/html", f"{notebook_id}.html"
    raise ValueError(f"unsupported export format: {fmt!r}")
