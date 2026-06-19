// REST helper for chart blocks: turn a no-code chart spec (DataFrame + type +
// columns) into matplotlib code the caller runs in the block. Codegen lives on
// the server so the DataFrame name is validated and columns are safely quoted.

export const CHART_TYPES = ["line", "bar", "area", "scatter", "hist"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSpec {
  df: string;
  chart_type: string;
  x: string;
  y: string;
  title?: string;
}

export async function generateChartCode(spec: ChartSpec): Promise<string> {
  const r = await fetch("/api/charts/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });
  if (!r.ok) {
    const detail = await r
      .json()
      .then((d) => d.detail as string)
      .catch(() => "");
    throw new Error(detail || "failed to generate chart");
  }
  return (await r.json()).code as string;
}
