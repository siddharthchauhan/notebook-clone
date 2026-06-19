"""Tests for the document <-> nbformat mapping and persistence."""

from __future__ import annotations

import nbformat
import pytest
from fastapi.testclient import TestClient

from app.contents import store
from app.main import app


def test_document_roundtrip_preserves_cells_and_outputs():
    doc = {
        "cells": [
            {"id": "m1", "cell_type": "markdown", "source": "# Title", "outputs": []},
            {
                "id": "c1",
                "cell_type": "code",
                "source": "print('hi')",
                "outputs": [
                    {"kind": "stream", "name": "stdout", "text": "hi\n"},
                    {"kind": "display", "data": {"text/plain": "42"}, "metadata": {}},
                    {
                        "kind": "error",
                        "ename": "ValueError",
                        "evalue": "bad",
                        "traceback": ["Traceback", "ValueError: bad"],
                    },
                ],
            },
        ],
        "metadata": {},
    }

    nb = store.document_to_notebook(doc)
    nbformat.validate(nb)  # must produce valid nbformat
    back = store.notebook_to_document(nb)

    assert [c["id"] for c in back["cells"]] == ["m1", "c1"]
    assert back["cells"][0]["cell_type"] == "markdown"

    code_outputs = back["cells"][1]["outputs"]
    assert code_outputs[0] == {"kind": "stream", "name": "stdout", "text": "hi\n"}
    assert code_outputs[1]["kind"] == "display"
    assert code_outputs[1]["data"] == {"text/plain": "42"}
    assert code_outputs[2]["kind"] == "error" and code_outputs[2]["ename"] == "ValueError"


def test_sql_block_roundtrips_as_code_cell_with_metadata():
    """A SQL block persists as a valid-nbformat code cell tagged in metadata, and
    comes back as cell_type 'sql' with its connection config intact."""
    doc = {
        "cells": [
            {
                "id": "q1",
                "cell_type": "sql",
                "source": "SELECT * FROM t",
                "outputs": [
                    {"kind": "display", "data": {"text/plain": "ok"}, "metadata": {}}
                ],
                "execution_count": 3,
                "metadata": {
                    "connection": {"type": "sqlite", "db_path": "data.db"},
                    "result_var": "df",
                },
            }
        ],
        "metadata": {},
    }

    nb = store.document_to_notebook(doc)
    nbformat.validate(nb)  # SQL blocks must remain valid nbformat on disk
    assert nb.cells[0].cell_type == "code"
    assert nb.cells[0].metadata["deepnote"]["block_type"] == "sql"

    back = store.notebook_to_document(nb)["cells"][0]
    assert back["cell_type"] == "sql"
    assert back["source"] == "SELECT * FROM t"
    assert back["metadata"]["connection"] == {"type": "sqlite", "db_path": "data.db"}
    assert "block_type" not in back["metadata"]  # surfaced as cell_type, not config
    assert back["execution_count"] == 3


def test_input_and_chart_blocks_roundtrip():
    """Every block type (not just sql) must survive a save/load as its own type."""
    doc = {
        "cells": [
            {
                "id": "i1",
                "cell_type": "input",
                "source": "",
                "outputs": [],
                "metadata": {"input_type": "slider", "var_name": "thresh", "value": 42},
            },
            {
                "id": "g1",
                "cell_type": "chart",
                "source": "",
                "outputs": [],
                "metadata": {"df": "df", "chart_type": "bar", "x": "a", "y": "b"},
            },
        ],
        "metadata": {},
    }
    nb = store.document_to_notebook(doc)
    nbformat.validate(nb)
    back = {c["id"]: c for c in store.notebook_to_document(nb)["cells"]}
    assert back["i1"]["cell_type"] == "input"
    assert back["i1"]["metadata"]["var_name"] == "thresh"
    assert back["g1"]["cell_type"] == "chart"
    assert back["g1"]["metadata"]["chart_type"] == "bar"


def test_save_and_load_document(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)
    doc = {
        "cells": [{"id": "c1", "cell_type": "code", "source": "x=1", "outputs": []}],
        "metadata": {},
    }
    store.save_document("nb-test", doc)
    loaded = store.load_document("nb-test")
    assert loaded["cells"][0]["source"] == "x=1"
    assert (tmp_path / "nb-test.ipynb").exists()


def test_load_seeds_starter_when_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)
    doc = store.load_document("fresh")
    # Starter has a markdown title cell followed by a code cell.
    assert len(doc["cells"]) == 2
    assert doc["cells"][0]["cell_type"] == "markdown"
    assert doc["cells"][1]["cell_type"] == "code"


def _doc(source: str) -> dict:
    return {
        "cells": [{"id": "c1", "cell_type": "code", "source": source, "outputs": []}],
        "metadata": {},
    }


def test_checkpoint_create_list_restore(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)
    store.save_document("nb", _doc("x = 1"))

    cp = store.create_checkpoint("nb")
    assert cp["id"] and cp["last_modified"]

    # Move the notebook forward, then restore the checkpoint.
    store.save_document("nb", _doc("x = 999"))
    assert store.load_document("nb")["cells"][0]["source"] == "x = 999"
    assert any(c["id"] == cp["id"] for c in store.list_checkpoints("nb"))

    restored = store.restore_checkpoint("nb", cp["id"])
    assert restored["cells"][0]["source"] == "x = 1"
    assert store.load_document("nb")["cells"][0]["source"] == "x = 1"


def test_restore_unknown_checkpoint_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)
    store.save_document("nb", _doc("x = 1"))
    with pytest.raises(FileNotFoundError):
        store.restore_checkpoint("nb", "does-not-exist")


# -- multi-notebook management ----------------------------------------- #


def test_list_create_delete_notebooks(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)
    assert store.list_notebooks() == []

    created = store.create_notebook("proj")
    assert created["id"] == "proj"
    assert any(n["id"] == "proj" for n in store.list_notebooks())

    with pytest.raises(FileExistsError):
        store.create_notebook("proj")
    with pytest.raises(ValueError):
        store.create_notebook("bad/id")

    store.delete_notebook("proj")
    assert store.list_notebooks() == []


def test_notebooks_api_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)
    client = TestClient(app)
    assert client.get("/api/notebooks").json() == []

    r = client.post("/api/notebooks", json={"name": "alpha"})
    assert r.status_code == 200 and r.json()["id"] == "alpha"
    assert client.post("/api/notebooks", json={"name": "alpha"}).status_code == 409
    assert any(n["id"] == "alpha" for n in client.get("/api/notebooks").json())
    assert client.delete("/api/notebooks/alpha").json() == {"ok": True}


# -- export ------------------------------------------------------------ #


def test_export_ipynb_and_html(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "NOTEBOOKS_DIR", tmp_path)
    store.save_document("nb", _doc("print('x')"))

    content, media, fname = store.export_notebook("nb", "ipynb")
    assert media == "application/x-ipynb+json" and fname == "nb.ipynb"
    assert b"print" in content

    html, hmedia, hname = store.export_notebook("nb", "html")
    assert hmedia == "text/html" and hname == "nb.html"
    assert b"<html" in html.lower() and b"print" in html

    with pytest.raises(ValueError):
        store.export_notebook("nb", "pdf")
