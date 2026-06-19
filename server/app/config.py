"""Application settings for the notebook-clone server.

Phase 1 keeps configuration intentionally small: just the things the WS layer
and CORS middleware need. Values can be overridden via environment variables
(prefix ``NBCLONE_``) so the dev/prod split stays out of the code.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NBCLONE_", env_file=".env")

    host: str = "127.0.0.1"
    port: int = 8000

    # The Vite dev server origin. Listed explicitly for CORS on the REST routes;
    # the WebSocket handshake is not subject to CORS but we proxy it in dev.
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    # Kernel spec name registered by ipykernel. "python3" is the default kernel
    # installed alongside ipykernel in this project's virtualenv.
    default_kernel_name: str = "python3"

    # How long to wait for a freshly started kernel to report ready.
    kernel_startup_timeout: float = 30.0

    # -- AI assist (Phase 3) -------------------------------------------- #
    # The real provider needs an Anthropic API key. Either set
    # ``NBCLONE_ANTHROPIC_API_KEY`` here or the SDK-standard ``ANTHROPIC_API_KEY``
    # in the environment; when neither is present the AI endpoints report
    # ``available: false`` and return 503 so the UI hides its AI controls.
    anthropic_api_key: str | None = None
    ai_model: str = "claude-opus-4-8"
    ai_max_tokens: int = 2048

    # Provider selection: "auto" uses Anthropic when a key is available,
    # otherwise unavailable. "echo" forces a deterministic local stub with no
    # network or key — used by the test suite and the headless e2e run.
    ai_provider: str = "auto"

    # -- access control (Phase 8) --------------------------------------- #
    # A shared access token gating the API + WebSocket. When empty (the default)
    # auth is OFF — the app is open, so dev, tests, and the e2e run are
    # unaffected. Set ``NBCLONE_AUTH_TOKEN`` to require it; clients then send it
    # as ``Authorization: Bearer <token>`` (REST) or ``?token=`` (WebSocket).
    auth_token: str = ""


settings = Settings()
