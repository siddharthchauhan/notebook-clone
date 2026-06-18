"""Shared test harness: a real persistent kernel plus an event collector.

These tests drive an actual :class:`KernelSession` headless and assert on the
broadcast event dicts — exactly what the WS layer forwards to the browser.
"""

from __future__ import annotations

import asyncio

import pytest_asyncio

from app.kernels.session import KernelSession


class EventCollector:
    """A session subscriber that records every broadcast event dict."""

    def __init__(self) -> None:
        self.events: list[dict] = []

    async def handle(self, event: dict) -> None:
        self.events.append(event)

    # -- queries ----------------------------------------------------- #
    def for_cell(self, cell_id: str) -> list[dict]:
        return [e for e in self.events if e.get("cell_id") == cell_id]

    def of_type(self, cell_id: str, type_name: str) -> list[dict]:
        return [e for e in self.for_cell(cell_id) if e.get("type") == type_name]

    # -- waiting ----------------------------------------------------- #
    async def wait_event(self, predicate, timeout: float = 30.0) -> dict:
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while True:
            for e in self.events:
                if predicate(e):
                    return e
            if loop.time() > deadline:
                raise asyncio.TimeoutError("event not seen within timeout")
            await asyncio.sleep(0.02)

    async def wait_idle(self, cell_id: str, timeout: float = 30.0) -> dict:
        return await self.wait_event(
            lambda e: e.get("type") == "status"
            and e.get("cell_id") == cell_id
            and e.get("execution_state") == "idle",
            timeout,
        )


@pytest_asyncio.fixture
async def kernel():
    """A started persistent kernel with one subscribed EventCollector."""
    session = KernelSession()
    await session.start()
    collector = EventCollector()
    session.subscribe(collector.handle)
    try:
        yield session, collector
    finally:
        await session.shutdown()
