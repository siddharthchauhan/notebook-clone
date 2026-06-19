# Design: conflict-free (CRDT) collaboration

## Status

**Not implemented.** Today's collaboration (Phase 7) is broadcast-based:
per-cell edits (`doc_op`) are relayed to other clients and applied
last-writer-wins, with a cursor-safe guard so a *focused* editor is never
overwritten. This is solid for the common case (people working in different
cells) but does **not** converge when two people edit the **same** cell's text
at the same moment.

This document specifies how to close that gap. It is deliberately scoped as a
separate effort because a correct CRDT layer is a subsystem in its own right —
the same reason the Jupyter project ships `jupyter-collaboration` / `pycrdt`
rather than baking it into the kernel protocol.

## Why it isn't a quick patch

Character-level convergence needs either a CRDT or operational transforms.
Half-measures (e.g. relaying CodeMirror change deltas without transformation)
**diverge silently** under concurrency — strictly worse than last-writer-wins,
because the document corrupts instead of just dropping one edit. So this is
all-or-nothing: do real CRDT, or keep the honest last-writer-wins.

## Chosen architecture (Yjs + pycrdt, server-authoritative)

Mirror the proven JupyterLab RTC stack:

- **Shared types** — a `Y.Doc` per notebook: `Y.Array` of cells, each a `Y.Map`
  with `id`, `cell_type`, `metadata`, `rendered`, and **`source: Y.Text`**.
  Outputs / execution state stay *out* of the doc (they're runtime, kernel-driven,
  per-client) and remain in the zustand store keyed by cell id.
- **Server owns the doc** (`pycrdt`). The room is seeded from the `.ipynb`
  **on creation, before any client connects** — so clients only ever *sync*,
  never *seed*. This eliminates the double-seed race that makes naive
  peer-to-peer CRDT duplicate cells on a fresh notebook.
- **Transport** — the y-sync protocol (`y-protocols/sync`) over the existing
  `/ws/{id}` socket: a new `ysync` message carries base64 Yjs updates. On
  connect the server sends its state; updates are applied to the server doc and
  relayed to the other clients.
- **Persistence** — a debounced observer on the server doc writes
  `Y.Doc → nbformat → disk`, *replacing* the client-side autosave for
  source/structure. One writer (the server) means no last-writer-wins on disk.
- **Client binding** — `y-codemirror.next`'s `yCollab` binds each cell's
  `Y.Text` to its CodeMirror view, giving character-level merge **and** remote
  cursors/selections for free. The zustand store becomes a *projection* of the
  `Y.Array` (rebuilt on `observeDeep`, merging runtime-only fields); structural
  store actions mutate the `Y.Array` inside a transaction.

## Migration plan (stages, each shippable + tested)

1. **Server room** — `pycrdt` doc per notebook, seeded from `.ipynb`; `ysync`
   relay; debounced doc→disk persistence. Unit-test seed + apply-update + persist.
2. **Client doc + projection** — build the `Y.Doc`, a provider over the WS, and
   the `Y.Array → store` projection. Replace `doc_op` source ops with `Y.Text`;
   keep structural `doc_op` or move it into the array (prefer the array).
3. **Editor binding** — swap the `remoteEpoch` re-sync for `yCollab`; remote
   cursors land here.
4. **Cutover** — remove the Phase 7 `doc_op`/`applyRemoteOp` source path and the
   client autosave; keep presence (it's orthogonal and already works).

## Test plan

- **Convergence** (the bar): two headless clients type interleaved edits into the
  **same** cell; assert both `Y.Text`s (and both stores) converge to identical
  text. This is the check that proves CRDT vs. last-writer-wins.
- **Offline/redo**: a client disconnects, edits locally, reconnects; assert its
  buffered update merges without loss.
- Re-run the full existing e2e (35 checks) against the new sync to guard
  regressions.

## Scope note

Multi-user *identity* and per-notebook *sharing roles* build on Phase 8's token
gate (replace the single shared token with per-user tokens + an ACL on
`notebook_id`). That's independent of the CRDT work above.
