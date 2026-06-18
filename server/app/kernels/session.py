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
import logging
from collections.abc import Awaitable, Callable

from jupyter_client import AsyncKernelManager

from app.config import settings
from app.kernels.translate import to_client_event
from app.models import (
    CompleteReplyEvent,
    InspectReplyEvent,
    KernelStatusEvent,
    StatusEvent,
    VariablesReplyEvent,
)

logger = logging.getLogger(__name__)

# A subscriber is an async callable that delivers one event dict to a client.
Subscriber = Callable[[dict], Awaitable[None]]

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


class KernelSession:
    def __init__(self, kernel_name: str | None = None) -> None:
        self.kernel_name = kernel_name or settings.default_kernel_name
        self.km = AsyncKernelManager(kernel_name=self.kernel_name)
        self.kc = None  # AsyncKernelClient, created in start()

        # Correlation state.
        self.msg_to_cell: dict[str, str] = {}  # execute msg_id -> cell_id
        self.pending_requests: dict[str, str] = {}  # complete/inspect id -> request_id
        # Variable-explorer introspection: msg_id -> request_id, and the stdout
        # buffer we accumulate for that msg until idle (then parse + reply).
        self.var_requests: dict[str, str] = {}
        self.var_buffers: dict[str, str] = {}

        self._subscribers: set[Subscriber] = set()
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
    def subscribe(self, cb: Subscriber) -> None:
        self._subscribers.add(cb)

    def unsubscribe(self, cb: Subscriber) -> None:
        self._subscribers.discard(cb)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    async def _broadcast(self, event: dict) -> None:
        """Fan one event out to every attached socket, dropping dead ones."""
        for cb in list(self._subscribers):
            try:
                await cb(event)
            except Exception:
                # A send failure means the socket is gone; its handler also
                # unsubscribes in its finally, but drop it now to be safe.
                self._subscribers.discard(cb)

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

    def _run_variables(self, request_id: str, code: str) -> str:
        if self.kc is None:
            raise RuntimeError("kernel session not started")
        msg_id = self.kc.execute(
            code, silent=False, store_history=False, allow_stdin=False
        )
        self.var_requests[msg_id] = request_id
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

            # Variable-explorer introspection is diverted, never broadcast as
            # cell output: buffer its stdout, then parse + reply on idle.
            if parent_id in self.var_requests:
                await self._handle_variables_msg(parent_id, msg_type, content)
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

    async def _handle_variables_msg(
        self, parent_id: str, msg_type: str, content: dict
    ) -> None:
        """Accumulate introspection stdout; on idle, parse it and reply."""
        if msg_type == "stream" and content.get("name") == "stdout":
            self.var_buffers[parent_id] += content.get("text", "")
        elif msg_type == "status" and content.get("execution_state") == "idle":
            request_id = self.var_requests.pop(parent_id, None)
            raw = self.var_buffers.pop(parent_id, "")
            variables: list[dict] = []
            try:
                import json

                variables = json.loads(raw.strip() or "[]")
            except Exception:
                logger.warning("could not parse variables payload")
            if request_id is not None:
                await self._broadcast(
                    VariablesReplyEvent(
                        request_id=request_id, variables=variables
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
