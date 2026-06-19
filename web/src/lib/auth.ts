// Optional shared-token auth. The token lives in localStorage and is injected
// into every /api request by a fetch interceptor (installed once); the WS appends
// it as a query param. When the server reports auth is off, none of this matters.

const KEY = "nbclone_token";

export function getToken(): string {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore storage failures */
  }
}

export async function authStatus(): Promise<{ required: boolean }> {
  const r = await fetch("/api/auth");
  if (!r.ok) return { required: false };
  return r.json();
}

// Add the bearer token to same-origin /api calls. Idempotent; safe to call once.
let installed = false;
export function installAuthFetch(): void {
  if (installed) return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const token = getToken();
    const url = typeof input === "string" ? input : input.toString();
    if (token && url.startsWith("/api")) {
      const headers = new Headers(init?.headers);
      if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
      return orig(input, { ...init, headers });
    }
    return orig(input, init);
  };
}
