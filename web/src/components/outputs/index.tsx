import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import katex from "katex";
import type { Output } from "../../lib/store";
import type { KernelWidgetManager } from "../../lib/widgets";
import { ansiToHtml, stripAnsi } from "../../lib/ansi";

const WIDGET_VIEW = "application/vnd.jupyter.widget-view+json";

// Full Phase 2 MIME set: text/html, image/svg+xml, image/png|jpeg, text/latex,
// application/json, text/plain — plus stream and error outputs, and live
// ipywidgets views. For a display bundle we render the single richest
// representation, mirroring Jupyter.
export function OutputView({
  outputs,
  manager,
}: {
  outputs: Output[];
  manager?: KernelWidgetManager;
}) {
  if (outputs.length === 0) return null;
  return (
    <div className="outputs">
      {outputs.map((output, i) => (
        <OutputItem key={i} output={output} manager={manager} />
      ))}
    </div>
  );
}

function OutputItem({
  output,
  manager,
}: {
  output: Output;
  manager?: KernelWidgetManager;
}) {
  switch (output.kind) {
    case "stream":
      return <pre className={`output stream ${output.name}`}>{output.text}</pre>;
    case "error":
      // ansiToHtml HTML-escapes its input, so this is safe to inject.
      return (
        <pre
          className="output error"
          dangerouslySetInnerHTML={{
            __html: ansiToHtml(
              output.traceback.join("\n") || `${output.ename}: ${output.evalue}`,
            ),
          }}
        />
      );
    case "display":
      return <DisplayOutput data={output.data} manager={manager} />;
  }
}

// Mounts a live ipywidgets view for a model the manager already knows about
// (created from the kernel's comm_open). A persisted widget output whose model
// no longer exists (e.g. after reload without re-running) shows a hint.
function WidgetOutput({
  manager,
  modelId,
}: {
  manager: KernelWidgetManager;
  modelId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let view: { remove?: () => void } | undefined;
    (async () => {
      try {
        const model = await manager.get_model(modelId);
        if (disposed || !ref.current) return;
        view = await manager.create_view(model);
        if (disposed) {
          view?.remove?.();
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await manager.display_view(view as any, ref.current);
      } catch {
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      try {
        view?.remove?.();
      } catch {
        /* already gone */
      }
    };
  }, [manager, modelId]);

  if (failed) {
    return (
      <div className="output widget-missing">⚠ widget unavailable — re-run the cell</div>
    );
  }
  return <div className="output widget jupyter-widgets" ref={ref} />;
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

function DisplayOutput({
  data,
  manager,
}: {
  data: Record<string, unknown>;
  manager?: KernelWidgetManager;
}) {
  // A live widget view takes precedence over the text/plain fallback ipywidgets
  // also ships in the bundle.
  if (WIDGET_VIEW in data && manager) {
    const mv = data[WIDGET_VIEW] as { model_id?: string };
    if (mv?.model_id) return <WidgetOutput manager={manager} modelId={mv.model_id} />;
  }
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
