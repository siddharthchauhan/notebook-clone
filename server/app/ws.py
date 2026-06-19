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
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from app.kernels.manager import registry
from app.kernels.session import KernelSession
from app.models import (
    ClientRequest,
    ColumnsRequest,
    CommCloseRequest,
    CommMsgRequest,
    CommOpenRequest,
    CompleteRequest,
    DeleteVariableRequest,
    DocOpRequest,
    ExecuteRequest,
    InspectRequest,
    InterruptRequest,
    KernelStatusEvent,
    RestartRequest,
    SetVariableRequest,
    VariableChildrenRequest,
    VariablesRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()

_request_adapter: TypeAdapter[ClientRequest] = TypeAdapter(ClientRequest)

# Distinct colors for collaborator cursors/avatars (cycled by join order).
_PRESENCE_COLORS = [
    "#ef4444", "#f59e0b", "#10b981", "#3b82f6",
    "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
]


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

    # Identify this client for presence (server-assigned id + color; name optional).
    client_id = uuid.uuid4().hex[:8]
    presence = {
        "client_id": client_id,
        "name": websocket.query_params.get("name") or "Guest",
        "color": _PRESENCE_COLORS[session.subscriber_count % len(_PRESENCE_COLORS)],
    }
    session.subscribe(send, presence)
    # Tell the just-connected client the kernel is up and which one it is.
    await send(
        KernelStatusEvent(state="ready", kernel_name=session.kernel_name).model_dump()
    )
    await session.broadcast_presence()  # announce the new collaborator to everyone

    try:
        while True:
            raw = await websocket.receive_json()
            try:
                request = _request_adapter.validate_python(raw)
            except ValidationError as exc:
                logger.warning("ignoring malformed message: %s", exc)
                continue
            await _dispatch(session, request, send)
    except WebSocketDisconnect:
        logger.info("ws closed by client: notebook=%s", notebook_id)
    except Exception:
        logger.exception("ws error: notebook=%s", notebook_id)
    finally:
        # Persistent kernel: detach only, never shut down here.
        session.unsubscribe(send)
        await session.broadcast_presence()  # they left — update everyone's roster


async def _dispatch(session: KernelSession, request: ClientRequest, sender) -> None:
    """Route a validated inbound request to the kernel session."""
    if isinstance(request, DocOpRequest):
        # Relay a document edit to the *other* collaborators (not the sender).
        await session.relay({"type": "doc_op", "op": request.op}, exclude=sender)
    elif isinstance(request, ExecuteRequest):
        session.execute(request.cell_id, request.code)
    elif isinstance(request, CompleteRequest):
        session.complete(request.request_id, request.code, request.cursor_pos)
    elif isinstance(request, InspectRequest):
        session.inspect(
            request.request_id, request.code, request.cursor_pos, request.detail_level
        )
    elif isinstance(request, VariablesRequest):
        session.inspect_variables(request.request_id)
    elif isinstance(request, DeleteVariableRequest):
        session.delete_variable(request.request_id, request.name)
    elif isinstance(request, VariableChildrenRequest):
        session.variable_children(request.request_id, request.name)
    elif isinstance(request, SetVariableRequest):
        session.set_variable(request.request_id, request.name, request.value)
    elif isinstance(request, ColumnsRequest):
        session.df_columns(request.request_id, request.name)
    elif isinstance(request, CommOpenRequest):
        session.comm_open(
            request.comm_id,
            request.target_name,
            request.data,
            request.metadata,
            request.buffers,
        )
    elif isinstance(request, CommMsgRequest):
        session.comm_msg(request.comm_id, request.data, request.buffers)
    elif isinstance(request, CommCloseRequest):
        session.comm_close(request.comm_id, request.data)
    elif isinstance(request, InterruptRequest):
        await session.interrupt()
    elif isinstance(request, RestartRequest):
        # Run restart concurrently so the receive loop keeps draining the
        # socket (the restart broadcasts its own status events).
        asyncio.create_task(session.restart())
