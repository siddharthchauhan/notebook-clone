"""REST routes for the notebook document model (spec — contents API).

Phase 1 exposes just enough to load the starter notebook into the browser and
save it back:

* ``GET  /api/contents/{notebook_id}`` → the notebook JSON (nbformat v4)
* ``PUT  /api/contents/{notebook_id}`` → persist a notebook document

Cell add/delete/move and autosave/checkpoints are Phase 2.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from app.contents import store

router = APIRouter(prefix="/api/contents", tags=["contents"])


@router.get("/{notebook_id}")
def get_contents(notebook_id: str) -> dict[str, Any]:
    try:
        nb = store.load_notebook(notebook_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return dict(nb)


@router.put("/{notebook_id}")
def put_contents(notebook_id: str, notebook: dict[str, Any]) -> dict[str, bool]:
    try:
        store.save_notebook(notebook_id, notebook)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}
