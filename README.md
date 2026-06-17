# Notebook Clone — Phase 1 vertical slice

A minimal Jupyter-style notebook that proves the hard part end-to-end:

> one CodeMirror cell → FastAPI → a real `jupyter_client` kernel → live outputs
> streamed back to the browser, **correctly correlated by cell**.

Everything else (multiple cells, markdown, autosave, interrupt/restart UI,
full MIME set, AI features) is incremental once this spine works, and is
deferred to later phases.

## What works

All four acceptance criteria pass (see [Verification](#verification)):

1. `print("hi")` streams `hi` into the cell's output.
2. A matplotlib snippet renders a PNG inline.
3. `1/0` renders a traceback — the server does **not** crash.
4. A `time.sleep(3)` cell shows a busy spinner that clears on idle.

## Architecture

```
browser (Vite :5173)                      server (uvicorn :8000)
┌──────────────────────────┐              ┌───────────────────────────────────┐
│ CodeMirror 6 editor       │  WS /ws/{id} │ FastAPI WebSocket                  │
│   └ execute_request ──────┼─────────────▶│   └ KernelSession.execute()        │
│                           │              │        └ jupyter_client kernel      │
│ zustand store             │◀─────────────┼── single iopub pump → translate    │
│   └ outputs keyed by cell │  status/     │        └ to_client_event()          │
│ output renderers          │  stream/     │                                     │
│   text · image/png · err  │  display/err │ GET/PUT /api/contents/{id} (nbformat)│
└──────────────────────────┘              └───────────────────────────────────┘
```

**The crux.** A kernel knows nothing about "cells". Every output message it
publishes carries a `parent_header.msg_id` pointing back to the
`execute_request` that caused it. Correlating outputs to cells is therefore
*entirely* a matter of remembering, at submit time, which cell owns which
`msg_id` — that mapping is `KernelSession.msg_to_cell`. There is exactly **one**
long-lived task draining the iopub channel; multiple concurrent readers would
race and silently drop messages. This single-pump + one-dict design is the
whole correctness mechanism, and it is tested explicitly
(`test_outputs_correlate_to_their_own_cell`).

## Layout

```
server/                FastAPI + jupyter_client backend (Python 3.12, uv)
  app/
    config.py          settings (host/port, CORS, kernel name)
    models.py          Pydantic wire protocol (client↔server)
    kernels/
      session.py       KernelSession — lifecycle, execute, the iopub pump
      translate.py     raw iopub message → client event (pure function)
    contents/
      store.py         nbformat load/save of the starter notebook
      api.py           GET/PUT /api/contents/{id}
    ws.py              /ws/{notebook_id} WebSocket endpoint
    main.py            app wiring + CORS
  tests/               headless pytest (real kernel) + WS integration test
web/                   Vite + React + TypeScript frontend
  src/
    lib/protocol.ts    TS mirror of models.py (discriminated union)
    lib/ws.ts          WebSocket client
    lib/store.ts       zustand store (append-only stream buffers)
    components/        Editor (CodeMirror), Cell (spinner + outputs), renderers
    App.tsx            loads the starter notebook, wires the socket
```

## Quickstart

Prerequisites: **Python 3.12**, [uv](https://docs.astral.sh/uv/), and **Node 18+**.

> Python 3.12 is pinned to avoid the `jupyter_client` "no running event loop"
> issue observed on 3.14 (jupyter/jupyter_client#1079).

### 1. Server (terminal A)

```bash
cd server
uv sync --extra dev          # create venv + install deps
uv run uvicorn app.main:app --reload --port 8000
```

### 2. Frontend (terminal B)

```bash
cd web
npm install
npm run dev                  # http://localhost:5173
```

Open http://localhost:5173. The starter notebook loads a single
`print("hi")` cell. Edit it and press **Shift+Enter** (or click **▶ Run**).

The Vite dev server proxies `/api` and `/ws` to the FastAPI server on `:8000`,
so the browser only ever talks to `:5173` (no CORS friction in dev).

### Try the acceptance scenarios in the browser

```python
# 1. stdout
print("hi")

# 2. inline PNG  (the %matplotlib inline magic activates the inline backend)
%matplotlib inline
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
ax.plot([1, 2, 3], [1, 4, 9])

# 3. traceback (server stays alive)
1 / 0

# 4. busy spinner that clears on idle
import time; time.sleep(3)
```

> **matplotlib note:** a fresh kernel only emits `image/png` once the inline
> backend is active, so the snippet starts with `%matplotlib inline`.
> Auto-configuring the backend kernel-side is a Phase 2 polish.

## Verification

The server spine is proven headless (no browser needed):

```bash
cd server
uv run pytest          # 12 passed
```

| Acceptance criterion        | Test                                            |
| --------------------------- | ----------------------------------------------- |
| #1 stdout streaming         | `test_stdout_streams_to_cell`                   |
| #2 matplotlib inline PNG    | `test_matplotlib_renders_png`                   |
| #3 traceback, no crash      | `test_zero_division_traceback_keeps_kernel_alive` |
| #4 busy → idle status       | `test_busy_then_idle_status`                    |
| per-cell correlation guard  | `test_outputs_correlate_to_their_own_cell`      |
| WS endpoint round-trip      | `test_ws.py` (Starlette TestClient)             |

The frontend typechecks and builds with `cd web && npm run build`.

## Out of scope for Phase 1

Cell add/delete/move, markdown cells, the full MIME set (html/svg/latex/json),
autosave/checkpoints, interrupt/restart UI, an execution queue,
autocomplete/inspect, kernel picker, and AI/connectors — all Phase 2+.
