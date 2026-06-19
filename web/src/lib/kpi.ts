// REST helper for big-number / KPI blocks: evaluate an expression and render it
// as a styled metric. Codegen lives on the server (label escaping + optional
// number format) so the block just supplies a spec.

export interface KpiSpec {
  expression: string;
  label: string;
  number_format?: string;
}

export async function generateKpiCode(spec: KpiSpec): Promise<string> {
  const r = await fetch("/api/kpi/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });
  if (!r.ok) {
    const detail = await r
      .json()
      .then((d) => d.detail as string)
      .catch(() => "");
    throw new Error(detail || "failed to generate KPI");
  }
  return (await r.json()).code as string;
}
