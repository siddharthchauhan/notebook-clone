"""Unit tests for the pure iopub → client-event translation (no kernel)."""

from __future__ import annotations

from app.kernels.translate import to_client_event


def test_status_maps_to_status_event():
    ev = to_client_event("c1", "status", {"execution_state": "busy"})
    assert ev is not None and ev.type == "status"
    assert ev.cell_id == "c1" and ev.execution_state == "busy"


def test_stream_maps_to_stream_event():
    ev = to_client_event("c1", "stream", {"name": "stdout", "text": "hi\n"})
    assert ev is not None and ev.type == "stream"
    assert ev.name == "stdout" and ev.text == "hi\n"


def test_execute_result_and_display_data_both_map_to_display():
    bundle = {"data": {"text/plain": "7"}, "metadata": {}}
    for msg_type in ("execute_result", "display_data"):
        ev = to_client_event("c1", msg_type, bundle)
        assert ev is not None and ev.type == "display"
        assert ev.data == {"text/plain": "7"}


def test_error_maps_to_error_event():
    ev = to_client_event(
        "c1",
        "error",
        {"ename": "ZeroDivisionError", "evalue": "division by zero", "traceback": ["t"]},
    )
    assert ev is not None and ev.type == "error"
    assert ev.ename == "ZeroDivisionError"


def test_unknown_types_return_none():
    assert to_client_event("c1", "execute_input", {"code": "x"}) is None
    assert to_client_event(None, "comm_open", {}) is None


def test_none_cell_id_is_preserved():
    ev = to_client_event(None, "status", {"execution_state": "starting"})
    assert ev is not None and ev.cell_id is None
