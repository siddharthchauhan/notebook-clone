import { useEffect, useRef, useState } from "react";
import { NotebookSocket } from "./lib/ws";
import { useStore, type CellState } from "./lib/store";
import { Notebook } from "./Notebook";

const NOTEBOOK_ID = "default";

interface RawCell {
  cell_type: string;
  id?: string;
  source: string | string[];
}

function defaultCell(): CellState {
  return { id: "cell-1", source: 'print("hi")', outputs: [], execution_state: "idle" };
}

function toCellState(raw: RawCell): CellState {
  return {
    id: raw.id ?? crypto.randomUUID(),
    source: Array.isArray(raw.source) ? raw.source.join("") : raw.source ?? "",
    outputs: [],
    execution_state: "idle",
  };
}

export default function App() {
  const socketRef = useRef<NotebookSocket | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const socket = new NotebookSocket(NOTEBOOK_ID);
    socket.connect();
    socketRef.current = socket;

    // Populate the editor from the starter notebook via the contents API,
    // falling back to a single default cell if the server is unreachable.
    fetch(`/api/contents/${NOTEBOOK_ID}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((nb: { cells?: RawCell[] }) => {
        const cells = (nb.cells ?? [])
          .filter((c) => c.cell_type === "code")
          .map(toCellState);
        useStore.getState().setCells(cells.length ? cells : [defaultCell()]);
      })
      .catch(() => useStore.getState().setCells([defaultCell()]))
      .finally(() => setReady(true));

    return () => socket.close();
  }, []);

  if (!ready || !socketRef.current) {
    return <div className="loading">Loading…</div>;
  }
  return <Notebook socket={socketRef.current} />;
}
