"""Tests for AI assist: prompt building, the echo provider, and the API.

These never touch the network: the ``echo`` provider is a deterministic stub,
and the unavailable-path tests force ``auto`` with no key present.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import config
from app.ai import service as ai_service
from app.ai.service import AIRequest, build_prompt
from app.main import app


@pytest.fixture
def echo(monkeypatch):
    """Force the deterministic echo provider for the duration of a test."""
    monkeypatch.setattr(config.settings, "ai_provider", "echo")


@pytest.fixture
def unavailable(monkeypatch):
    """Force the auto provider with no key resolvable anywhere."""
    monkeypatch.setattr(config.settings, "ai_provider", "auto")
    monkeypatch.setattr(config.settings, "anthropic_api_key", None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


# -- prompt building --------------------------------------------------- #


def test_explain_is_text_mode():
    system, user, mode = build_prompt(AIRequest(action="explain", code="print(1)"))
    assert mode == "text"
    assert "Markdown" in system
    assert "print(1)" in user


@pytest.mark.parametrize("action", ["generate", "fix", "edit"])
def test_code_actions_are_code_mode(action):
    _system, _user, mode = build_prompt(
        AIRequest(action=action, instruction="do x", code="y", traceback=["boom"])
    )
    assert mode == "code"


def test_fix_prompt_includes_code_and_traceback():
    _system, user, _mode = build_prompt(
        AIRequest(action="fix", code="1/0", traceback=["ZeroDivisionError: division by zero"])
    )
    assert "1/0" in user
    assert "ZeroDivisionError" in user


def test_generate_prompt_includes_instruction():
    _system, user, _mode = build_prompt(
        AIRequest(action="generate", instruction="load a csv with pandas")
    )
    assert "load a csv with pandas" in user


# -- service / echo provider ------------------------------------------- #


async def test_echo_service_streams_code(echo):
    req = AIRequest(action="generate", instruction="say hi")
    out = "".join([chunk async for chunk in ai_service.service.stream(req)])
    assert "hello from ai" in out


async def test_echo_service_streams_text_for_explain(echo):
    req = AIRequest(action="explain", code="print(1)")
    out = "".join([chunk async for chunk in ai_service.service.stream(req)])
    assert "returns `None`" in out


def test_available_reflects_provider(echo):
    assert ai_service.service.available() is True


def test_unavailable_without_key(unavailable):
    assert ai_service.service.available() is False


# -- API --------------------------------------------------------------- #


def test_status_endpoint_reports_model(echo):
    client = TestClient(app)
    body = client.get("/api/ai/status").json()
    assert body["available"] is True
    assert body["model"] == config.settings.ai_model


def _join_sse_tokens(body: str) -> str:
    """Reconstruct the streamed text from ``token`` events, as the client does."""
    import json

    text = ""
    lines = body.splitlines()
    for i, line in enumerate(lines):
        if line == "event: token" and i + 1 < len(lines):
            data = lines[i + 1].removeprefix("data: ")
            text += json.loads(data)["text"]
    return text


def test_complete_streams_sse_token_and_done(echo):
    client = TestClient(app)
    r = client.post("/api/ai/complete", json={"action": "generate", "instruction": "hi"})
    assert r.status_code == 200
    assert "text/event-stream" in r.headers["content-type"]
    assert "event: token" in r.text
    assert "event: done" in r.text
    # Tokens span SSE frames; reconstructing them yields the full payload.
    assert "hello from ai" in _join_sse_tokens(r.text)


def test_complete_returns_503_when_unavailable(unavailable):
    client = TestClient(app)
    r = client.post("/api/ai/complete", json={"action": "generate", "instruction": "hi"})
    assert r.status_code == 503
