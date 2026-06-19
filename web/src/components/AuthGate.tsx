import { useCallback, useEffect, useState } from "react";
import { authStatus, getToken, setToken } from "../lib/auth";

// Gate the app behind the shared token when the server requires one. When auth
// is off (the default), this renders children immediately.
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "need" | "ok">("checking");
  const [error, setError] = useState(false);

  const check = useCallback(async () => {
    try {
      const { required } = await authStatus();
      if (!required) return setState("ok");
      if (!getToken()) return setState("need");
      // Verify the stored token against a protected endpoint.
      const r = await fetch("/api/kernelspecs");
      if (r.ok) return setState("ok");
      setError(true);
      setState("need");
    } catch {
      // If even the status probe fails, don't lock the user out.
      setState("ok");
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (state === "ok") return <>{children}</>;
  if (state === "checking") return <div className="loading">Loading…</div>;

  return (
    <div className="auth-gate">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          const token = new FormData(e.currentTarget).get("token") as string;
          setToken(token.trim());
          setError(false);
          setState("checking");
          void check();
        }}
      >
        <h1>Notebook Clone</h1>
        <p>This workspace requires an access token.</p>
        <input name="token" type="password" placeholder="Access token" autoFocus />
        {error && <div className="auth-error">Invalid token — try again.</div>}
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
