"""Unit tests for the pure iopub → client-event translation (no kernel)."""

from __future__ import annotations

from app.kernels.translate import to_client_event


def test_status_maps_to_status_event():
    ev = to_client_event("c1", "status", {"execution_state": "busy"})
    assert ev is not None and ev.type == "status"
    assert ev.cell_id == "c1" and ev.execution_state == "busy"


def test_execute_input_maps_to_exec_input_event():
    ev = to_client_event("c1", "execute_input", {"code": "x", "execution_count": 3})
    assert ev is not None and ev.type == "exec_input"
    assert ev.execution_count == 3


def test_stream_maps_to_stream_event():
    ev = to_client_event("c1", "stream", {"name": "stdout", "text": "hi\n"})
    assert ev is not None and ev.type == "stream"
    assert ev.name == "stdout" and ev.text == "hi\n"


def test_execute_result_and_display_data_both_map_to_display():
    bundle = {"data": {"text/plain": "7"}, "metadata": {}, "execution_count": 2}
    for msg_type in ("execute_result", "display_data"):
        ev = to_client_event("c1", msg_type, bundle)
        assert ev is not None and ev.type == "display"
        assert ev.data == {"text/plain": "7"}


def test_error_maps_to_error_event():
    ev = to_client_event(
        "c1",
        "error",
        {"ename": "ZeroDivisionError", "evalue": "x", "traceback": ["t"]},
    )
    assert ev is not None and ev.type == "error"
    assert ev.ename == "ZeroDivisionError"


def test_clear_output_maps_to_clear_output_event():
    ev = to_client_event("c1", "clear_output", {"wait": True})
    assert ev is not None and ev.type == "clear_output" and ev.wait is True


def test_unknown_types_return_none():
    assert to_client_event("c1", "comm_open", {}) is None
    assert to_client_event(None, "comm_msg", {}) is None


def test_none_cell_id_is_preserved():
    ev = to_client_event(None, "status", {"execution_state": "starting"})
    assert ev is not None and ev.cell_id is None
