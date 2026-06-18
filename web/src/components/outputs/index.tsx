import DOMPurify from "dompurify";
import katex from "katex";
import type { Output } from "../../lib/store";
import { stripAnsi } from "../../lib/ansi";

// Full Phase 2 MIME set: text/html, image/svg+xml, image/png|jpeg, text/latex,
// application/json, text/plain — plus stream and error outputs. For a display
// bundle we render the single richest representation, mirroring Jupyter.
export function OutputView({ outputs }: { outputs: Output[] }) {
  if (outputs.length === 0) return null;
  return (
    <div className="outputs">
      {outputs.map((output, i) => (
        <OutputItem key={i} output={output} />
      ))}
    </div>
  );
}

function OutputItem({ output }: { output: Output }) {
  switch (output.kind) {
    case "stream":
      return <pre className={`output stream ${output.name}`}>{output.text}</pre>;
    case "error":
      return (
        <pre className="output error">
          {stripAnsi(output.traceback.join("\n")) ||
            `${output.ename}: ${output.evalue}`}
        </pre>
      );
    case "display":
      return <DisplayOutput data={output.data} />;
  }
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join("");
  return String(v ?? "");
}

function stripLatexDelims(s: string): string {
  const t = s.trim();
  if (t.startsWith("$$") && t.endsWith("$$")) return t.slice(2, -2);
  if (t.startsWith("$") && t.endsWith("$")) return t.slice(1, -1);
  return t;
}

function DisplayOutput({ data }: { data: Record<string, unknown> }) {
  if ("text/html" in data) {
    const html = DOMPurify.sanitize(asString(data["text/html"]));
    return <div className="output html" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if ("image/svg+xml" in data) {
    const svg = DOMPurify.sanitize(asString(data["image/svg+xml"]), {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
    return <div className="output image" dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  if ("image/png" in data) {
    return (
      <img
        className="output image"
        src={`data:image/png;base64,${asString(data["image/png"])}`}
        alt="cell output"
      />
    );
  }
  if ("image/jpeg" in data) {
    return (
      <img
        className="output image"
        src={`data:image/jpeg;base64,${asString(data["image/jpeg"])}`}
        alt="cell output"
      />
    );
  }
  if ("text/latex" in data) {
    const html = katex.renderToString(stripLatexDelims(asString(data["text/latex"])), {
      throwOnError: false,
      displayMode: true,
    });
    return <div className="output latex" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if ("application/json" in data) {
    return (
      <pre className="output json">
        {JSON.stringify(data["application/json"], null, 2)}
      </pre>
    );
  }
  if ("text/plain" in data) {
    return <pre className="output result">{stripAnsi(asString(data["text/plain"]))}</pre>;
  }
  return <pre className="output result">{JSON.stringify(data, null, 2)}</pre>;
}
