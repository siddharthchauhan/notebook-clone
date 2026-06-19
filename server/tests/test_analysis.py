"""Read/write analysis that underpins reactive execution."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.analysis import analyze_source
from app.main import app


def test_reads_and_writes_basic():
    reads, writes = analyze_source("y = x + 1\nz = y * 2")
    assert writes == ["y", "z"]
    assert reads == ["x"]  # y is local-written, builtins excluded


def test_builtins_and_imports_are_not_reads():
    reads, writes = analyze_source("import numpy as np\narr = np.array([1, 2])\nprint(len(arr))")
    assert "np" in writes and "arr" in writes
    # print/len are builtins; np/arr are this cell's writes — none are reads.
    assert reads == []


def test_function_locals_are_not_module_writes_but_globals_are_reads():
    src = "def f(a):\n    return a + scale\n"
    reads, writes = analyze_source(src)
    assert writes == ["f"]  # `a` is a local param, not a module write
    assert reads == ["scale"]  # free global referenced inside the function


def test_syntax_error_yields_no_deps():
    assert analyze_source("def (oops") == ([], [])


def test_analyze_endpoint_returns_deps_per_cell():
    client = TestClient(app)
    r = client.post(
        "/api/analyze",
        json={"cells": [{"id": "a", "source": "x = 10"}, {"id": "b", "source": "print(x * 2)"}]},
    )
    assert r.status_code == 200
    deps = {c["id"]: c for c in r.json()["cells"]}
    assert deps["a"]["writes"] == ["x"] and deps["a"]["reads"] == []
    assert deps["b"]["reads"] == ["x"]  # b depends on a
