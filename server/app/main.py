"""FastAPI application entrypoint.

Wires CORS, the contents + kernelspecs REST APIs, and the notebook WebSocket,
and shuts every persistent kernel down on app stop via the lifespan. Run with::

    uv run uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import ws
from app.ai.api import router as ai_router
from app.auth import router as auth_router, token_ok
from app.analysis import router as analysis_router
from app.charts import router as charts_router
from app.kpi import router as kpi_router
from app.comments import router as comments_router
from app.config import settings
from app.connectors.api import router as connectors_router
from app.contents.api import notebooks_router
from app.contents.api import router as contents_router
from app.kernels.api import router as kernels_router
from app.kernels.manager import registry

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    # Tear down every persistent kernel on shutdown so none are leaked.
    await registry.shutdown_all()


app = FastAPI(title="notebook-clone", version="0.4.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_token(request: Request, call_next):
    """Gate ``/api/*`` behind the shared token when one is configured.

    No-op when auth is off. ``/api/auth`` stays public so the UI can discover
    whether a token is required; OPTIONS (CORS preflight) is always allowed.
    """
    path = request.url.path
    if (
        request.method != "OPTIONS"
        and path.startswith("/api")
        and not path.startswith("/api/auth")
        and not token_ok(request)
    ):
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


app.include_router(auth_router)
app.include_router(contents_router)
app.include_router(notebooks_router)
app.include_router(kernels_router)
app.include_router(ai_router)
app.include_router(connectors_router)
app.include_router(analysis_router)
app.include_router(charts_router)
app.include_router(kpi_router)
app.include_router(comments_router)
app.include_router(ws.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
