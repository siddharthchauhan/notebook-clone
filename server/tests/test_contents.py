"""Tests for the document <-> nbformat mapping and persistence."""

from __future__ import annotations

import nbformat
import pytest

from app.contents import store


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
