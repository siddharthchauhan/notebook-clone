"""End-to-end kernel tests — the four spec acceptance criteria + correlation.

Each test drives a real kernel through :class:`KernelSession` and asserts on
the translated client events (spec §7 verification mapping):

* stdout streaming
* matplotlib inline PNG
* traceback without server crash
* busy → idle status transitions
* per-cell output correlation (the ``msg_to_cell`` guarantee)
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio


async def test_stdout_streams_to_cell(kernel):
    """print('hi') streams 'hi\\n' to the originating cell (criterion #1)."""
    session, collector = kernel
    session.execute("cell-1", 'print("hi")')
    await collector.wait_idle("cell-1")

    streams = collector.of_type("cell-1", "stream")
    assert streams, "expected a stream event"
    assert all(s.name == "stdout" for s in streams)
    assert "".join(s.text for s in streams) == "hi\n"


async def test_matplotlib_renders_png(kernel):
    """A matplotlib snippet produces an image/png MIME bundle (criterion #2)."""
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
    assert displays, "expected a display event with the figure"
    png = next((d for d in displays if "image/png" in d.data), None)
    assert png is not None, "expected an image/png payload"
    assert isinstance(png.data["image/png"], str) and png.data["image/png"]


async def test_zero_division_traceback_keeps_kernel_alive(kernel):
    """1/0 yields a ZeroDivisionError traceback; the kernel survives (#3)."""
    session, collector = kernel
    session.execute("err-cell", "1/0")
    await collector.wait_idle("err-cell")

    errors = collector.of_type("err-cell", "error")
    assert len(errors) == 1
    assert errors[0].ename == "ZeroDivisionError"
    assert any("ZeroDivisionError" in line for line in errors[0].traceback)

    # The session must still execute after an error — proves no crash.
    session.execute("after-cell", 'print("alive")')
    await collector.wait_idle("after-cell")
    streams = collector.of_type("after-cell", "stream")
    assert "".join(s.text for s in streams) == "alive\n"


async def test_busy_then_idle_status(kernel):
    """A sleeping cell reports busy then idle, in order (criterion #4)."""
    session, collector = kernel
    session.execute("sleep-cell", "import time; time.sleep(0.5)")
    await collector.wait_idle("sleep-cell")

    states = [e.execution_state for e in collector.of_type("sleep-cell", "status")]
    assert states == ["busy", "idle"]


async def test_outputs_correlate_to_their_own_cell(kernel):
    """Two cells fired back-to-back never cross-contaminate outputs (#5).

    This is the guard on the ``msg_to_cell`` mechanism: with a single iopub
    pump and per-request mapping, each cell sees only its own output.
    """
    session, collector = kernel
    session.execute("cell-A", 'print("A")')
    session.execute("cell-B", 'print("B")')
    await collector.wait_idle("cell-A")
    await collector.wait_idle("cell-B")

    a_text = "".join(s.text for s in collector.of_type("cell-A", "stream"))
    b_text = "".join(s.text for s in collector.of_type("cell-B", "stream"))
    assert a_text == "A\n"
    assert b_text == "B\n"
