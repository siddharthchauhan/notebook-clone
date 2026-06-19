"""Optional shared-token access control for the API + WebSocket.

Auth is off unless ``NBCLONE_AUTH_TOKEN`` is set — so dev, tests, and the e2e
run stay open. When set, every ``/api/*`` request (except the public
``/api/auth`` status probe) and every WebSocket must present the token, as
``Authorization: Bearer <token>`` or ``?token=<token>``. This is a deliberately
simple single-shared-secret gate, not multi-user identity.
"""

from __future__ import annotations

from fastapi import APIRouter
from starlette.requests import HTTPConnection

from app.config import settings


def auth_required() -> bool:
    return bool(settings.auth_token)


def _provided_token(conn: HTTPConnection) -> str | None:
    header = conn.headers.get("authorization")
    if header and header.lower().startswith("bearer "):
        return header[7:].strip()
    return conn.query_params.get("token")


def token_ok(conn: HTTPConnection) -> bool:
    """True if auth is disabled, or the connection presents the right token."""
    if not auth_required():
        return True
    return _provided_token(conn) == settings.auth_token


router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("")
def auth_status() -> dict[str, bool]:
    """Public probe: does this server require a token? (Used by the login gate.)"""
    return {"required": auth_required()}
