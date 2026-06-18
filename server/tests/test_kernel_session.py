"""End-to-end kernel tests — Phase 1 acceptance criteria + Phase 2 features.

Phase 1 (still must hold): stdout, matplotlib PNG, traceback-without-crash,
busy→idle, per-cell correlation.

Phase 2 (new): kernel state persists across resubscribe, interrupt, restart
clears state, and complete/inspect request→reply.
"""

from __future__ import annotations

import asyncio

import pytest

from app.kernels.session import KernelSession
from tests.conftest import EventCollector

pytestmark = pytest.mark.asyncio


# --------------------------------------------------------------------------- #
# Phase 1 acceptance criteria
# --------------------------------------------------------------------------- #
async def test_stdout_streams_to_cell(kernel):
    session, collector = kernel
    session.execute("cell-1", 'print("hi")')
    await collector.wait_idle("cell-1")

    streams = collector.of_type("cell-1", "stream")
    assert streams and all(s["name"] == "stdout" for s in streams)
    assert "".join(s["text"] for s in streams) == "hi\n"


async def test_matplotlib_renders_png(kernel):
    session, collector = kernel
    code = (
        "%matplotlib inline\n"
        "import matplotlib.pyplot as plt\n"
        "fig, ax = plt.subplots()\n"
        "ax.plot([1, 2, 3], [1, 4, 9])\n"
    )
    session.execute("plot-cell", code)
    await collector.wait_idle("plot-cell")

    displays = collector.of_type("plot-cell", "display")
    png = next((d for d in displays if "image/png" in d["data"]), None)
    assert png is not None and isinstance(png["data"]["image/png"], str)
    assert png["data"]["image/png"]


async def test_zero_division_traceback_keeps_kernel_alive(kernel):
    session, collector = kernel
    session.execute("err-cell", "1/0")
    await collector.wait_idle("err-cell")

    errors = collector.of_type("err-cell", "error")
    assert len(errors) == 1 and errors[0]["ename"] == "ZeroDivisionError"
    assert any("ZeroDivisionError" in line for line in errors[0]["traceback"])

    session.execute("after-cell", 'print("alive")')
    await collector.wait_idle("after-cell")
    streams = collector.of_type("after-cell", "stream")
    assert "".join(s["text"] for s in streams) == "alive\n"


async def test_busy_then_idle_status(kernel):
    session, collector = kernel
    session.execute("sleep-cell", "import time; time.sleep(0.5)")
    await collector.wait_idle("sleep-cell")

    states = [e["execution_state"] for e in collector.of_type("sleep-cell", "status")]
    assert states == ["busy", "idle"]


async def test_outputs_correlate_to_their_own_cell(kernel):
    session, collector = kernel
    session.execute("cell-A", 'print("A")')
    session.execute("cell-B", 'print("B")')
    await collector.wait_idle("cell-A")
    await collector.wait_idle("cell-B")

    a_text = "".join(s["text"] for s in collector.of_type("cell-A", "stream"))
    b_text = "".join(s["text"] for s in collector.of_type("cell-B", "stream"))
    assert a_text == "A\n" and b_text == "B\n"


# --------------------------------------------------------------------------- #
# Phase 2 features
# --------------------------------------------------------------------------- #
async def test_kernel_state_persists_across_resubscribe(kernel):
    """A persistent kernel keeps variables across a disconnect/reconnect."""
    session, c1 = kernel
    session.execute("a", "x = 41")
    await c1.wait_idle("a")

    # Simulate a browser reload: old socket detaches, a new one attaches.
    session.unsubscribe(c1.handle)
    c2 = EventCollector()
    session.subscribe(c2.handle)

    session.execute("b", "print(x + 1)")
    await c2.wait_idle("b")
    assert "".join(s["text"] for s in c2.of_type("b", "stream")) == "42\n"


async def test_interrupt_stops_running_cell(kernel):
    session, collector = kernel
    session.execute("loop", "import time\nwhile True:\n    time.sleep(0.05)")
    # Wait until the cell is actually running, then interrupt.
    await collector.wait_event(
        lambda e: e.get("type") == "status"
        and e.get("cell_id") == "loop"
        and e.get("execution_state") == "busy"
    )
    await asyncio.sleep(0.2)
    await session.interrupt()
    await collector.wait_idle("loop", timeout=10)

    errors = collector.of_type("loop", "error")
    assert any(e["ename"] == "KeyboardInterrupt" for e in errors)


async def test_restart_clears_state_and_emits_status(kernel):
    session, collector = kernel
    session.execute("a", "y = 7")
    await collector.wait_idle("a")

    await session.restart()

    statuses = [e["state"] for e in collector.events if e.get("type") == "kernel_status"]
    assert "restarting" in statuses and statuses[-1] == "ready"

    # State is gone after restart: referencing y raises NameError.
    session.execute("b", "print(y)")
    await collector.wait_idle("b")
    assert any(e["ename"] == "NameError" for e in collector.of_type("b", "error"))


async def test_run_all_aborts_remaining_after_error(kernel):
    """After an error, queued cells are aborted and reset to idle (not stuck)."""
    session, collector = kernel
    session.execute("boom", "raise ValueError('boom')")
    session.execute("after", "print('should not run')")

    await collector.wait_idle("boom")
    # The aborted cell still gets an idle (synthesized from execute_reply),
    # but never actually ran, so it produced no stream output.
    await collector.wait_idle("after", timeout=10)
    assert collector.of_type("after", "stream") == []
    assert collector.of_type("boom", "error")[0]["ename"] == "ValueError"


async def test_complete_returns_matches(kernel):
    session, collector = kernel
    session.execute("setup", "import os")
    await collector.wait_idle("setup")

    session.complete("req-1", "os.getc", 7)
    reply = await collector.wait_event(
        lambda e: e.get("type") == "complete_reply" and e.get("request_id") == "req-1",
        timeout=10,
    )
    assert "getcwd" in reply["matches"]
    assert reply["cursor_start"] == 3 and reply["cursor_end"] == 7


async def test_inspect_returns_docs(kernel):
    session, collector = kernel
    session.execute("setup", "import json")
    await collector.wait_idle("setup")

    session.inspect("req-2", "json.dumps", len("json.dumps"))
    reply = await collector.wait_event(
        lambda e: e.get("type") == "inspect_reply" and e.get("request_id") == "req-2",
        timeout=10,
    )
    assert reply["found"] is True
    assert "text/plain" in reply["data"]
