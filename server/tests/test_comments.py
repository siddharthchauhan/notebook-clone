"""Per-cell comment threads (JSON sidecar + REST)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import comments
from app.contents import store
from app.main import app


def test_add_list_delete_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)

    c = comments.add_comment("nb", "cell-1", "ada", "first!")
    assert c["id"] and c["author"] == "ada" and c["cell_id"] == "cell-1"

    data = comments.load_comments("nb")
    assert [x["text"] for x in data["cell-1"]] == ["first!"]

    comments.delete_comment("nb", c["id"])
    assert comments.load_comments("nb") == {}


def test_empty_comment_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)
    with pytest.raises(ValueError):
        comments.add_comment("nb", "cell-1", "ada", "   ")


def test_deleting_notebook_removes_comments(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)
    store.create_notebook("doomed")
    comments.add_comment("doomed", "c1", "ada", "hi")
    assert comments.load_comments("doomed")

    store.delete_notebook("doomed")
    assert comments.load_comments("doomed") == {}


def test_comments_api(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)
    client = TestClient(app)

    assert client.get("/api/contents/nb/comments").json() == {}

    r = client.post(
        "/api/contents/nb/comments",
        json={"cell_id": "c1", "author": "grace", "text": "looks good"},
    )
    assert r.status_code == 200
    cid = r.json()["id"]
    assert client.get("/api/contents/nb/comments").json()["c1"][0]["text"] == "looks good"

    assert client.post(
        "/api/contents/nb/comments", json={"cell_id": "c1", "author": "x", "text": ""}
    ).status_code == 400

    assert client.delete(f"/api/contents/nb/comments/{cid}").json() == {"ok": True}
    assert client.get("/api/contents/nb/comments").json() == {}
