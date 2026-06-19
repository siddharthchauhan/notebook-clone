"""Optional shared-token access control."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import auth
from app.config import settings
from app.main import app


def test_auth_off_by_default():
    client = TestClient(app)
    assert client.get("/api/auth").json() == {"required": False}
    # With no token configured, protected endpoints are open.
    assert client.get("/api/kernelspecs").status_code == 200


def test_token_gates_api(monkeypatch):
    monkeypatch.setattr(settings, "auth_token", "s3cret")
    client = TestClient(app)

    # The status probe stays public so the UI can show a login gate.
    assert client.get("/api/auth").json() == {"required": True}

    # Protected without a token → 401.
    assert client.get("/api/kernelspecs").status_code == 401
    # Wrong token → 401.
    assert client.get(
        "/api/kernelspecs", headers={"Authorization": "Bearer nope"}
    ).status_code == 401
    # Correct token (header or query) → 200.
    assert client.get(
        "/api/kernelspecs", headers={"Authorization": "Bearer s3cret"}
    ).status_code == 200
    assert client.get("/api/kernelspecs?token=s3cret").status_code == 200


def test_token_ok_helper(monkeypatch):
    monkeypatch.setattr(settings, "auth_token", "")
    # A trivial connection-like object isn't needed when auth is off.
    assert auth.auth_required() is False
