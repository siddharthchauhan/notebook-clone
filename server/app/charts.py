"""No-code chart blocks → matplotlib code.

A chart block names a DataFrame variable, a chart type, and X/Y columns; we
compile that to matplotlib and run it through the normal execute path, so the
figure renders inline as a PNG (the same output path every plot uses). The
DataFrame name is validated as an identifier and column names are emitted via
``repr`` (safe string literals), so a chart block can't inject code.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

CHART_TYPES = ["line", "bar", "area", "scatter", "hist"]


class ChartSpec(BaseModel):
    df: str
    chart_type: str = "line"
    x: str = ""
    y: str = ""
    title: str = ""


def generate_chart_code(spec: ChartSpec) -> str:
    df = (spec.df or "").strip()
    if not df.isidentifier():
        raise ValueError("data frame must be a valid variable name")
    kind = spec.chart_type if spec.chart_type in CHART_TYPES else "line"
    x = (spec.x or "").strip()
    y = (spec.y or "").strip()

    if kind == "scatter":
        if not x or not y:
            raise ValueError("scatter charts need both an X and a Y column")
        plot = f"{df}.plot(kind='scatter', x={x!r}, y={y!r}, ax=_ax)"
    elif kind == "hist":
        col = y or x
        if not col:
            raise ValueError("a histogram needs a column")
        plot = f"{df}[{col!r}].plot(kind='hist', ax=_ax)"
    else:  # line, bar, area
        args = [f"kind={kind!r}"]
        if x:
            args.append(f"x={x!r}")
        if y:
            args.append(f"y={y!r}")
        args.append("ax=_ax")
        plot = f"{df}.plot({', '.join(args)})"

    title = (spec.title or "").strip() or f"{kind.title()} chart"
    return (
        "%matplotlib inline\n"
        "import matplotlib.pyplot as plt\n"
        "_fig, _ax = plt.subplots(figsize=(7, 4))\n"
        f"{plot}\n"
        f"_ax.set_title({title!r})\n"
        "plt.tight_layout()\n"
        "plt.show()\n"
    )


# --------------------------------------------------------------------------- #
# endpoint
# --------------------------------------------------------------------------- #
router = APIRouter(prefix="/api/charts", tags=["charts"])


class GenerateRequest(BaseModel):
    spec: ChartSpec


@router.get("")
def chart_types() -> dict:
    """The chart types the UI offers."""
    return {"chart_types": CHART_TYPES}


@router.post("/generate")
def generate(req: GenerateRequest) -> dict:
    """Render matplotlib code for a chart spec (the UI runs it in the block)."""
    try:
        return {"code": generate_chart_code(req.spec)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
