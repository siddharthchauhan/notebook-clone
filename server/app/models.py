"""Wire protocol between the browser and the server (spec §4.3).

There are two directions:

* **client → server**: :class:`ExecuteRequest` (the only inbound message in
  Phase 1).
* **server → client**: a discriminated union of events
  (:data:`ClientEvent`) tagged by the ``type`` field.

Every server→client event carries a ``cell_id`` so the browser can route the
output to the correct cell. It is ``str | None`` on purpose: kernel-initiated
messages (for example the kernel's own ``starting``/``idle`` status at boot)
have no originating cell, so their ``parent_header.msg_id`` resolves to
``None``. The frontend simply ignores ``None`` when fanning out to cells.

The TypeScript mirror of these types lives in ``web/src/lib/protocol.ts`` and
must be kept in sync by hand.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- #
# client → server
# --------------------------------------------------------------------------- #


class ExecuteRequest(BaseModel):
    """Run ``code`` for the cell identified by ``cell_id``."""

    type: Literal["execute_request"] = "execute_request"
    cell_id: str
    code: str


# Inbound is a one-member union today, but modelling it as a union keeps the
# WS dispatch logic uniform when interrupt/restart requests arrive in Phase 2.
ClientRequest = Annotated[
    Union[ExecuteRequest],
    Field(discriminator="type"),
]


# --------------------------------------------------------------------------- #
# server → client
# --------------------------------------------------------------------------- #


class StatusEvent(BaseModel):
    """Kernel execution state for a cell: ``busy``/``idle`` (or ``starting``).

    Drives the per-cell busy spinner. ``busy`` → show spinner, ``idle`` →
    clear it.
    """

    type: Literal["status"] = "status"
    cell_id: str | None
    execution_state: str  # "starting" | "busy" | "idle"


class StreamEvent(BaseModel):
    """A chunk of ``stdout``/``stderr`` text.

    Critically *append-only*: the frontend concatenates ``text`` onto the
    cell's existing stream buffer, never replaces it.
    """

    type: Literal["stream"] = "stream"
    cell_id: str | None
    name: str  # "stdout" | "stderr"
    text: str


class DisplayEvent(BaseModel):
    """A rich MIME bundle from ``execute_result`` or ``display_data``.

    ``data`` maps MIME type → payload, e.g. ``{"text/plain": "...",
    "image/png": "<base64>"}``. Phase 1 renderers consume ``text/plain`` and
    ``image/png``.
    """

    type: Literal["display"] = "display"
    cell_id: str | None
    data: dict[str, Any]
    metadata: dict[str, Any] = Field(default_factory=dict)


class ErrorEvent(BaseModel):
    """An exception raised during execution (kernel ``error`` message)."""

    type: Literal["error"] = "error"
    cell_id: str | None
    ename: str
    evalue: str
    traceback: list[str]


ClientEvent = Annotated[
    Union[StatusEvent, StreamEvent, DisplayEvent, ErrorEvent],
    Field(discriminator="type"),
]
