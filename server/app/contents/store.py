"""Minimal notebook persistence via ``nbformat`` (spec — document model).

Phase 1 scope: load and save a single hardcoded *starter* notebook so the
end-to-end slice exercises the real ``.ipynb`` document model (nbformat v4,
stable cell ids) rather than an ad-hoc shape. Full CRUD, autosave, and
checkpoints are Phase 2.

Notebooks live as ``.ipynb`` files under ``server/notebooks/`` (runtime data,
git-ignored). A working file is seeded from :func:`_starter_notebook` the first
time it is requested.
"""

from __future__ import annotations

from pathlib import Path

import nbformat
from nbformat import NotebookNode

# server/app/contents/store.py -> server/notebooks
NOTEBOOKS_DIR = Path(__file__).resolve().parents[2] / "notebooks"

NBFORMAT_VERSION = 4


def _starter_notebook() -> NotebookNode:
    """The hardcoded starter document: one runnable code cell."""
    nb = nbformat.v4.new_notebook()
    nb.cells = [nbformat.v4.new_code_cell(source='print("hi")')]
    nb.metadata.update(
        {
            "kernelspec": {
                "name": "python3",
                "display_name": "Python 3",
                "language": "python",
            }
        }
    )
    return nb


def _path_for(notebook_id: str) -> Path:
    # Guard against path traversal via the notebook id (e.g. "../secrets").
    safe = Path(notebook_id).name
    if not safe or safe != notebook_id:
        raise ValueError(f"invalid notebook id: {notebook_id!r}")
    return NOTEBOOKS_DIR / f"{safe}.ipynb"


def load_notebook(notebook_id: str) -> NotebookNode:
    """Load ``notebook_id``, seeding it from the starter if it doesn't exist."""
    path = _path_for(notebook_id)
    if not path.exists():
        NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)
        nbformat.write(_starter_notebook(), path)
    return nbformat.read(path, as_version=NBFORMAT_VERSION)


def save_notebook(notebook_id: str, nb: NotebookNode | dict) -> None:
    """Validate and persist a notebook document."""
    node = nb if isinstance(nb, NotebookNode) else nbformat.from_dict(nb)
    nbformat.validate(node)
    path = _path_for(notebook_id)
    NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)
    nbformat.write(node, path)
