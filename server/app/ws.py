"""The ``/ws/{notebook_id}`` WebSocket endpoint (spec §4.2).

Lifecycle of one connection:

1. accept the socket;
2. start a :class:`KernelSession` (one kernel per connection in Phase 1);
3. spawn the single ``pump_iopub`` task, whose callback translates each
   message and ``send_json``\\s it to the browser;
4. loop receiving ``execute_request``\\s and submitting them to the kernel;
5. on disconnect (or any error) cancel the pump and shut the kernel down in a
   ``finally`` so no kernel process is ever leaked.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from app.kernels.session import KernelSession
from app.kernels.translate import to_client_event
from app.models import ClientRequest, ExecuteRequest

logger = logging.getLogger(__name__)

router = APIRouter()

_request_adapter: TypeAdapter[ClientRequest] = TypeAdapter(ClientRequest)


@router.websocket("/ws/{notebook_id}")
async def notebook_ws(websocket: WebSocket, notebook_id: str) -> None:
    await websocket.accept()
    logger.info("ws open: notebook=%s", notebook_id)

    session = KernelSession()
    try:
        await session.start()
    except Exception:
        logger.exception("failed to start kernel for notebook=%s", notebook_id)
        await websocket.close(code=1011, reason="kernel failed to start")
        return

    async def on_event(cell_id: str | None, msg_type: str, content: dict) -> None:
        event = to_client_event(cell_id, msg_type, content)
        if event is None:
            return  # message type not surfaced in Phase 1
        await websocket.send_json(event.model_dump())

    pump_task = asyncio.create_task(session.pump_iopub(on_event))
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
        pump_task.cancel()
        try:
            await pump_task
        except asyncio.CancelledError:
            pass
        await session.shutdown()


async def _dispatch(session: KernelSession, request: ClientRequest) -> None:
    """Route a validated inbound request to the kernel session."""
    if isinstance(request, ExecuteRequest):
        session.execute(request.cell_id, request.code)
