"""The ``/ws/{notebook_id}`` WebSocket endpoint.

A connection now *attaches* to a persistent, per-notebook kernel rather than
owning one. Lifecycle:

1. accept the socket (optional ``?kernel=`` query selects the kernelspec on
   first connect);
2. get-or-create the notebook's :class:`KernelSession` and subscribe this
   socket to its broadcast;
3. announce kernel readiness, then loop dispatching requests;
4. on disconnect, only *unsubscribe* — the kernel stays alive for the next
   connection.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from app.kernels.manager import registry
from app.kernels.session import KernelSession
from app.models import (
    ClientRequest,
    CompleteRequest,
    ExecuteRequest,
    InspectRequest,
    InterruptRequest,
    KernelStatusEvent,
    RestartRequest,
    VariablesRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()

_request_adapter: TypeAdapter[ClientRequest] = TypeAdapter(ClientRequest)


@router.websocket("/ws/{notebook_id}")
async def notebook_ws(websocket: WebSocket, notebook_id: str) -> None:
    await websocket.accept()
    kernel_name = websocket.query_params.get("kernel") or None
    logger.info("ws open: notebook=%s kernel=%s", notebook_id, kernel_name)

    try:
        session = await registry.get_or_create(notebook_id, kernel_name)
    except Exception:
        logger.exception("failed to start kernel for notebook=%s", notebook_id)
        await websocket.close(code=1011, reason="kernel failed to start")
        return

    async def send(event: dict) -> None:
        await websocket.send_json(event)

    session.subscribe(send)
    # Tell the just-connected client the kernel is up and which one it is.
    await send(
        KernelStatusEvent(state="ready", kernel_name=session.kernel_name).model_dump()
    )

    try:
        while True:
            raw = await websocket.receive_json()
            try:
                request = _request_adapter.validate_python(raw)
            except ValidationError as exc:
                logger.warning("ignoring malformed message: %s", exc)
                continue
            await _dispatch(session, request)
    except WebSocketDisconnect:
        logger.info("ws closed by client: notebook=%s", notebook_id)
    except Exception:
        logger.exception("ws error: notebook=%s", notebook_id)
    finally:
        # Persistent kernel: detach only, never shut down here.
        session.unsubscribe(send)


async def _dispatch(session: KernelSession, request: ClientRequest) -> None:
    """Route a validated inbound request to the kernel session."""
    if isinstance(request, ExecuteRequest):
        session.execute(request.cell_id, request.code)
    elif isinstance(request, CompleteRequest):
        session.complete(request.request_id, request.code, request.cursor_pos)
    elif isinstance(request, InspectRequest):
        session.inspect(
            request.request_id, request.code, request.cursor_pos, request.detail_level
        )
    elif isinstance(request, VariablesRequest):
        session.inspect_variables(request.request_id)
    elif isinstance(request, InterruptRequest):
        await session.interrupt()
    elif isinstance(request, RestartRequest):
        # Run restart concurrently so the receive loop keeps draining the
        # socket (the restart broadcasts its own status events).
        asyncio.create_task(session.restart())
