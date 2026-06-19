"""Per-cell comment threads, stored as a JSON sidecar beside the notebook.

Comments are collaboration metadata, not notebook content, so they live in
``notebooks/.comments/<id>.json`` rather than in the ``.ipynb`` — the exported
notebook stays clean and portable. The shape on disk is ``{cell_id: [comment]}``
where a comment is ``{id, cell_id, author, text, created_at}``.
"""

from __future__ import annotations

import datetime
import json
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.contents import store


def _comments_dir() -> Path:
    # Resolved at call time so tests that monkeypatch the notebooks dir are honored.
    return store.NOTEBOOKS_DIR / ".comments"


def _path(notebook_id: str) -> Path:
    safe = Path(notebook_id).name
    if not safe or safe != notebook_id:
        raise ValueError(f"invalid notebook id: {notebook_id!r}")
    return _comments_dir() / f"{safe}.json"


def load_comments(notebook_id: str) -> dict[str, list[dict[str, Any]]]:
    path = _path(notebook_id)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _save(notebook_id: str, data: dict[str, list[dict[str, Any]]]) -> None:
    _comments_dir().mkdir(parents=True, exist_ok=True)
    _path(notebook_id).write_text(json.dumps(data, indent=2))


def add_comment(notebook_id: str, cell_id: str, author: str, text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        raise ValueError("comment text is empty")
    if not cell_id:
        raise ValueError("comment needs a cell id")
    data = load_comments(notebook_id)
    comment = {
        "id": uuid.uuid4().hex,
        "cell_id": cell_id,
        "author": (author or "anon").strip() or "anon",
        "text": text,
        "created_at": datetime.datetime.now(tz=datetime.timezone.utc).isoformat(),
    }
    data.setdefault(cell_id, []).append(comment)
    _save(notebook_id, data)
    return comment


def delete_comment(notebook_id: str, comment_id: str) -> None:
    data = load_comments(notebook_id)
    changed = False
    for cid in list(data.keys()):
        kept = [c for c in data[cid] if c.get("id") != comment_id]
        if len(kept) != len(data[cid]):
            changed = True
        if kept:
            data[cid] = kept
        else:
            del data[cid]
    if changed:
        _save(notebook_id, data)


def delete_all(notebook_id: str) -> None:
    """Remove a notebook's comment sidecar (called when the notebook is deleted)."""
    _path(notebook_id).unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# endpoints
# --------------------------------------------------------------------------- #
router = APIRouter(prefix="/api/contents", tags=["comments"])


class NewComment(BaseModel):
    cell_id: str
    author: str = "anon"
    text: str


@router.get("/{notebook_id}/comments")
def get_comments(notebook_id: str) -> dict[str, list[dict[str, Any]]]:
    return load_comments(notebook_id)


@router.post("/{notebook_id}/comments")
def post_comment(notebook_id: str, body: NewComment) -> dict[str, Any]:
    try:
        return add_comment(notebook_id, body.cell_id, body.author, body.text)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{notebook_id}/comments/{comment_id}")
def remove_comment(notebook_id: str, comment_id: str) -> dict[str, bool]:
    delete_comment(notebook_id, comment_id)
    return {"ok": True}
