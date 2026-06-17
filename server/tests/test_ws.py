"""Integration test for the WebSocket endpoint via Starlette's TestClient.

Exercises the real path the browser uses: connect → send an
``execute_request`` → receive translated events over the socket. This covers
the WS dispatch + pump + teardown that the headless ``KernelSession`` tests do
not touch.
"""

from __future__ import annotations

from starlette.testclient import TestClient

from app.main import app


def _drain_until_idle(ws, cell_id: str, limit: int = 100) -> list[dict]:
    """Read events until ``cell_id`` reports idle (bounded to avoid hangs)."""
    events: list[dict] = []
    for _ in range(limit):
        ev = ws.receive_json()
        events.append(ev)
        if (
            ev["type"] == "status"
            and ev["cell_id"] == cell_id
            and ev["execution_state"] == "idle"
        ):
            return events
    raise AssertionError(f"cell {cell_id} never reached idle within {limit} messages")


def test_ws_execute_roundtrip():
    client = TestClient(app)
    with client.websocket_connect("/ws/test-nb") as ws:
        ws.send_json(
            {"type": "execute_request", "cell_id": "c1", "code": 'print("hi")'}
        )
        events = _drain_until_idle(ws, "c1")

    streams = [e for e in events if e["type"] == "stream" and e["cell_id"] == "c1"]
    assert "".join(s["text"] for s in streams) == "hi\n"

    statuses = [
        e["execution_state"]
        for e in events
        if e["type"] == "status" and e["cell_id"] == "c1"
    ]
    assert statuses == ["busy", "idle"]
