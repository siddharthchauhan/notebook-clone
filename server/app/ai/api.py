"""REST + SSE routes for AI assist (Phase 3).

* ``GET  /api/ai/status``   → ``{available, model}`` so the UI can gate its
  AI controls (hidden when no key is configured).
* ``POST /api/ai/complete`` → a Server-Sent Events stream of the model's
  response: ``token`` events carry text deltas, ``done`` ends a clean run, and
  ``error`` reports a mid-stream failure without a broken 500.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.ai.service import AIRequest, ChatRequest, service
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/status")
def ai_status() -> dict:
    return {"available": service.available(), "model": settings.ai_model}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _sse_response(deltas: AsyncIterator[str]) -> StreamingResponse:
    """Wrap a text-delta stream as an SSE response (token / done / error)."""

    async def gen():
        try:
            async for delta in deltas:
                yield _sse("token", {"text": delta})
            yield _sse("done", {})
        except Exception as exc:  # surface as an SSE error, not a torn 500
            logger.exception("ai stream failed")
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        # Defeat proxy/browser buffering so tokens arrive as they're produced.
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/complete")
async def ai_complete(req: AIRequest) -> StreamingResponse:
    if not service.available():
        raise HTTPException(status_code=503, detail="AI is not configured")
    return _sse_response(service.stream(req))


@router.post("/chat")
async def ai_chat(req: ChatRequest) -> StreamingResponse:
    if not service.available():
        raise HTTPException(status_code=503, detail="AI is not configured")
    return _sse_response(service.chat(req))
