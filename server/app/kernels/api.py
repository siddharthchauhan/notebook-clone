"""REST route for kernel discovery (kernel picker).

``GET /api/kernelspecs`` lists the installed Jupyter kernelspecs so the frontend
can offer a kernel picker. The chosen name is passed back on the WebSocket as
``/ws/{id}?kernel=<name>`` when the notebook's session is first created.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from jupyter_client.kernelspec import KernelSpecManager

from app.config import settings

router = APIRouter(prefix="/api", tags=["kernels"])


@router.get("/kernelspecs")
def list_kernelspecs() -> dict[str, Any]:
    ksm = KernelSpecManager()
    specs = ksm.get_all_specs()
    kernels = [
        {
            "name": name,
            "display_name": info["spec"].get("display_name", name),
            "language": info["spec"].get("language", ""),
        }
        for name, info in sorted(specs.items())
    ]
    return {"default": settings.default_kernel_name, "kernelspecs": kernels}
