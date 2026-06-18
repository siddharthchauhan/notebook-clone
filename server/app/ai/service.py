"""AI assist: build prompts and stream a model response.

Two response *modes*:

* ``code`` — generate / fix / edit: the model returns **only** raw code, which
  the browser streams straight into a notebook cell.
* ``text`` — explain: the model returns Markdown prose, rendered in a panel.

The provider is pluggable. :class:`AnthropicProvider` *lazily* imports the SDK
so the rest of the app (and the test suite) loads even when ``anthropic`` is
absent; :class:`EchoProvider` is a deterministic, network-free stub used by the
tests and the headless e2e run (enable with ``NBCLONE_AI_PROVIDER=echo``).
"""

from __future__ import annotations

import os
from typing import AsyncIterator, Literal, Protocol

from pydantic import BaseModel, Field

from app.config import settings

Action = Literal["generate", "fix", "explain", "edit"]
Mode = Literal["code", "text"]


class AIRequest(BaseModel):
    """A unit of AI work: one action over (optionally) some cell context."""

    action: Action
    instruction: str = ""
    code: str = ""
    traceback: list[str] = Field(default_factory=list)
    language: str = "python"


# System prompts. Code-mode is deliberately strict — the stream is piped into a
# cell verbatim, so any stray prose or fences would corrupt it. (We run without
# extended thinking for latency; the "only code" instruction doubles as the
# final-answer-only guard recommended for thinking-off requests.)
CODE_SYSTEM = (
    "You are a coding assistant embedded in a {language} notebook. "
    "Return ONLY valid {language} code for a single notebook cell. "
    "Do not wrap it in Markdown fences, do not add backticks, commentary, or "
    "explanation — output only the code itself. Prefer concise, idiomatic code."
)

TEXT_SYSTEM = (
    "You are a helpful assistant embedded in a Python notebook. Answer "
    "concisely in GitHub-flavored Markdown. Use fenced code blocks for any code."
)


def build_prompt(req: AIRequest) -> tuple[str, str, Mode]:
    """Return ``(system, user, mode)`` for the request's action."""
    if req.action == "explain":
        user = (
            "Explain what the following notebook cell does, and call out any "
            f"bugs or gotchas:\n\n```{req.language}\n{req.code}\n```"
        )
        return TEXT_SYSTEM, user, "text"

    system = CODE_SYSTEM.format(language=req.language)

    if req.action == "generate":
        user = "Write code for this request:\n\n" + req.instruction
        if req.code.strip():
            user += (
                "\n\nExisting code in the cell (extend or replace as needed):\n"
                + req.code
            )
    elif req.action == "fix":
        tb = "\n".join(req.traceback)
        user = (
            "The following cell raised an error. Return a corrected version of "
            f"the whole cell.\n\nCode:\n{req.code}\n\nTraceback:\n{tb}"
        )
    elif req.action == "edit":
        user = (
            "Edit the following cell per the instruction. Return the full edited "
            f"cell.\n\nInstruction: {req.instruction}\n\nCode:\n{req.code}"
        )
    else:  # pragma: no cover - unreachable behind the Literal type
        raise ValueError(f"unknown action: {req.action}")

    return system, user, "code"


class Provider(Protocol):
    def stream(self, system: str, user: str, mode: Mode) -> AsyncIterator[str]: ...


class AnthropicProvider:
    """Streams completions from the Anthropic Messages API."""

    def __init__(self, api_key: str | None, model: str, max_tokens: int) -> None:
        self._api_key = api_key
        self._model = model
        self._max_tokens = max_tokens

    async def stream(self, system: str, user: str, mode: Mode) -> AsyncIterator[str]:
        import anthropic  # lazy import: keeps the SDK optional for tests / echo

        # AsyncAnthropic() resolves ANTHROPIC_API_KEY from the env on its own;
        # pass an explicit key only when one was configured via settings.
        client = (
            anthropic.AsyncAnthropic(api_key=self._api_key)
            if self._api_key
            else anthropic.AsyncAnthropic()
        )
        async with client.messages.stream(
            model=self._model,
            max_tokens=self._max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        ) as stream:
            async for text in stream.text_stream:
                yield text


class EchoProvider:
    """Deterministic, network-free stub for tests and the e2e run.

    Emits in a couple of chunks so the streaming path is exercised end to end.
    """

    async def stream(self, system: str, user: str, mode: Mode) -> AsyncIterator[str]:
        chunks = (
            ["This cell ", "prints a value ", "and returns `None`."]
            if mode == "text"
            else ["print('hello ", "from ai')\n"]
        )
        for chunk in chunks:
            yield chunk


def _resolve_api_key() -> str | None:
    return settings.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")


class AIService:
    """Selects a provider from live settings and streams a built prompt."""

    def available(self) -> bool:
        if settings.ai_provider == "echo":
            return True
        return bool(_resolve_api_key())

    def _provider(self) -> Provider:
        if settings.ai_provider == "echo":
            return EchoProvider()
        return AnthropicProvider(
            _resolve_api_key(), settings.ai_model, settings.ai_max_tokens
        )

    async def stream(self, req: AIRequest) -> AsyncIterator[str]:
        system, user, mode = build_prompt(req)
        async for delta in self._provider().stream(system, user, mode):
            yield delta


service = AIService()
