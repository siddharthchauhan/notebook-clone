"""Variable-explorer introspection over a real kernel session."""

from __future__ import annotations


async def test_inspect_variables_lists_user_globals(kernel):
    session, collector = kernel

    session.execute("c1", "myvar = [1, 2, 3]\nname = 'alice'")
    await collector.wait_idle("c1")

    session.inspect_variables("req-1")
    reply = await collector.wait_event(
        lambda e: e.get("type") == "variables_reply" and e.get("request_id") == "req-1"
    )

    by_name = {v["name"]: v for v in reply["variables"]}
    assert "myvar" in by_name and "name" in by_name
    assert by_name["myvar"]["type"] == "list"
    assert by_name["myvar"]["size"] == "3"
    assert by_name["name"]["type"] == "str"

    # Introspection must not leak its helper or expose dunder/internal names.
    assert all(not v["name"].startswith("_") for v in reply["variables"])
    assert "__ve_dump" not in by_name


async def test_inspect_variables_does_not_emit_cell_output(kernel):
    session, collector = kernel
    session.inspect_variables("req-2")
    await collector.wait_event(
        lambda e: e.get("type") == "variables_reply" and e.get("request_id") == "req-2"
    )
    # The introspection script's stdout is diverted, never sent as a stream
    # event the UI would route to a cell.
    assert not any(e.get("type") == "stream" for e in collector.events)


async def test_delete_variable_removes_it_and_returns_the_rest(kernel):
    session, collector = kernel
    session.execute("c1", "doomed = 99\nkeep = 1")
    await collector.wait_idle("c1")

    session.delete_variable("d1", "doomed")
    reply = await collector.wait_event(
        lambda e: e.get("type") == "variables_reply" and e.get("request_id") == "d1"
    )
    names = {v["name"] for v in reply["variables"]}
    assert "doomed" not in names
    assert "keep" in names


async def test_delete_variable_rejects_non_identifier(kernel):
    """A non-identifier name is a no-op delete — guards against code injection."""
    session, collector = kernel
    session.execute("c1", "x = 1")
    await collector.wait_idle("c1")

    session.delete_variable("d2", "x; import os")
    reply = await collector.wait_event(
        lambda e: e.get("type") == "variables_reply" and e.get("request_id") == "d2"
    )
    assert "x" in {v["name"] for v in reply["variables"]}
