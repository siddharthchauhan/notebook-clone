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


async def test_set_variable_binds_value_and_returns_variables(kernel):
    """Input blocks bind a scalar to a global; it shows up in the explorer and
    is usable from a normal cell — without advancing the [n] prompt."""
    session, collector = kernel

    session.set_variable("s1", "threshold", 42)
    reply = await collector.wait_event(
        lambda e: e.get("type") == "variables_reply" and e.get("request_id") == "s1"
    )
    by_name = {v["name"]: v for v in reply["variables"]}
    assert by_name["threshold"]["type"] == "int"

    # The bound value is real state the kernel can compute with.
    session.execute("c1", "print(threshold * 2)")
    out = await collector.wait_event(
        lambda e: e.get("type") == "stream" and e.get("cell_id") == "c1"
    )
    assert "84" in out["text"]


async def test_df_columns_lists_dataframe_columns(kernel):
    """Chart blocks ask for a DataFrame's columns; introspection is diverted, so
    it never leaks output to a cell."""
    session, collector = kernel
    session.execute(
        "c1", "import pandas as pd\nframe = pd.DataFrame({'a': [1], 'b': [2], 'c': [3]})"
    )
    await collector.wait_idle("c1")

    session.df_columns("cols-1", "frame")
    reply = await collector.wait_event(
        lambda e: e.get("type") == "columns_reply" and e.get("request_id") == "cols-1"
    )
    assert reply["columns"] == ["a", "b", "c"]
    assert reply["name"] == "frame"
    assert not any(e.get("type") == "stream" for e in collector.events)


async def test_df_columns_on_missing_or_bad_name_is_empty(kernel):
    session, collector = kernel
    session.df_columns("cols-2", "not_a_df")
    reply = await collector.wait_event(
        lambda e: e.get("type") == "columns_reply" and e.get("request_id") == "cols-2"
    )
    assert reply["columns"] == []


async def test_set_variable_quotes_strings_and_rejects_bad_name(kernel):
    """A string value is emitted as a literal (no injection), and a non-identifier
    name binds nothing."""
    session, collector = kernel

    session.set_variable("s2", "label", "a'b; import os")
    reply = await collector.wait_event(
        lambda e: e.get("type") == "variables_reply" and e.get("request_id") == "s2"
    )
    by_name = {v["name"]: v for v in reply["variables"]}
    assert by_name["label"]["type"] == "str"

    session.set_variable("s3", "bad name", 1)
    reply = await collector.wait_event(
        lambda e: e.get("type") == "variables_reply" and e.get("request_id") == "s3"
    )
    assert "bad" not in {v["name"] for v in reply["variables"]}


async def test_variable_children_lists_dict_items(kernel):
    session, collector = kernel
    session.execute("c1", "m = {'a': 1, 'b': 2}")
    await collector.wait_idle("c1")

    session.variable_children("ch1", "m")
    reply = await collector.wait_event(
        lambda e: e.get("type") == "variable_children_reply"
        and e.get("request_id") == "ch1"
    )
    assert reply["name"] == "m"
    by_key = {c["key"]: c for c in reply["children"]}
    assert "'a'" in by_key and "'b'" in by_key
    assert by_key["'a'"]["repr"] == "1"


async def test_variable_children_lists_list_items_in_order(kernel):
    session, collector = kernel
    session.execute("c1", "xs = [10, 20, 30]")
    await collector.wait_idle("c1")

    session.variable_children("ch2", "xs")
    reply = await collector.wait_event(
        lambda e: e.get("type") == "variable_children_reply"
        and e.get("request_id") == "ch2"
    )
    assert [c["repr"] for c in reply["children"]] == ["10", "20", "30"]
    assert reply["children"][0]["key"] == "0"


async def test_variable_children_rejects_non_identifier(kernel):
    """A non-identifier name yields no children — guards against code injection."""
    session, collector = kernel
    session.variable_children("ch3", "m; import os")
    reply = await collector.wait_event(
        lambda e: e.get("type") == "variable_children_reply"
        and e.get("request_id") == "ch3"
    )
    assert reply["children"] == []
