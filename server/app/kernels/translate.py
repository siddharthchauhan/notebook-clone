"""Translate raw kernel **iopub** messages into client protocol events.

Pure function, no I/O. Given the resolved ``cell_id`` plus a kernel
``msg_type``/``content`` pair, return the matching :data:`ClientEvent`, or
``None`` for iopub message types the client does not consume. Shell-channel
replies (complete/inspect) are built separately in the session, not here.
"""

from __future__ import annotations

from app.models import (
    ClearOutputEvent,
    ClientEvent,
    DisplayEvent,
    ErrorEvent,
    ExecInputEvent,
    StatusEvent,
    StreamEvent,
)


def to_client_event(
    cell_id: str | None, msg_type: str, content: dict
) -> ClientEvent | None:
    """Map one iopub message to a client event (or ``None`` if irrelevant)."""
    if msg_type == "status":
        return StatusEvent(
            cell_id=cell_id,
            execution_state=content.get("execution_state", "unknown"),
        )

    if msg_type == "execute_input":
        return ExecInputEvent(
            cell_id=cell_id,
            execution_count=content.get("execution_count"),
        )

    if msg_type == "stream":
        return StreamEvent(
            cell_id=cell_id,
            name=content.get("name", "stdout"),
            text=content.get("text", ""),
        )

    # execute_result and display_data both carry a MIME bundle; execute_result
    # additionally has an execution_count.
    if msg_type in ("execute_result", "display_data"):
        return DisplayEvent(
            cell_id=cell_id,
            data=content.get("data", {}),
            metadata=content.get("metadata", {}),
            execution_count=content.get("execution_count"),
        )

    if msg_type == "error":
        return ErrorEvent(
            cell_id=cell_id,
            ename=content.get("ename", ""),
            evalue=content.get("evalue", ""),
            traceback=content.get("traceback", []),
        )

    if msg_type == "clear_output":
        return ClearOutputEvent(cell_id=cell_id, wait=content.get("wait", False))

    return None
