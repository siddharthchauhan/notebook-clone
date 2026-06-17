"""FastAPI application entrypoint.

Wires CORS (for the Vite dev origin on the REST routes), the contents API, and
the notebook WebSocket. Run with::

    uv run uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import ws
from app.config import settings
from app.contents.api import router as contents_router

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="notebook-clone", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(contents_router)
app.include_router(ws.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
