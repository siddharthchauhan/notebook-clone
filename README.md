# Notebook Clone

A Jupyter-style notebook built on the same spine throughout: CodeMirror cells →
FastAPI over WebSocket → a real `jupyter_client` kernel → live outputs streamed
back to the browser, **correctly correlated by cell**.

## Features

**Phase 1 — the spine**

- Run a code cell; `stdout` streams into its output.
- matplotlib renders inline PNGs; tracebacks render without crashing the server.
- A busy spinner shows while a cell runs and clears on idle.

**Phase 2 — a usable notebook**

- **Multi-cell editing**: add / delete / move cells, code **and** markdown
  cells, per-cell run, and run-all.
- **Markdown cells**: rendered (sanitized) with double-click to edit.
- **Persistent per-notebook kernels**: kernel state survives reloads/reconnects;
  **interrupt** and **restart** from the toolbar.
- **Rich outputs**: `text/plain`, `image/png` · `image/jpeg`, `text/html`
  (sanitized), `image/svg+xml`, `text/latex` (KaTeX), `application/json`.
- **Autocomplete** (kernel `complete`) and **inspect** (Shift+Tab → docs).
- **Kernel picker**, **autosave** to `.ipynb`, and **reconnect** with backoff.

**Phase 3 — AI assist** (Claude, streamed)

- Per-cell **✨ AI**: **Generate** code from a prompt, **Fix** a cell from its
  traceback, or **Explain** a cell — answers stream token-by-token over SSE.
- Generate/Fix land their result as a **new cell below** (never overwrites your
  code); Explain renders Markdown in an inline panel.
- Powered by the Anthropic API (`claude-opus-4-8`). **Degrades gracefully**: with
  no key configured the server reports unavailable and the UI hides all AI
  controls. A keyless `echo` provider drives the tests and e2e.

**Phase 4 — workspace** (explorer · export · multi-notebook · chat)

- **Variable explorer**: a side panel listing the kernel's user-defined globals
  (type, size, repr), auto-refreshing after each run. **Click a variable** to
  inspect its full value (kernel `inspect`), **filter** by name, or **delete** it
  from the kernel. Introspection is diverted through the single iopub pump — it
  never advances the `[n]` prompt or leaks output to a cell.
- **Export**: download any notebook as **.ipynb** or rendered **HTML** (nbconvert).
- **Multi-notebook browser**: list / open / create / delete notebooks from a left
  sidebar — no longer a single hardcoded notebook.
- **AI chat panel**: a conversational sidebar that streams Claude replies with the
  current notebook as context (complements the per-cell actions).

## Architecture

```
browser (Vite :5173)                      server (uvicorn :8000)
┌──────────────────────────┐              ┌───────────────────────────────────┐
│ CodeMirror cells          │  WS /ws/{id} │ FastAPI WebSocket (attach/detach)  │
│   execute / complete /    │─────────────▶│   → per-notebook KernelSession     │
│   inspect / interrupt /   │              │       (persistent, in a registry)  │
│   restart                 │◀─────────────┤   one iopub pump + one shell pump  │
│ zustand store (per-cell   │  status/out  │   broadcast → N attached sockets   │
│   outputs, append-only)   │  /reply/...  │   msg_to_cell correlation          │
│ rich renderers + markdown │              │ REST: /api/contents (autosave),    │
│ autosave (debounced PUT)  │  HTTP        │       /api/kernelspecs, /api/ai     │
│ per-cell AI (SSE stream)  │  SSE         │   /api/ai/complete → Claude (stream)│
└──────────────────────────┘              └───────────────────────────────────┘
```

Phase 4 adds `/api/notebooks` (list/create/delete), notebook export at
`/api/contents/{id}/export/{ipynb,html}`, a `variables_request` over the same WS
(its stdout captured by `msg_id`, parsed to a `variables_reply`), and the chat
endpoint `/api/ai/chat` — all on the existing spine.

**The crux (unchanged since Phase 1).** A kernel knows nothing about "cells".
Every output carries a `parent_header.msg_id` pointing back to the
`execute_request` that caused it, so correlation is just remembering, at submit
time, which cell owns which `msg_id` (`KernelSession.msg_to_cell`). There is
exactly **one** reader per channel (one iopub pump, one shell pump) fanning out
to N sockets; multiple readers would race and drop messages. Restart pauses the
pumps so `wait_for_ready` is the sole reader, then resumes — no race.

