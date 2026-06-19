"""Data connectors: the catalog endpoint, code generation, and validation."""

from __future__ import annotations

import ast

import pytest
from fastapi.testclient import TestClient

from app.connectors import registry
from app.main import app

client = TestClient(app)


def test_catalog_lists_connectors_with_fields_and_availability():
    body = client.get("/api/connectors").json()
    by_id = {c["id"]: c for c in body["connectors"]}
    assert {"sqlite", "file", "http", "sqlalchemy", "parquet", "excel"} <= by_id.keys()
    # Every connector exposes a target-variable field first.
    assert by_id["sqlite"]["fields"][0]["name"] == "var"
    # Deps are installed in the test env, so all report available.
    assert all(c["available"] for c in body["connectors"])


def test_generate_sqlite_emits_read_sql_with_quoted_params():
    code = registry.generate(
        "sqlite", {"var": "sales", "db_path": "shop.db", "query": "SELECT * FROM t"}
    )
    assert "import sqlite3" in code
    assert "sales = pd.read_sql_query('SELECT * FROM t'" in code
    assert "sqlite3.connect('shop.db')" in code


def test_generate_file_dispatches_by_extension():
    csv = registry.generate("file", {"var": "df", "path": "a.csv"})
    assert "pd.read_csv('a.csv')" in csv
    js = registry.generate("file", {"var": "df", "path": "a.json"})
    assert "pd.read_json('a.json')" in js


def test_generate_rejects_non_identifier_variable():
    with pytest.raises(ValueError):
        registry.generate("sqlite", {"var": "df; import os", "db_path": "x", "query": "q"})


def test_generate_requires_mandatory_fields():
    with pytest.raises(ValueError):
        registry.generate("sqlite", {"var": "df", "db_path": "", "query": "q"})


def test_generate_quotes_injection_attempts_safely():
    # A path containing quotes / fake statements must stay a single string
    # literal: the generated code parses to exactly import + assign + preview,
    # and imports nothing but pandas (no injected `import os`).
    code = registry.generate("file", {"var": "df", "path": "a'); import os #.csv"})
    tree = ast.parse(code)  # valid Python, didn't break out of the literal
    assert len(tree.body) == 3
    imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    assert imported == {"pandas"}


def test_generate_endpoint_400_on_bad_variable():
    resp = client.post(
        "/api/connectors/generate",
        json={"type": "sqlite", "params": {"var": "1bad", "db_path": "x", "query": "q"}},
    )
    assert resp.status_code == 400


def test_generate_endpoint_404_on_unknown_connector():
    resp = client.post("/api/connectors/generate", json={"type": "nope", "params": {}})
    assert resp.status_code == 404
