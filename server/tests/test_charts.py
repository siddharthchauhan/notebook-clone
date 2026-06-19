"""Chart-block code generation (no-code → matplotlib)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.charts import ChartSpec, generate_chart_code
from app.main import app


def test_line_chart_uses_columns_as_literals():
    code = generate_chart_code(ChartSpec(df="sales", chart_type="line", x="month", y="rev"))
    assert "sales.plot(kind='line'" in code
    assert "x='month'" in code and "y='rev'" in code
    assert "%matplotlib inline" in code and "plt.show()" in code


def test_scatter_requires_both_axes():
    with pytest.raises(ValueError):
        generate_chart_code(ChartSpec(df="df", chart_type="scatter", x="a"))


def test_rejects_non_identifier_dataframe():
    with pytest.raises(ValueError):
        generate_chart_code(ChartSpec(df="df; import os", chart_type="bar", x="a", y="b"))


def test_column_names_are_quoted_not_injected():
    # A column name with a quote is emitted as a safe literal, never raw.
    code = generate_chart_code(ChartSpec(df="df", chart_type="bar", x="a'b", y="c"))
    assert "x='a\\'b'" in code or 'x="a\'b"' in code


def test_generate_endpoint_and_400():
    client = TestClient(app)
    ok = client.post(
        "/api/charts/generate",
        json={"spec": {"df": "df", "chart_type": "bar", "x": "a", "y": "b"}},
    )
    assert ok.status_code == 200 and "df.plot(kind='bar'" in ok.json()["code"]

    bad = client.post(
        "/api/charts/generate",
        json={"spec": {"df": "1bad", "chart_type": "bar", "x": "a", "y": "b"}},
    )
    assert bad.status_code == 400
