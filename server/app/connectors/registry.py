"""Data connectors: generate an editable cell that loads a source into a
DataFrame.

Each :class:`Connector` declares its form fields and the third-party modules it
needs, plus a ``template`` that renders Python code from validated params. The
frontend renders the fields generically, POSTs the params back, and inserts the
returned code as a normal cell — so the loader is transparent and editable, not
hidden magic. Adding a source is just one more :class:`Connector` in the list.

Params are interpolated with ``repr()`` (safe Python string literals), and the
target variable name is validated as an identifier, so a connector cannot inject
arbitrary code beyond the SQL/paths the user themselves typed.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Callable
from dataclasses import dataclass


@dataclass
class Field:
    name: str
    label: str
    placeholder: str = ""
    default: str = ""
    required: bool = True


@dataclass
class Connector:
    id: str
    label: str
    fields: list[Field]
    requires: list[str]  # importable modules needed beyond pandas
    template: Callable[[dict[str, str]], str]
    note: str = ""


def _has(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


# Every connector targets a DataFrame variable.
VAR = Field("var", "Variable name", "df", "df")


def _sqlite(p: dict[str, str]) -> str:
    return (
        "import sqlite3\n"
        "import pandas as pd\n"
        f"_conn = sqlite3.connect({p['db_path']!r})\n"
        f"{p['var']} = pd.read_sql_query({p['query']!r}, _conn)\n"
        "_conn.close()\n"
        f"{p['var']}.head()\n"
    )


def _file(p: dict[str, str]) -> str:
    path = p["path"]
    low = path.lower()
    if low.endswith(".json"):
        reader = f"pd.read_json({path!r})"
    elif low.endswith((".tsv", ".tab")):
        reader = f"pd.read_csv({path!r}, sep='\\t')"
    else:
        reader = f"pd.read_csv({path!r})"
    return f"import pandas as pd\n{p['var']} = {reader}\n{p['var']}.head()\n"


def _http(p: dict[str, str]) -> str:
    url = p["url"]
    reader = (
        f"pd.read_json({url!r})"
        if url.lower().endswith(".json")
        else f"pd.read_csv({url!r})"
    )
    return f"import pandas as pd\n{p['var']} = {reader}\n{p['var']}.head()\n"


def _sqlalchemy(p: dict[str, str]) -> str:
    return (
        "import pandas as pd\n"
        "from sqlalchemy import create_engine\n"
        f"_engine = create_engine({p['url']!r})\n"
        f"{p['var']} = pd.read_sql_query({p['query']!r}, _engine)\n"
        f"{p['var']}.head()\n"
    )


def _parquet(p: dict[str, str]) -> str:
    return (
        f"import pandas as pd\n{p['var']} = pd.read_parquet({p['path']!r})\n"
        f"{p['var']}.head()\n"
    )


def _excel(p: dict[str, str]) -> str:
    sheet = p.get("sheet") or ""
    arg = f", sheet_name={sheet!r}" if sheet else ""
    return (
        f"import pandas as pd\n{p['var']} = pd.read_excel({p['path']!r}{arg})\n"
        f"{p['var']}.head()\n"
    )


CONNECTORS: list[Connector] = [
    Connector(
        "sqlite",
        "SQLite database",
        [
            VAR,
            Field("db_path", "Database file", "data.db"),
            Field(
                "query",
                "SQL query",
                "SELECT * FROM table LIMIT 100",
                "SELECT name FROM sqlite_master WHERE type='table'",
            ),
        ],
        [],
        _sqlite,
    ),
    Connector(
        "file",
        "CSV / JSON file",
        [VAR, Field("path", "File path", "data.csv")],
        [],
        _file,
        note="Picks read_csv / read_json / TSV by file extension.",
    ),
    Connector(
        "http",
        "HTTP URL (CSV/JSON)",
        [VAR, Field("url", "URL", "https://example.com/data.csv")],
        [],
        _http,
    ),
    Connector(
        "sqlalchemy",
        "SQL database (SQLAlchemy)",
        [
            VAR,
            Field("url", "Connection URL", "postgresql://user:pass@host:5432/db"),
            Field("query", "SQL query", "SELECT * FROM table LIMIT 100"),
        ],
        ["sqlalchemy"],
        _sqlalchemy,
        note="Any SQLAlchemy-supported DB; the matching driver must be installed.",
    ),
    Connector(
        "parquet",
        "Parquet file",
        [VAR, Field("path", "File path", "data.parquet")],
        ["pyarrow"],
        _parquet,
    ),
    Connector(
        "excel",
        "Excel file",
        [
            VAR,
            Field("path", "File path", "data.xlsx"),
            Field("sheet", "Sheet name (optional)", "Sheet1", "", required=False),
        ],
        ["openpyxl"],
        _excel,
    ),
]


def find(connector_id: str) -> Connector | None:
    return next((c for c in CONNECTORS if c.id == connector_id), None)


def available(c: Connector) -> bool:
    return _has("pandas") and all(_has(m) for m in c.requires)


def missing(c: Connector) -> list[str]:
    miss = [] if _has("pandas") else ["pandas"]
    miss += [m for m in c.requires if not _has(m)]
    return miss


def generate(connector_id: str, params: dict[str, str]) -> str:
    """Render a connector's loader code from user params (validated)."""
    c = find(connector_id)
    if c is None:
        raise KeyError(connector_id)
    var = (params.get("var") or "df").strip()
    if not var.isidentifier():
        raise ValueError("variable name must be a valid Python identifier")
    merged = {f.name: (params.get(f.name) or f.default).strip() for f in c.fields}
    merged["var"] = var
    for f in c.fields:
        if f.required and not merged.get(f.name):
            raise ValueError(f"missing required field: {f.label}")
    return c.template(merged)
