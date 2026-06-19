// Client for the AI assist endpoints (Phase 3). `aiStatus` gates the UI; the
// `streamAI` helper consumes the server's SSE stream over fetch and invokes
// `onToken` per text delta, resolving on the `done` event and throwing on
// `error` or transport failure. Pass a signal to cancel a run.

export interface AiStatus {
  available: boolean;
  model: string;
}

export async function aiStatus(): Promise<AiStatus> {
  const r = await fetch("/api/ai/status");
  if (!r.ok) throw new Error(`ai status failed: ${r.status}`);
  return r.json();
}

export type AiAction = "generate" | "fix" | "explain" | "edit";

export interface AiRequest {
  action: AiAction;
  instruction?: string;
  code?: string;
  traceback?: string[];
  language?: string;
}

interface StreamOpts {
  onToken: (text: string) => void;
  signal?: AbortSignal;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// One parsed SSE frame: an `event:` line plus a JSON `data:` payload.
function parseFrame(frame: string): { event: string; data: unknown } | null {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  return { event, data: JSON.parse(data) };
}

// POST `body` to `path` and drive `onToken` from the SSE token stream. Resolves
// on `done`, throws on `error` or transport failure. Shared by complete + chat.
async function consumeSSE(path: string, body: unknown, opts: StreamOpts): Promise<void> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (r.status === 503) throw new Error("AI is not configured on the server");
  if (!r.ok || !r.body) throw new Error(`ai request failed: ${r.status}`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = parseFrame(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      if (!frame) continue;
      if (frame.event === "token") {
        opts.onToken((frame.data as { text: string }).text);
      } else if (frame.event === "error") {
        throw new Error((frame.data as { message: string }).message);
      } else if (frame.event === "done") {
        return;
      }
    }
  }
}

export function streamAI(req: AiRequest, opts: StreamOpts): Promise<void> {
  return consumeSSE("/api/ai/complete", req, opts);
}

export function streamChat(
  messages: ChatMessage[],
  context: string,
  opts: StreamOpts,
): Promise<void> {
  return consumeSSE("/api/ai/chat", { messages, context }, opts);
}
