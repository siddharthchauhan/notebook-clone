"""A persistent kernel and the cell-correlation machinery.

A :class:`KernelSession` owns one kernel process for the lifetime of a
notebook — it survives WebSocket disconnects (Phase 2 made kernels persistent;
Phase 1 tied a kernel to a single connection). It runs exactly **one** reader
per channel:

* the **iopub pump** drains outputs/status and broadcasts them to every
  attached subscriber, resolving each message's ``parent_header.msg_id`` to a
  cell via :attr:`msg_to_cell` — the single source of truth for output↔cell
  correlation under concurrency;
* the **shell pump** drains ``complete_reply``/``inspect_reply`` and routes them
  back by the originating request's ``request_id``.

Multiple readers of a channel would race and silently drop messages, so there
is one pump each and a fan-out (:meth:`_broadcast`) to N sockets. Restart is the
one place this matters subtly: ``wait_for_ready`` also reads the channels, so
restart *pauses the pumps*, waits cleanly, then resumes them.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from jupyter_client import AsyncKernelManager

from app.config import settings
from app.kernels.translate import to_client_event
from app.models import (
    CommCloseEvent,
    CommMsgEvent,
    CommOpenEvent,
    CompleteReplyEvent,
    InspectReplyEvent,
    KernelStatusEvent,
    StatusEvent,
    VariableChildrenReplyEvent,
    ColumnsReplyEvent,
    VariablesReplyEvent,
)

logger = logging.getLogger(__name__)

# A subscriber is an async callable that delivers one event dict to a client.
Subscriber = Callable[[dict], Awaitable[None]]


@dataclass
class _Capture:
    """A diverted introspection run: its stdout is buffered, then parsed and
    sent back as a ``variables_reply`` or ``variable_children_reply``."""

    request_id: str
    kind: str  # "variables" | "children"
    name: str | None = None


# Introspection run in the *user* namespace to list data variables for the
# explorer. It only prints a JSON array to stdout (no execute_result), runs with
# store_history=False so it never advances the [n] prompt, and leaks no lasting
# globals (its one helper is deleted; underscore-prefixed names are skipped).
_VARIABLES_SCRIPT = r"""
def __ve_dump():
    import json as _j
    _out = []
    for _k, _v in list(globals().items()):
        if _k.startswith('_') or _k in ('In', 'Out', 'exit', 'quit', 'get_ipython'):
            continue
        _t = type(_v).__name__
        if _t in ('module', 'function', 'builtin_function_or_method', 'type', 'method'):
            continue
        if callable(_v):
            continue
        try:
            _r = repr(_v)
        except Exception:
            _r = '<unreprable>'
        if len(_r) > 120:
            _r = _r[:117] + '...'
        _info = {'name': _k, 'type': _t, 'repr': _r}
        try:
            if hasattr(_v, 'shape'):
                _info['size'] = '×'.join(map(str, _v.shape))
            elif _t in ('list', 'tuple', 'set', 'dict', 'str', 'bytes'):
                _info['size'] = str(len(_v))
        except Exception:
            pass
        _out.append(_info)
    print(_j.dumps(_out))
__ve_dump()
del __ve_dump
"""

# Introspect one container's direct children for the explorer's expand affordance.
# Defined as a helper called with the live object; same diversion rules apply.
_CHILDREN_SCRIPT = r"""
def __ve_children(__obj):
    import json as _j
    _out = []
    _items = None
    if isinstance(__obj, dict):
        _items = list(__obj.items())[:200]
    elif isinstance(__obj, (list, tuple)):
        _items = list(enumerate(__obj))[:200]
    elif isinstance(__obj, (set, frozenset)):
        _items = [(None, _x) for _x in list(__obj)[:200]]
    if _items is not None:
        for _k, _v in _items:
            _t = type(_v).__name__
            try:
                _r = repr(_v)
            except Exception:
                _r = '<unreprable>'
            if len(_r) > 120:
                _r = _r[:117] + '...'
            _info = {'key': '' if _k is None else repr(_k), 'type': _t, 'repr': _r}
            try:
                if hasattr(_v, 'shape'):
                    _info['size'] = '×'.join(map(str, _v.shape))
                elif _t in ('list', 'tuple', 'set', 'dict', 'str', 'bytes'):
                    _info['size'] = str(len(_v))
            except Exception:
                pass
            _out.append(_info)
    print(_j.dumps(_out))
