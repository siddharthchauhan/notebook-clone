"""Translate raw kernel iopub messages into client protocol events (spec §4).

Pure function, no I/O: given the resolved ``cell_id`` plus a kernel
``msg_type``/``content`` pair, return the matching :data:`ClientEvent` model,
or ``None`` for message types Phase 1 does not surface (``execute_input``,
``clear_output``, comm messages, …). The WS layer skips ``None`` results.
"""

from __future__ import annotations

from app.models import (
    ClientEvent,
    DisplayEvent,
    ErrorEvent,
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

    if msg_type == "stream":
        return StreamEvent(
            cell_id=cell_id,
            name=content.get("name", "stdout"),
            text=content.get("text", ""),
        )

    # execute_result and display_data both carry a MIME bundle; the only
    # difference is execute_result has an execution_count, which Phase 1 does
    # not render. Collapse them into one DisplayEvent.
    if msg_type in ("execute_result", "display_data"):
        return DisplayEvent(
            cell_id=cell_id,
            data=content.get("data", {}),
            metadata=content.get("metadata", {}),
        )

    if msg_type == "error":
        return ErrorEvent(
            cell_id=cell_id,
            ename=content.get("ename", ""),
            evalue=content.get("evalue", ""),
            traceback=content.get("traceback", []),
        )

    return None
