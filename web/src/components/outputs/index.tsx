import type { Output } from "../../lib/store";
import { stripAnsi } from "../../lib/ansi";

// Phase 1 renderers: text/plain, image/png, and error tracebacks. The full
// MIME set (html/svg/latex/json) is Phase 2.
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

    case "display": {
      const png = output.data["image/png"];
      if (typeof png === "string") {
        return (
          <img
            className="output image"
            src={`data:image/png;base64,${png}`}
            alt="cell output"
          />
        );
      }
      const text = output.data["text/plain"];
      return (
        <pre className="output result">
          {typeof text === "string" ? text : JSON.stringify(output.data, null, 2)}
        </pre>
      );
    }

    case "error":
      return (
        <pre className="output error">
          {stripAnsi(output.traceback.join("\n")) ||
            `${output.ename}: ${output.evalue}`}
        </pre>
      );
  }
}
