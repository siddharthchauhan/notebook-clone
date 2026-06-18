"""Registry of persistent per-notebook kernel sessions.

One :class:`KernelSession` per ``notebook_id``, created on first connect and
kept alive across WebSocket disconnects so kernel state (imports, variables)
survives a page reload. A per-notebook lock serializes concurrent
``get_or_create`` calls so two sockets opening at once can't start two kernels.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

from app.kernels.session import KernelSession

logger = logging.getLogger(__name__)


class KernelRegistry:
    def __init__(self) -> None:
        self._sessions: dict[str, KernelSession] = {}
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def get_or_create(
        self, notebook_id: str, kernel_name: str | None = None
    ) -> KernelSession:
        async with self._locks[notebook_id]:
            session = self._sessions.get(notebook_id)
            if session is not None and await session.is_alive():
                return session
            # No session, or the previous one died — start fresh.
            if session is not None:
                await session.shutdown()
            session = KernelSession(kernel_name)
            await session.start()
            self._sessions[notebook_id] = session
            logger.info("created kernel session for notebook=%s", notebook_id)
            return session

    def get(self, notebook_id: str) -> KernelSession | None:
        return self._sessions.get(notebook_id)

    async def shutdown(self, notebook_id: str) -> None:
        async with self._locks[notebook_id]:
            session = self._sessions.pop(notebook_id, None)
            if session is not None:
                await session.shutdown()

    async def shutdown_all(self) -> None:
        for notebook_id in list(self._sessions):
            await self.shutdown(notebook_id)


# Process-wide singleton, shut down on app stop via the FastAPI lifespan.
registry = KernelRegistry()
