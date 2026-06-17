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


settings = Settings()
