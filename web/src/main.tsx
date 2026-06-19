import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
import App from "./App";
import { AuthGate } from "./components/AuthGate";
import { installAuthFetch } from "./lib/auth";
import "./styles.css";

installAuthFetch(); // inject the access token into /api calls (no-op when unset)

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
