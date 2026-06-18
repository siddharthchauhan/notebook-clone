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
    contents/          nbformat <-> client "document" mapping; autosave API
    ai/                AI assist: service.py (prompt + pluggable provider),
                       api.py (GET /api/ai/status, POST /api/ai/complete SSE)
    ws.py              /ws/{notebook_id}: attach, dispatch, detach
    main.py            app wiring, CORS, lifespan (shutdown_all)
  tests/               38 pytest: Phase 1 criteria + persistence/interrupt/
                       restart/complete/inspect + document round-trip + WS +
                       AI prompt/echo-stream/status/SSE
web/                   Vite + React + TypeScript frontend
  src/
    lib/protocol.ts    TS mirror of models.py
    lib/store.ts       zustand: multi-cell, append-only streams, autosave rev
    lib/ws.ts          WS client: reconnect + request/reply (complete/inspect)
    lib/document.ts    cell model <-> server document; contents/kernelspecs API
    lib/ai.ts          AI status + SSE-over-fetch streamer
    components/        Editor (CM6 + autocomplete/inspect), Cell, Toolbar,
                       AiAssist (per-cell ✨ AI), outputs/ (rich MIME renderers)
  e2e/run.mjs          Playwright smoke test of the live UI
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
cd server && uv run pytest        # 38 passed (headless, real kernel)

cd web && npm run build           # typecheck + production build
# Optional headless-browser smoke test (servers must be running). Start the
# server with NBCLONE_AI_PROVIDER=echo to also exercise the AI flow:
npx playwright install chromium
npm run e2e                       # drives the real UI end-to-end
```

The e2e check exercises markdown rendering, stdout, tracebacks, inline PNG,
add-cell, **variable persistence across cells**, restart-clears-state, markdown
rendering, the queued indicator, checkpoints, and — when AI is configured —
**AI generate** (streams a new cell) and **AI explain** — all in a real browser
against the live stack.

## Out of scope (future)

Real-time collaboration, a variable explorer/debugger, `ipywidgets`, notebook
export (nbconvert), a multi-notebook file browser, auth, and data connectors.
