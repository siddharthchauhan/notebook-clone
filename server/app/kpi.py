"""Big-number / KPI blocks → a styled HTML metric.

A KPI block evaluates a Python *expression* (e.g. ``df['rev'].sum()``) and shows
the result as one big number with a label. The expression is user-authored
Python — exactly like a code cell's source — so it isn't a sandbox boundary; it
is interpolated as-is. The label is emitted as a literal and HTML-escaped at
runtime, and an optional Python format spec (e.g. ``,.2f``) prettifies the value.
The block renders via ``IPython.display.HTML`` so it flows through the normal
output path.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class KpiSpec(BaseModel):
    expression: str
    label: str = ""
    number_format: str = ""  # optional Python format spec, e.g. ",.2f"


def generate_kpi_code(spec: KpiSpec) -> str:
    expr = (spec.expression or "").strip()
    if not expr:
        raise ValueError("a KPI block needs an expression")
    label = spec.label or ""
    fmt = (spec.number_format or "").strip()
    if fmt:
        value_line = (
            f"try:\n    _kpi_text = format(_kpi_val, {fmt!r})\n"
            "except Exception:\n    _kpi_text = str(_kpi_val)\n"
        )
    else:
        value_line = "_kpi_text = str(_kpi_val)\n"
    return (
        "import html as _html\n"
        "from IPython.display import HTML, display\n"
        f"_kpi_val = ({expr})\n"
        f"{value_line}"
        f"_kpi_label = {label!r}\n"
        "display(HTML(\n"
        "    '<div class=\"kpi-card\">'\n"
        "    '<div class=\"kpi-label\">' + _html.escape(_kpi_label) + '</div>'\n"
        "    '<div class=\"kpi-value\">' + _html.escape(_kpi_text) + '</div>'\n"
        "    '</div>'\n"
        "))\n"
    )


# --------------------------------------------------------------------------- #
# endpoint
# --------------------------------------------------------------------------- #
router = APIRouter(prefix="/api/kpi", tags=["kpi"])


class GenerateRequest(BaseModel):
    spec: KpiSpec


@router.post("/generate")
def generate(req: GenerateRequest) -> dict:
    """Render the code for a KPI spec (the UI runs it in the block)."""
    try:
        return {"code": generate_kpi_code(req.spec)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
