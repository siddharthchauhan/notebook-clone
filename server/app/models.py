"""Wire protocol between the browser and the server.

Two directions, each a discriminated union tagged by ``type``:

* **client → server** (:data:`ClientRequest`): execute, interrupt, restart, and
  the request/reply pairs complete + inspect.
* **server → client** (:data:`ClientEvent`): kernel/cell status, outputs
  (stream/display/error), exec-input prompts, clear-output, and the
  complete/inspect replies.

Every cell-scoped event carries ``cell_id`` so the browser can route output to
the right cell; it is ``str | None`` because kernel-initiated messages have no
owning cell. The complete/inspect replies instead carry a globally-unique
``request_id`` (a client-generated UUID) so a reply can be broadcast to all
attached sockets and matched only by the originating client.

The TypeScript mirror lives in ``web/src/lib/protocol.ts``; keep them in sync.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- #
# client → server
# --------------------------------------------------------------------------- #


class ExecuteRequest(BaseModel):
    type: Literal["execute_request"] = "execute_request"
    cell_id: str
    code: str


class InterruptRequest(BaseModel):
    type: Literal["interrupt_request"] = "interrupt_request"


class RestartRequest(BaseModel):
    type: Literal["restart_request"] = "restart_request"


class CompleteRequest(BaseModel):
    type: Literal["complete_request"] = "complete_request"
    request_id: str
    code: str
    cursor_pos: int


class InspectRequest(BaseModel):
    type: Literal["inspect_request"] = "inspect_request"
    request_id: str
    code: str
    cursor_pos: int
    detail_level: int = 0


class VariablesRequest(BaseModel):
    """Ask the kernel to introspect its user-defined globals (var explorer)."""

    type: Literal["variables_request"] = "variables_request"
    request_id: str


class DeleteVariableRequest(BaseModel):
    """Delete one global from the kernel, then re-introspect (var explorer)."""

    type: Literal["delete_variable_request"] = "delete_variable_request"
    request_id: str
    name: str


ClientRequest = Annotated[
    Union[
        ExecuteRequest,
        InterruptRequest,
        RestartRequest,
        CompleteRequest,
        InspectRequest,
        VariablesRequest,
        DeleteVariableRequest,
    ],
    Field(discriminator="type"),
]


# --------------------------------------------------------------------------- #
# server → client
# --------------------------------------------------------------------------- #


class StatusEvent(BaseModel):
    """Per-cell execution state: ``busy``/``idle`` (drives the cell spinner)."""

    type: Literal["status"] = "status"
    cell_id: str | None
    execution_state: str  # "starting" | "busy" | "idle"


class ExecInputEvent(BaseModel):
    """The kernel accepted a cell for execution; carries its ``[n]`` prompt."""

    type: Literal["exec_input"] = "exec_input"
    cell_id: str | None
    execution_count: int | None = None


class StreamEvent(BaseModel):
    """Append-only chunk of ``stdout``/``stderr`` text."""

    type: Literal["stream"] = "stream"
    cell_id: str | None
    name: str
    text: str


class DisplayEvent(BaseModel):
    """A rich MIME bundle from ``execute_result`` or ``display_data``."""

    type: Literal["display"] = "display"
    cell_id: str | None
    data: dict[str, Any]
    metadata: dict[str, Any] = Field(default_factory=dict)
    execution_count: int | None = None


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    cell_id: str | None
    ename: str
    evalue: str
    traceback: list[str]


class ClearOutputEvent(BaseModel):
    """Kernel asked to clear a cell's output (``wait`` defers until next write)."""

    type: Literal["clear_output"] = "clear_output"
    cell_id: str | None
    wait: bool = False


class KernelStatusEvent(BaseModel):
    """Kernel lifecycle, distinct from per-cell execution state.

    ``state`` is one of ``ready`` | ``restarting`` | ``dead``.
    """

    type: Literal["kernel_status"] = "kernel_status"
    state: str
    kernel_name: str | None = None


class CompleteReplyEvent(BaseModel):
    type: Literal["complete_reply"] = "complete_reply"
    request_id: str
    matches: list[str]
    cursor_start: int
    cursor_end: int


class InspectReplyEvent(BaseModel):
    type: Literal["inspect_reply"] = "inspect_reply"
    request_id: str
    found: bool
    data: dict[str, Any]


class VariablesReplyEvent(BaseModel):
    """The kernel's current user-defined globals: ``{name, type, repr, size?}``."""

    type: Literal["variables_reply"] = "variables_reply"
    request_id: str
    variables: list[dict[str, Any]]


ClientEvent = Annotated[
    Union[
        StatusEvent,
        ExecInputEvent,
        StreamEvent,
        DisplayEvent,
        ErrorEvent,
        ClearOutputEvent,
        KernelStatusEvent,
        CompleteReplyEvent,
        InspectReplyEvent,
        VariablesReplyEvent,
    ],
    Field(discriminator="type"),
]
