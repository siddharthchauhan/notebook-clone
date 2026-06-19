"""REST routes for the notebook document model (autosave).

* ``GET  /api/contents/{notebook_id}`` → the notebook as a client document
* ``PUT  /api/contents/{notebook_id}`` → persist a client document (autosave)

The document shape decouples the frontend from nbformat; see
:mod:`app.contents.store`.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.contents import store
from app.kernels.manager import registry

router = APIRouter(prefix="/api/contents", tags=["contents"])
notebooks_router = APIRouter(prefix="/api/notebooks", tags=["notebooks"])


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


@router.get("/{notebook_id}/checkpoints")
def list_checkpoints(notebook_id: str) -> list[dict[str, str]]:
    try:
        return store.list_checkpoints(notebook_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{notebook_id}/checkpoints")
def create_checkpoint(notebook_id: str) -> dict[str, str]:
    try:
        return store.create_checkpoint(notebook_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{notebook_id}/checkpoints/{checkpoint_id}/restore")
def restore_checkpoint(notebook_id: str, checkpoint_id: str) -> dict[str, Any]:
    try:
        return store.restore_checkpoint(notebook_id, checkpoint_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="checkpoint not found") from exc


@router.get("/{notebook_id}/export/{fmt}")
def export_notebook(notebook_id: str, fmt: str) -> Response:
    try:
        content, media_type, filename = store.export_notebook(notebook_id, fmt)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- #
# multi-notebook management (/api/notebooks)
# --------------------------------------------------------------------------- #
class NewNotebook(BaseModel):
    name: str


@notebooks_router.get("")
def list_notebooks() -> list[dict[str, str]]:
    return store.list_notebooks()


@notebooks_router.post("")
def create_notebook(body: NewNotebook) -> dict[str, str]:
    try:
        return store.create_notebook(body.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail="notebook already exists") from exc


@notebooks_router.delete("/{notebook_id}")
async def delete_notebook(notebook_id: str) -> dict[str, bool]:
    try:
        store.delete_notebook(notebook_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await registry.shutdown(notebook_id)  # drop its kernel if running
    return {"ok": True}
