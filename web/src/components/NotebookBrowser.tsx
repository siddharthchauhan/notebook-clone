import { useEffect, useState } from "react";
import {
  createNotebook,
  deleteNotebook,
  listNotebooks,
  type NotebookEntry,
} from "../lib/document";

// Left sidebar: list / open / create / delete notebooks. The active notebook is
// owned by App (notebookId); this component just lists and fires callbacks.
export function NotebookBrowser({
  current,
  onOpen,
  onClose,
}: {
  current: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<NotebookEntry[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setItems(await listNotebooks());
    } catch {
      /* best-effort */
    }
  };

  useEffect(() => {
    void refresh();
  }, [current]);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setError(null);
    try {
      const created = await createNotebook(n);
      setName("");
      await refresh();
      onOpen(created.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(`Delete notebook "${id}"? This cannot be undone.`)) return;
    try {
      await deleteNotebook(id);
      const next = await listNotebooks();
      setItems(next);
      if (id === current) onOpen(next[0]?.id ?? "default");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <aside className="notebook-browser">
      <div className="nb-head">
        <span>Notebooks</span>
        <button className="nb-close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <ul className="nb-list">
        {items.map((nb) => (
          <li
            key={nb.id}
            className={`nb-item ${nb.id === current ? "active" : ""}`}
          >
            <button className="nb-open" onClick={() => onOpen(nb.id)} title={nb.id}>
              {nb.id}
            </button>
            <button className="nb-delete" title="Delete" onClick={() => void remove(nb.id)}>
              🗑
            </button>
          </li>
        ))}
      </ul>

      <div className="nb-new-row">
        <input
          className="nb-new-input"
          placeholder="New notebook name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
        />
        <button className="nb-new" onClick={() => void create()} disabled={!name.trim()}>
          +
        </button>
      </div>
      {error && <div className="nb-error">{error}</div>}
    </aside>
  );
}
