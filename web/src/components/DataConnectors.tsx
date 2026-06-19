import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import {
  generateConnectorCode,
  listConnectors,
  type ConnectorSpec,
} from "../lib/connectors";

// Data-connector panel: pick a source, fill its fields, and load it into a
// DataFrame. The server renders the loader code; we drop it into a new cell and
// run it — so the result is transparent and editable, not hidden.
export function DataConnectors({ socket }: { socket: NotebookSocket }) {
  const [specs, setSpecs] = useState<ConnectorSpec[] | null>(null);
  const [sel, setSel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = (c: ConnectorSpec) => {
    setSel(c.id);
    setValues(Object.fromEntries(c.fields.map((f) => [f.name, f.default])));
    setError(null);
  };

  useEffect(() => {
    listConnectors()
      .then((cs) => {
        setSpecs(cs);
        const first = cs.find((c) => c.available) ?? cs[0];
        if (first) choose(first);
      })
      .catch(() => setSpecs([]));
  }, []);

  const current = specs?.find((c) => c.id === sel) ?? null;

  const load = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const code = await generateConnectorCode(current.id, values);
      const id = useStore.getState().addCell(null, "code", code);
      useStore.getState().markQueued(id);
      socket.execute(id, code);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setBusy(false);
    }
  };

  if (!specs) return <div className="conn-loading">Loading…</div>;

  return (
    <div className="data-connectors">
      <div className="conn-head">Load data into a DataFrame</div>

      <select
        className="conn-select"
        value={sel}
        onChange={(e) => {
          const c = specs.find((x) => x.id === e.target.value);
          if (c) choose(c);
        }}
      >
        {specs.map((c) => (
          <option key={c.id} value={c.id} disabled={!c.available}>
            {c.label}
            {c.available ? "" : " (unavailable)"}
          </option>
        ))}
      </select>

      {current && !current.available && (
        <div className="conn-hint">
          Needs: <code>{current.missing.join(", ")}</code>
        </div>
      )}
      {current?.note && <div className="conn-note">{current.note}</div>}

      {current?.fields.map((f) => (
        <label key={f.name} className="conn-label">
          <span>
            {f.label}
            {f.required ? " *" : ""}
          </span>
          <input
            className="conn-field"
            name={f.name}
            placeholder={f.placeholder}
            value={values[f.name] ?? ""}
            onChange={(e) =>
              setValues((v) => ({ ...v, [f.name]: e.target.value }))
            }
          />
        </label>
      ))}

      <button
        className="conn-load"
        onClick={() => void load()}
        disabled={busy || !current || !current.available}
      >
        {busy ? "Loading…" : "Load data → new cell"}
      </button>

      {error && <div className="conn-error">{error}</div>}
    </div>
  );
}
