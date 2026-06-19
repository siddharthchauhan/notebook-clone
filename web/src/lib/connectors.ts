// REST helpers for data connectors. The catalog describes each source's form
// fields and whether its deps are installed; generate() returns loader code the
// caller drops into a new cell.

export interface ConnectorField {
  name: string;
  label: string;
  placeholder: string;
  default: string;
  required: boolean;
}

export interface ConnectorSpec {
  id: string;
  label: string;
  available: boolean;
  missing: string[];
  note: string;
  fields: ConnectorField[];
}

export async function listConnectors(): Promise<ConnectorSpec[]> {
  const r = await fetch("/api/connectors");
  if (!r.ok) throw new Error("failed to load connectors");
  return (await r.json()).connectors as ConnectorSpec[];
}

export async function generateConnectorCode(
  type: string,
  params: Record<string, string>,
): Promise<string> {
  const r = await fetch("/api/connectors/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, params }),
  });
  if (!r.ok) {
    const detail = await r
      .json()
      .then((d) => d.detail as string)
      .catch(() => "");
    throw new Error(detail || "failed to generate loader");
  }
  return (await r.json()).code as string;
}