## Layout

```
server/                FastAPI + jupyter_client backend (Python 3.12, uv)
  app/
    models.py          Pydantic wire protocol (execute/complete/inspect/…)
    kernels/
      session.py       persistent KernelSession: iopub+shell pumps, broadcast
      manager.py       KernelRegistry: one session per notebook_id
      translate.py     iopub message → client event (pure)
      api.py           GET /api/kernelspecs, DELETE /api/kernels/{id}
    contents/          nbformat <-> document mapping; autosave, notebooks, export
    ai/                AI assist: service.py (prompts + pluggable provider),
                       api.py (status, /complete + /chat SSE)
    ws.py              /ws/{notebook_id}: attach, dispatch, detach
    main.py            app wiring, CORS, lifespan (shutdown_all)
  tests/               48 pytest: Phase 1 criteria + persistence/interrupt/
                       restart/complete/inspect + document round-trip + WS +
                       AI (prompt/echo/status/SSE/chat) + variables + notebooks
                       + export
web/                   Vite + React + TypeScript frontend
  src/
    lib/protocol.ts    TS mirror of models.py
    lib/store.ts       zustand: multi-cell, append-only streams, autosave rev
    lib/ws.ts          WS client: reconnect + request/reply (complete/inspect/vars)
    lib/document.ts    document, kernelspecs, notebooks, export REST helpers
    lib/ai.ts          AI status + SSE-over-fetch streamer (complete + chat)
    components/        Editor, Cell, Toolbar, AiAssist (per-cell ✨ AI),
                       VariableExplorer, AiChat, NotebookBrowser, SidePanel,
                       outputs/ (rich MIME renderers)
  e2e/run.mjs          Playwright smoke test of the live UI (22 checks)
```

## Quickstart

Prerequisites: **Python 3.12**, [uv](https://docs.astral.sh/uv/), **Node 18+**.

```bash
# terminal A — server
cd server && uv sync --extra dev
uv run uvicorn app.main:app --reload --port 8000

# terminal B — frontend
cd web && npm install
npm run dev          # http://localhost:5173
```

Open http://localhost:5173. The starter notebook has a markdown title and a
`print("hi")` code cell. Edit and press **Shift+Enter** (or **▶ Run**). Use the
toolbar to run-all, interrupt, restart, add cells, or switch kernels. Try
`%matplotlib inline` plots, a pandas DataFrame (`text/html`), `1/0`, or
Shift+Tab on a symbol for docs.

> Python 3.12 is pinned to avoid the jupyter_client "no running event loop"
> issue seen on 3.14 (jupyter/jupyter_client#1079). The matplotlib snippet uses
> `%matplotlib inline` so a fresh kernel emits `image/png`.

> **AI assist (optional).** Set `ANTHROPIC_API_KEY` (or `NBCLONE_ANTHROPIC_API_KEY`)
> in the server's environment to enable the per-cell **✨ AI** features; without
> a key the controls stay hidden. Override the model with `NBCLONE_AI_MODEL`
> (default `claude-opus-4-8`). `NBCLONE_AI_PROVIDER=echo` selects a keyless,
> deterministic stub used by the tests and e2e.

## Verification

```bash
cd server && uv run pytest        # 48 passed (headless, real kernel)

cd web && npm run build           # typecheck + production build
# Optional headless-browser smoke test. Start the server with
# NBCLONE_AI_PROVIDER=echo so the AI flows run keyless; the e2e expects a fresh
# starter, so clear server/notebooks/*.ipynb first if you've used the app:
npx playwright install chromium
npm run e2e                       # 22 checks, drives the real UI end-to-end
```

The e2e check exercises markdown rendering, stdout, tracebacks, inline PNG,
add-cell, **variable persistence across cells**, restart-clears-state, the queued
indicator, checkpoints, **AI generate/explain/chat**, the **variable explorer** (inspect/filter/delete),
**.ipynb/HTML export**, and **notebook create/delete** — all in a real browser
against the live stack.

## Out of scope (future)

Real-time collaboration, `ipywidgets`, auth, and data connectors — each a
focused follow-up rather than incremental polish.