"""


class KernelSession:
    def __init__(self, kernel_name: str | None = None) -> None:
        self.kernel_name = kernel_name or settings.default_kernel_name
        self.km = AsyncKernelManager(kernel_name=self.kernel_name)
        self.kc = None  # AsyncKernelClient, created in start()

        # Correlation state.
        self.msg_to_cell: dict[str, str] = {}  # execute msg_id -> cell_id
        self.pending_requests: dict[str, str] = {}  # complete/inspect id -> request_id
        # Variable-explorer introspection: msg_id -> capture metadata, and the
        # stdout buffer we accumulate for that msg until idle (then parse + reply).
        self.var_requests: dict[str, _Capture] = {}
        self.var_buffers: dict[str, str] = {}

        self._subscribers: set[Subscriber] = set()
        # Collaboration presence: each subscriber's {client_id, name, color}.
        self._presence: dict[Subscriber, dict] = {}
        self._iopub_task: asyncio.Task | None = None
        self._shell_task: asyncio.Task | None = None

    # ----------------------------------------------------------------- #
    # lifecycle
    # ----------------------------------------------------------------- #
    async def start(self) -> None:
        await self.km.start_kernel()
        self.kc = self.km.client()
        self.kc.start_channels()
        # Safe to wait_for_ready here: no pump is reading the channels yet.
        await self.kc.wait_for_ready(timeout=settings.kernel_startup_timeout)
        self._start_pumps()
        logger.info("kernel %r ready", self.kernel_name)

    async def is_alive(self) -> bool:
        try:
            return await self.km.is_alive()
        except Exception:
            return False

    async def shutdown(self) -> None:
        await self._stop_pumps()
        try:
            if self.kc is not None:
                self.kc.stop_channels()
        finally:
            if await self.is_alive():
                await self.km.shutdown_kernel(now=True)
            logger.info("kernel %r shut down", self.kernel_name)

    # ----------------------------------------------------------------- #
    # subscribers / broadcast
    # ----------------------------------------------------------------- #
    def subscribe(self, cb: Subscriber, presence: dict | None = None) -> None:
        self._subscribers.add(cb)
        if presence is not None:
            self._presence[cb] = presence

    def unsubscribe(self, cb: Subscriber) -> None:
        self._subscribers.discard(cb)
        self._presence.pop(cb, None)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def presence_roster(self) -> list[dict]:
        return list(self._presence.values())

    async def _broadcast(self, event: dict) -> None:
        """Fan one event out to every attached socket, dropping dead ones."""
        for cb in list(self._subscribers):
            try:
                await cb(event)
            except Exception:
                # A send failure means the socket is gone; its handler also
                # unsubscribes in its finally, but drop it now to be safe.
                self._subscribers.discard(cb)

    async def relay(self, event: dict, exclude: Subscriber | None = None) -> None:
        """Fan an event out to every socket *except* the sender (collaboration)."""
        for cb in list(self._subscribers):
            if cb is exclude:
                continue
            try:
                await cb(event)
            except Exception:
                self._subscribers.discard(cb)

    async def broadcast_presence(self) -> None:
        """Tell everyone who is currently attached to this notebook."""
        from app.models import PresenceEvent

        await self._broadcast(PresenceEvent(peers=self.presence_roster()).model_dump())

    # ----------------------------------------------------------------- #
    # requests (all sync kc calls returning a msg_id)
    # ----------------------------------------------------------------- #
    def execute(self, cell_id: str, code: str) -> str:
        if self.kc is None:
            raise RuntimeError("kernel session not started")
        msg_id = self.kc.execute(
            code, silent=False, store_history=True, allow_stdin=False
        )
        # Record before any output can arrive so the pump never sees an
        # unmapped parent for this request.
        self.msg_to_cell[msg_id] = cell_id
        return msg_id

    def complete(self, request_id: str, code: str, cursor_pos: int) -> str:
        if self.kc is None:
            raise RuntimeError("kernel session not started")
        msg_id = self.kc.complete(code, cursor_pos)
        self.pending_requests[msg_id] = request_id
        return msg_id

    def inspect(
        self, request_id: str, code: str, cursor_pos: int, detail_level: int = 0
    ) -> str:
        if self.kc is None:
            raise RuntimeError("kernel session not started")
        msg_id = self.kc.inspect(code, cursor_pos, detail_level)
        self.pending_requests[msg_id] = request_id
        return msg_id

    def inspect_variables(self, request_id: str) -> str:
        """Run the introspection script; its stdout is captured by the pump."""
        return self._run_variables(request_id, _VARIABLES_SCRIPT)

    def delete_variable(self, request_id: str, name: str) -> str:
        """Delete one global (if a valid identifier), then re-introspect."""
        prefix = ""
        if name.isidentifier():
            # name is validated as an identifier, so this can't inject.
            prefix = f"try:\n    del {name}\nexcept Exception:\n    pass\n"
        return self._run_variables(request_id, prefix + _VARIABLES_SCRIPT)

    def set_variable(
        self, request_id: str, name: str, value: bool | int | float | str
    ) -> str:
        """Bind a global to a scalar value (input blocks), then re-introspect.

        Runs with ``store_history=False`` so it never advances the ``[n]`` prompt.
        ``name`` is validated as an identifier and the value is emitted via
        ``repr`` (a valid Python literal for str/bool/int/float), so neither can
        inject code.
        """
        prefix = ""
        if name.isidentifier():
            prefix = f"{name} = {value!r}\n"
        return self._run_variables(request_id, prefix + _VARIABLES_SCRIPT)

    # ----------------------------------------------------------------- #
    # comm protocol (ipywidgets): frontend -> kernel, on the shell channel
    # ----------------------------------------------------------------- #
    def comm_open(
        self,
        comm_id: str,
        target_name: str,
        data: dict,
        metadata: dict,
        buffers: list[str],
    ) -> str:
        return self._send_comm(
            "comm_open",
            {"comm_id": comm_id, "target_name": target_name, "data": data},
            metadata,
            buffers,
        )

    def comm_msg(self, comm_id: str, data: dict, buffers: list[str]) -> str:
        return self._send_comm("comm_msg", {"comm_id": comm_id, "data": data}, None, buffers)

    def comm_close(self, comm_id: str, data: dict) -> str:
        return self._send_comm("comm_close", {"comm_id": comm_id, "data": data}, None, None)

    def _send_comm(
        self,
        msg_type: str,
        content: dict,
        metadata: dict | None = None,
        buffers: list[str] | None = None,
    ) -> str:
        if self.kc is None:
            raise RuntimeError("kernel session not started")
        msg = self.kc.session.msg(msg_type, content)
        if metadata:
            msg["metadata"] = {**msg.get("metadata", {}), **metadata}
        if buffers:
            # buffers travel as base64 over the JSON socket; the kernel wants bytes.
            msg["buffers"] = [base64.b64decode(b) for b in buffers]
        self.kc.shell_channel.send(msg)
        return msg["header"]["msg_id"]

    def df_columns(self, request_id: str, name: str) -> str:
        """List a DataFrame global's column names (chart-block pickers)."""
        if name.isidentifier():
            # name is validated as an identifier, so this can't inject.
            code = (
                "import json as __cj\n"
                "try:\n"
                f"    print(__cj.dumps([str(__c) for __c in {name}.columns]))\n"
                "except Exception:\n"
                "    print('[]')\n"
                "del __cj\n"
            )
        else:
            code = "print('[]')"
        return self._run_variables(request_id, code, kind="columns", name=name)

    def variable_children(self, request_id: str, name: str) -> str:
        """List the direct children of one container global (explorer expand)."""
        if name.isidentifier():
            # name is validated as an identifier, so this can't inject.
            code = _CHILDREN_SCRIPT + f"\n__ve_children({name})\ndel __ve_children\n"
        else:
            code = "print('[]')"
        return self._run_variables(request_id, code, kind="children", name=name)

    def _run_variables(
        self, request_id: str, code: str, kind: str = "variables", name: str | None = None
    ) -> str:
        if self.kc is None:
            raise RuntimeError("kernel session not started")
        msg_id = self.kc.execute(
            code, silent=False, store_history=False, allow_stdin=False
        )
        self.var_requests[msg_id] = _Capture(request_id, kind, name)
        self.var_buffers[msg_id] = ""
        return msg_id

    # ----------------------------------------------------------------- #
    # control operations
    # ----------------------------------------------------------------- #
    async def interrupt(self) -> None:
        await self.km.interrupt_kernel()

    async def restart(self) -> None:
        """Hard-restart the kernel.

        Pause the pumps first so ``wait_for_ready`` is the sole reader of the
        channels (no multi-reader race), then resume. Correlation state is
        dropped because outputs from before the restart can no longer be
        attributed.
        """
        await self._broadcast(
            KernelStatusEvent(
                state="restarting", kernel_name=self.kernel_name
            ).model_dump()
        )
        await self._stop_pumps()
        self.msg_to_cell.clear()
        self.pending_requests.clear()
        self.var_requests.clear()
        self.var_buffers.clear()

        await self.km.restart_kernel(now=True)
        if self.kc is not None:
            await self.kc.wait_for_ready(timeout=settings.kernel_startup_timeout)

        self._start_pumps()
        await self._broadcast(
            KernelStatusEvent(state="ready", kernel_name=self.kernel_name).model_dump()
        )

    # ----------------------------------------------------------------- #
    # pump management
    # ----------------------------------------------------------------- #
    def _start_pumps(self) -> None:
        self._iopub_task = asyncio.create_task(self._pump_iopub())
        self._shell_task = asyncio.create_task(self._pump_shell())

    async def _stop_pumps(self) -> None:
        for task in (self._iopub_task, self._shell_task):
            if task is not None:
                task.cancel()
        for task in (self._iopub_task, self._shell_task):
            if task is not None:
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._iopub_task = None
        self._shell_task = None

    async def _pump_iopub(self) -> None:
        assert self.kc is not None
        while True:
            try:
                msg = await self.kc.get_iopub_msg()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("iopub pump error; continuing")
                await asyncio.sleep(0.1)
                continue

            parent_id = msg.get("parent_header", {}).get("msg_id")
            msg_type = msg["header"]["msg_type"]
            content = msg["content"]

            # ipywidgets comm traffic is global — a widget model is not owned by
            # any one cell — so forward it to every socket (keyed by comm_id on
            # the client), base64-ing any binary buffers.
            if msg_type in ("comm_open", "comm_msg", "comm_close"):
                await self._handle_comm_iopub(
                    msg_type, content, msg.get("metadata", {}), msg.get("buffers", [])
                )
                continue

            # Variable-explorer introspection is diverted, never broadcast as
            # cell output: buffer its stdout, then parse + reply on idle.
            if parent_id in self.var_requests:
                await self._handle_var_capture(parent_id, msg_type, content)
                continue

            cell_id = self.msg_to_cell.get(parent_id) if parent_id else None
            event = to_client_event(cell_id, msg_type, content)
            if event is not None:
                await self._broadcast(event.model_dump())

            # idle is the protocol-guaranteed last message for a request.
            if (
                msg_type == "status"
                and content.get("execution_state") == "idle"
                and parent_id in self.msg_to_cell
            ):
                del self.msg_to_cell[parent_id]

    async def _handle_comm_iopub(
        self, msg_type: str, content: dict, metadata: dict, buffers: list
    ) -> None:
        """Forward one kernel-originated comm message to all sockets."""
        b64 = [base64.b64encode(bytes(b)).decode("ascii") for b in buffers]
        comm_id = content.get("comm_id", "")
        if msg_type == "comm_open":
            event = CommOpenEvent(
                comm_id=comm_id,
                target_name=content.get("target_name", ""),
                data=content.get("data", {}),
                metadata=metadata,
                buffers=b64,
            )
        elif msg_type == "comm_msg":
            event = CommMsgEvent(comm_id=comm_id, data=content.get("data", {}), buffers=b64)
        else:
            event = CommCloseEvent(comm_id=comm_id, data=content.get("data", {}))
        await self._broadcast(event.model_dump())

    async def _handle_var_capture(
        self, parent_id: str, msg_type: str, content: dict
    ) -> None:
        """Accumulate introspection stdout; on idle, parse it and reply."""
        if msg_type == "stream" and content.get("name") == "stdout":
            self.var_buffers[parent_id] += content.get("text", "")
        elif msg_type == "status" and content.get("execution_state") == "idle":
            cap = self.var_requests.pop(parent_id, None)
            raw = self.var_buffers.pop(parent_id, "")
            payload: list[dict] = []
            try:
                import json

                payload = json.loads(raw.strip() or "[]")
            except Exception:
                logger.warning("could not parse introspection payload")
            if cap is None:
                return
            if cap.kind == "children":
                await self._broadcast(
                    VariableChildrenReplyEvent(
                        request_id=cap.request_id, name=cap.name or "", children=payload
                    ).model_dump()
                )
            elif cap.kind == "columns":
                await self._broadcast(
                    ColumnsReplyEvent(
                        request_id=cap.request_id, name=cap.name or "", columns=payload
                    ).model_dump()
                )
            else:
                await self._broadcast(
                    VariablesReplyEvent(
                        request_id=cap.request_id, variables=payload
                    ).model_dump()
                )

    async def _pump_shell(self) -> None:
        assert self.kc is not None
        while True:
            try:
                msg = await self.kc.get_shell_msg()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("shell pump error; continuing")
                await asyncio.sleep(0.1)
                continue

            msg_type = msg["header"]["msg_type"]
            content = msg["content"]
            parent_id = msg.get("parent_header", {}).get("msg_id")

            # When a run-all hits an error, the kernel aborts the remaining
            # queued execute_requests with an 'aborted' reply and *no* iopub
            # idle — so reset those cells here, or they'd stay "queued" forever.
            if msg_type == "execute_reply" and content.get("status") == "aborted":
                cell_id = self.msg_to_cell.pop(parent_id, None) if parent_id else None
                if cell_id is not None:
                    await self._broadcast(
                        StatusEvent(cell_id=cell_id, execution_state="idle").model_dump()
                    )
                continue

            request_id = (
                self.pending_requests.pop(parent_id, None) if parent_id else None
            )
            if request_id is None:
                # execute_reply / kernel_info_reply are not surfaced here.
                continue

            if msg_type == "complete_reply":
                await self._broadcast(
                    CompleteReplyEvent(
                        request_id=request_id,
                        matches=content.get("matches", []),
                        cursor_start=content.get("cursor_start", 0),
                        cursor_end=content.get("cursor_end", 0),
                    ).model_dump()
                )
            elif msg_type == "inspect_reply":
                await self._broadcast(
                    InspectReplyEvent(
                        request_id=request_id,
                        found=content.get("found", False),
                        data=content.get("data", {}),
                    ).model_dump()
                )
