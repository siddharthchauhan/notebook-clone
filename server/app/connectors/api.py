"""REST endpoints for data connectors.

* ``GET  /api/connectors`` — the catalog: each source's form fields plus whether
  its dependencies are installed (so the UI can disable unavailable ones).
* ``POST /api/connectors/generate`` — render loader code for chosen params. The
  frontend drops the returned code into a new, editable cell and runs it.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.connectors import registry

router = APIRouter(prefix="/api/connectors", tags=["connectors"])


@router.get("")
def list_connectors() -> dict:
    return {
        "connectors": [
            {
                "id": c.id,
                "label": c.label,
                "available": registry.available(c),
                "missing": registry.missing(c),
                "note": c.note,
                "fields": [
                    {
                        "name": f.name,
                        "label": f.label,
                        "placeholder": f.placeholder,
                        "default": f.default,
                        "required": f.required,
                    }
                    for f in c.fields
                ],
            }
            for c in registry.CONNECTORS
        ]
    }


class GenerateRequest(BaseModel):
    type: str
    params: dict[str, str] = {}


@router.post("/generate")
def generate(req: GenerateRequest) -> dict:
    try:
        code = registry.generate(req.type, req.params)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown connector")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"code": code}
