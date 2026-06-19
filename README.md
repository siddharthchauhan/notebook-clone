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
  inspect its full value (kernel `inspect`), **filter** by name, **sort** by any
  column, **expand** a container (dict/list/tuple/set) to see its children, or
  **delete** it from the kernel. Introspection is diverted through the single
  iopub pump — it never advances the `[n]` prompt or leaks output to a cell.
- **Export**: download any notebook as **.ipynb** or rendered **HTML** (nbconvert).
- **Multi-notebook browser**: list / open / create / delete notebooks from a left
  sidebar — no longer a single hardcoded notebook.
- **AI chat panel**: a conversational sidebar that streams Claude replies with the
  current notebook as context (complements the per-cell actions).

**Phase 5 — interactivity & data**

- **Live ipywidgets**: interactive widgets (sliders, buttons, dropdowns, …)
  render in cell outputs and stay in sync with the kernel. The Jupyter *comm*
  protocol is relayed over the same WebSocket — kernel-originated
  `comm_open`/`comm_msg`/`comm_close` broadcast to every socket (a widget model
  isn't owned by a cell, so it's routed by `comm_id`, not `cell_id`), and a
  browser interaction sends `comm_msg` back on the shell channel. The frontend
  embeds a live subclass of `@jupyter-widgets/html-manager`; binary widget state
  travels as base64.
- **Data connectors**: a **Data** panel loads a source into a pandas DataFrame —
  **SQLite**, **CSV/JSON files**, an **HTTP URL**, any **SQLAlchemy** database, or
  **Parquet/Excel**. The server returns the loader code for the chosen params and
  the UI drops it into a **new, editable cell** and runs it (transparent, not
  hidden). The catalog reports which connectors' dependencies are installed;
  params are interpolated as safe literals and the target variable is validated,
  so a connector can't inject code. Adding a source is one entry in a registry.

**Phase 6 — Deepnote-style blocks** ([deepnote](https://github.com/deepnote/deepnote)-inspired)

- **SQL blocks**: a first-class **SQL** block — pick a connection (a SQLite file
  or any SQLAlchemy URL), write SQL, and get a DataFrame rendered inline. The
  block compiles to pandas under the hood (reusing the connectors codegen) and
  runs through the normal execute path, so outputs, the `[n]` prompt, and autosave
  all just work. It generalizes the cell model into a **block model**
  (code · markdown · sql); blocks persist as valid nbformat (a code cell tagged
  under `metadata.deepnote`), so the `.ipynb` still opens anywhere.
- **Input blocks**: no-code **text / slider / select / checkbox** controls, each
  bound to a kernel global. Changing a control binds the variable (e.g.
  `threshold = 42`) so any code cell can use it. Binding runs **silently**
  (`store_history=False`, the same diverted channel as the variable explorer), so
  it never advances the `[n]` prompt or leaks output — and the explorer refreshes
  to show the new value. The value is sent as a JSON scalar and emitted server-side
  via `repr`, so it can't inject code.
- **Chart blocks**: no-code visualization — name a DataFrame, pick a chart type
  (line / bar / area / scatter / hist) and X/Y columns, and a figure renders
  inline. The column pickers **auto-populate** from the kernel (a `columns_request`
  over the WS introspects the frame's columns through the same diverted channel as
  the explorer). The block compiles to matplotlib server-side (`/api/charts` —
  DataFrame name validated, columns emitted via `repr`) and runs through the normal
  execute path, so the PNG renders like any plot. Because a chart **reads** its
  DataFrame, reactive mode re-runs it whenever that frame changes.
- **Reactive execution** (opt-in **⚡ Reactive** toggle): when a block changes,
  the blocks that depend on it re-run automatically — change a slider and every
  chart/table built from it refreshes. Dependencies come from each block's
  read/write sets: code is analyzed server-side with Python's `ast` (`/api/analyze`
  — proper scope handling so function locals/params and comprehension vars aren't
  mistaken for dependencies), while SQL/input/chart blocks declare their reads and
  writes. A block B is downstream of A when B reads a name A writes, computed
  transitively in notebook order; dependents are enqueued after the trigger and the
  kernel's FIFO shell channel guarantees they see the new values. Off by default,
  so normal run-when-you-say-so behavior is unchanged.
- **App / dashboard view** (📊 **App** toggle): flips the notebook into a clean
  presentation — code, editors, and toolbars disappear, leaving rendered markdown,
  **interactive input controls**, and block outputs (charts, tables, prints).
  Entering app view turns reactivity on, so moving a slider re-runs its dependents
  and the dashboard updates live. Output-less cells are simply hidden. It's a pure
  view over the same notebook — toggle back and every editor returns untouched.
- _Roadmap toward Deepnote parity_: big-number/KPI blocks, scheduled runs,
  comments, and real-time collaboration.

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
endpoint `/api/ai/chat` — all on the existing spine. Phase 5 relays the Jupyter
**comm** protocol over the same WS (kernel comm messages broadcast globally;
browser comm messages sent on the shell channel) for live ipywidgets, and `/api/connectors` (catalog + loader-code generation).

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
    connectors/        data-source registry + /api/connectors (codegen)
    analysis.py        AST read/write analysis + /api/analyze (reactive deps)
    charts.py          no-code chart spec -> matplotlib (/api/charts)
    ws.py              /ws/{notebook_id}: attach, dispatch, detach
    main.py            app wiring, CORS, lifespan (shutdown_all)
  tests/               77 pytest: Phase 1 criteria + persistence/interrupt/
                       restart/complete/inspect + document round-trip + WS +
                       AI (prompt/echo/status/SSE/chat) + variables + notebooks
                       + export + widgets (comm relay) + connectors + blocks
web/                   Vite + React + TypeScript frontend
  src/
    lib/protocol.ts    TS mirror of models.py
    lib/store.ts       zustand: block model (code/markdown/sql/input/chart), autosave rev
    lib/ws.ts          WS client: reconnect + request/reply + comm relay
    lib/widgets.ts     live ipywidgets manager (@jupyter-widgets/html-manager)
    lib/connectors.ts  data-connector catalog + codegen REST helpers
    lib/charts.ts      chart-spec -> matplotlib codegen REST helper
    lib/reactive.ts    dependency graph + reactive re-run orchestration
    lib/document.ts    document, kernelspecs, notebooks, export REST helpers
    lib/ai.ts          AI status + SSE-over-fetch streamer (complete + chat)
    components/        Editor, Cell, Toolbar, AiAssist (per-cell ✨ AI),
                       VariableExplorer, DataConnectors, AiChat, NotebookBrowser,
                       SidePanel,
                       outputs/ (rich MIME renderers)
  e2e/run.mjs          Playwright smoke test of the live UI (32 checks)
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
cd server && uv run pytest        # 77 passed (headless, real kernel)

cd web && npm run build           # typecheck + production build
# Optional headless-browser smoke test. Start the server with
# NBCLONE_AI_PROVIDER=echo so the AI flows run keyless; the e2e expects a fresh
# starter, so clear server/notebooks/*.ipynb first if you've used the app:
npx playwright install chromium
npm run e2e                       # 32 checks, drives the real UI end-to-end
```

The e2e check exercises markdown rendering, stdout, tracebacks, inline PNG,
add-cell, **variable persistence across cells**, restart-clears-state, the queued
indicator, checkpoints, **AI generate/explain/chat**, the **variable explorer** (inspect/filter/delete),
**.ipynb/HTML export**, and **notebook create/delete** — all in a real browser
against the live stack.

## Out of scope (future)

Real-time collaboration, `ipywidgets`, auth, and data connectors — each a
focused follow-up rather than incremental polish.
