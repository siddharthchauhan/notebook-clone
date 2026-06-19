"""FastAPI application entrypoint.

Wires CORS, the contents + kernelspecs REST APIs, and the notebook WebSocket,
and shuts every persistent kernel down on app stop via the lifespan. Run with::

    uv run uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import ws
from app.ai.api import router as ai_router
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

app.include_router(contents_router)
app.include_router(notebooks_router)
app.include_router(kernels_router)
app.include_router(ai_router)
app.include_router(connectors_router)
app.include_router(ws.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
