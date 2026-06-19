"""Big-number / KPI block code generation."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.kpi import KpiSpec, generate_kpi_code
from app.main import app


def test_kpi_evaluates_expression_and_labels_it():
    code = generate_kpi_code(KpiSpec(expression="df['rev'].sum()", label="Revenue"))
    assert "_kpi_val = (df['rev'].sum())" in code
    assert "_kpi_label = 'Revenue'" in code
    assert "display(HTML(" in code and "kpi-value" in code


def test_kpi_applies_number_format_when_given():
    code = generate_kpi_code(KpiSpec(expression="total", number_format=",.2f"))
    assert "format(_kpi_val, ',.2f')" in code


def test_kpi_without_format_stringifies():
    code = generate_kpi_code(KpiSpec(expression="n"))
    assert "_kpi_text = str(_kpi_val)" in code


def test_empty_expression_rejected():
    with pytest.raises(ValueError):
        generate_kpi_code(KpiSpec(expression="  "))


def test_kpi_endpoint_and_400():
    client = TestClient(app)
    ok = client.post("/api/kpi/generate", json={"spec": {"expression": "1 + 1", "label": "Two"}})
    assert ok.status_code == 200 and "_kpi_val = (1 + 1)" in ok.json()["code"]

    bad = client.post("/api/kpi/generate", json={"spec": {"expression": ""}})
    assert bad.status_code == 400
