"""ipywidgets comm-protocol relay over a real kernel session.

A widget opens a *comm* at construction (kernel -> frontend) carrying its
initial state, and the cell gets a ``display`` with the widget-view mimetype.
Moving the widget in the browser is a frontend -> kernel comm message that
mutates the kernel-side Widget. These tests assert both directions.
"""

from __future__ import annotations

WIDGET_VIEW = "application/vnd.jupyter.widget-view+json"

MAKE_SLIDER = "import ipywidgets as w\nsld = w.IntSlider(value=3)\nsld"


async def _displayed_model_id(collector) -> str:
    """comm_id of the widget actually displayed (one IntSlider also opens comms
    for its Layout and Style — the view's model_id picks out the slider)."""
    view = await collector.wait_event(
        lambda e: e.get("type") == "display" and WIDGET_VIEW in (e.get("data") or {})
    )
    return view["data"][WIDGET_VIEW]["model_id"]


async def test_widget_display_emits_comm_open_and_view(kernel):
    session, collector = kernel
    session.execute("c1", MAKE_SLIDER)
    await collector.wait_idle("c1")

    model_id = await _displayed_model_id(collector)

    # The matching comm_open is global (no cell_id) and carries initial state +
    # the protocol version the frontend manager validates.
    opened = await collector.wait_event(
        lambda e: e.get("type") == "comm_open" and e.get("comm_id") == model_id
    )
    assert opened["target_name"] == "jupyter.widget"
    assert "cell_id" not in opened  # comm events are global, not cell-scoped
    assert opened["data"]["state"]["value"] == 3
    assert opened["metadata"].get("version", "").startswith("2")


async def test_frontend_comm_msg_updates_kernel_state(kernel):
    session, collector = kernel
    session.execute("c1", MAKE_SLIDER)
    await collector.wait_idle("c1")
    comm_id = await _displayed_model_id(collector)

    # Simulate the browser moving the slider: a state-update comm message.
    session.comm_msg(comm_id, {"method": "update", "state": {"value": 7}}, [])

    # Shell messages are FIFO, so this runs after the update lands.
    session.execute("c2", "print(sld.value)")
    await collector.wait_idle("c2")
    streams = "".join(e.get("text", "") for e in collector.of_type("c2", "stream"))
    assert "7" in streams
