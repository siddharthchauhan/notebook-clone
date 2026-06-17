"""A single live kernel and the cell-correlation machinery (spec §4.1).

The kernel knows nothing about "cells" — it only speaks the Jupyter messaging
protocol, where every output message carries a ``parent_header.msg_id`` that
points back to the ``execute_request`` that caused it. Correlating outputs to
cells is therefore *entirely* a matter of remembering, at submit time, which
cell owns which ``msg_id``.

That mapping is :attr:`KernelSession.msg_to_cell`. It is the single source of
truth for correctness under concurrency, which is why there is exactly **one**
``pump_iopub`` task draining the iopub channel: multiple concurrent readers of
``get_iopub_msg()`` would race and silently drop messages.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from jupyter_client import AsyncKernelManager

from app.config import settings

logger = logging.getLogger(__name__)

# Callback invoked for every iopub message: (cell_id, msg_type, content).
# ``cell_id`` is None for kernel-initiated messages (no owning cell).
OnEvent = Callable[[str | None, str, dict], Awaitable[None]]


class KernelSession:
    """Owns one kernel process and routes its iopub stream back to cells."""

    def __init__(self, kernel_name: str | None = None) -> None:
        self.kernel_name = kernel_name or settings.default_kernel_name
        self.km = AsyncKernelManager(kernel_name=self.kernel_name)
        self.kc = None  # AsyncKernelClient, created in start()
        # The correctness mechanism: execute msg_id -> owning cell_id.
        self.msg_to_cell: dict[str, str] = {}

    # ----------------------------------------------------------------- #
    # lifecycle
    # ----------------------------------------------------------------- #
    async def start(self) -> None:
        """Start the kernel process and wait until it is ready to execute."""
        await self.km.start_kernel()
        self.kc = self.km.client()
        self.kc.start_channels()  # synchronous
        await self.kc.wait_for_ready(timeout=settings.kernel_startup_timeout)
        logger.info("kernel %r ready", self.kernel_name)

    async def shutdown(self) -> None:
        """Tear the kernel down. Safe to call even if start() half-failed."""
        try:
            if self.kc is not None:
                self.kc.stop_channels()  # synchronous
        finally:
            if await self.km.is_alive():
                await self.km.shutdown_kernel(now=True)
            logger.info("kernel %r shut down", self.kernel_name)

    # ----------------------------------------------------------------- #
    # execution
    # ----------------------------------------------------------------- #
    def execute(self, cell_id: str, code: str) -> str:
        """Submit ``code`` for ``cell_id``.

        ``kc.execute`` is synchronous and returns the request's ``msg_id``
        immediately. We record the mapping *before* any output can arrive so
        the pump never sees an unmapped parent for this request.
        """
        if self.kc is None:
            raise RuntimeError("kernel session not started")
        msg_id = self.kc.execute(
            code,
            silent=False,
            store_history=True,
            allow_stdin=False,
        )
        self.msg_to_cell[msg_id] = cell_id
        return msg_id

    # ----------------------------------------------------------------- #
    # the single iopub pump
    # ----------------------------------------------------------------- #
    async def pump_iopub(self, on_event: OnEvent) -> None:
        """Drain the iopub channel forever, dispatching each message.

        Run as exactly one long-lived task per session. Resolves each
        message's parent ``msg_id`` to a cell via :attr:`msg_to_cell`, then
        hands ``(cell_id, msg_type, content)`` to ``on_event``. Cancellation
        (when the WS closes) propagates out of ``get_iopub_msg`` cleanly.
        """
        if self.kc is None:
            raise RuntimeError("kernel session not started")
        while True:
            msg = await self.kc.get_iopub_msg()
            parent_id = msg.get("parent_header", {}).get("msg_id")
            cell_id = self.msg_to_cell.get(parent_id) if parent_id else None
            msg_type = msg["header"]["msg_type"]
            content = msg["content"]

            await on_event(cell_id, msg_type, content)

            # An ``idle`` status is the protocol-guaranteed last message for a
            # request, so the mapping can be retired to bound memory.
            if (
                msg_type == "status"
                and content.get("execution_state") == "idle"
                and parent_id in self.msg_to_cell
            ):
                del self.msg_to_cell[parent_id]

    # ----------------------------------------------------------------- #
    # control-channel operations — declared now, wired up in Phase 2
    # ----------------------------------------------------------------- #
    async def interrupt(self) -> None:
        await self.km.interrupt_kernel()

    async def restart(self) -> None:
        await self.km.restart_kernel(now=True)
        if self.kc is not None:
            await self.kc.wait_for_ready(timeout=settings.kernel_startup_timeout)
        # Outputs from before the restart can no longer be correlated.
        self.msg_to_cell.clear()
