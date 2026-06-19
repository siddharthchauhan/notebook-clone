"""Collaboration: presence roster + sender-excluding doc-op relay.

These exercise the session's fan-out directly (no kernel needed) — the same
methods the WebSocket endpoint calls to sync edits between collaborators.
"""

from __future__ import annotations

from app.kernels.session import KernelSession


async def test_relay_excludes_the_sender():
    session = KernelSession()
    a_events: list[dict] = []
    b_events: list[dict] = []

    async def a(e: dict) -> None:
        a_events.append(e)

    async def b(e: dict) -> None:
        b_events.append(e)

    session.subscribe(a, {"client_id": "a", "name": "Ada", "color": "#f00"})
    session.subscribe(b, {"client_id": "b", "name": "Bob", "color": "#0f0"})

    op = {"type": "doc_op", "op": {"op": "source", "cell_id": "c1", "source": "x = 1"}}
    await session.relay(op, exclude=a)

    assert a_events == []  # the editor doesn't get its own edit back
    assert len(b_events) == 1 and b_events[0]["op"]["cell_id"] == "c1"


async def test_presence_roster_tracks_join_and_leave():
    session = KernelSession()
    seen: list[dict] = []

    async def a(e: dict) -> None:
        seen.append(e)

    async def b(e: dict) -> None:
        pass

    session.subscribe(a, {"client_id": "a", "name": "Ada", "color": "#f00"})
    session.subscribe(b, {"client_id": "b", "name": "Bob", "color": "#0f0"})
    assert {p["client_id"] for p in session.presence_roster()} == {"a", "b"}

    await session.broadcast_presence()
    presence = [e for e in seen if e["type"] == "presence"][-1]
    assert {p["name"] for p in presence["peers"]} == {"Ada", "Bob"}

    session.unsubscribe(b)
    assert {p["client_id"] for p in session.presence_roster()} == {"a"}
