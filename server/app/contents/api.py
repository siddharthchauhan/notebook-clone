"""REST routes for the notebook document model (autosave).

* ``GET  /api/contents/{notebook_id}`` → the notebook as a client document
* ``PUT  /api/contents/{notebook_id}`` → persist a client document (autosave)

The document shape decouples the frontend from nbformat; see
:mod:`app.contents.store`.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.contents import store

router = APIRouter(prefix="/api/contents", tags=["contents"])


class CellModel(BaseModel):
    id: str
    cell_type: str = "code"
    source: str = ""
    outputs: list[dict[str, Any]] = Field(default_factory=list)
    execution_count: int | None = None


class NotebookDocument(BaseModel):
    cells: list[CellModel] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


@router.get("/{notebook_id}")
def get_contents(notebook_id: str) -> dict[str, Any]:
    try:
        return store.load_document(notebook_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/{notebook_id}")
def put_contents(notebook_id: str, document: NotebookDocument) -> dict[str, bool]:
    try:
        store.save_document(notebook_id, document.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}
