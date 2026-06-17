"""Shared test harness: a real kernel plus an iopub event collector.

These tests drive an actual :class:`KernelSession` headless (no FastAPI, no
browser) and assert on the translated client events, exactly mirroring what the
WS layer would send to the browser.
"""

from __future__ import annotations

import asyncio
import contextlib

import pytest_asyncio

from app.kernels.session import KernelSession
from app.kernels.translate import to_client_event
from app.models import ClientEvent


class EventCollector:
    """Pump callback that records translated events and tracks idle status.

    Mirrors the WS layer's ``on_event`` but stores events instead of sending
    them, and lets a test ``await`` a specific cell reaching ``idle``.
    """

    def __init__(self) -> None:
        self.events: list[ClientEvent] = []
        self._idle: dict[str | None, asyncio.Event] = {}

    async def on_event(self, cell_id: str | None, msg_type: str, content: dict) -> None:
        event = to_client_event(cell_id, msg_type, content)
        if event is not None:
            self.events.append(event)
        if msg_type == "status" and content.get("execution_state") == "idle":
            self._idle.setdefault(cell_id, asyncio.Event()).set()

    async def wait_idle(self, cell_id: str, timeout: float = 30.0) -> None:
        """Block until ``cell_id`` has reported ``idle`` (its run finished)."""
        flag = self._idle.setdefault(cell_id, asyncio.Event())
        await asyncio.wait_for(flag.wait(), timeout)

    def for_cell(self, cell_id: str) -> list[ClientEvent]:
        return [e for e in self.events if e.cell_id == cell_id]

    def of_type(self, cell_id: str, type_name: str) -> list[ClientEvent]:
        return [e for e in self.for_cell(cell_id) if e.type == type_name]


@pytest_asyncio.fixture
async def kernel():
    """A started kernel with a single iopub pump feeding an EventCollector."""
    session = KernelSession()
    await session.start()
    collector = EventCollector()
    pump = asyncio.create_task(session.pump_iopub(collector.on_event))
    try:
        yield session, collector
    finally:
        pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pump
        await session.shutdown()
