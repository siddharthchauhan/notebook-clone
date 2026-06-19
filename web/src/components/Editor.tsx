import { useEffect, useRef } from "react";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { useStore, type CellType } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";

interface EditorProps {
  cellId: string;
  cellType: CellType;
  initialValue: string;
  socket: NotebookSocket;
  onRun: () => void;
  onInspect?: (text: string | null) => void;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : Array.isArray(v) ? v.join("") : String(v ?? "");
}

// Async completion source backed by the kernel's complete_request.
function kernelCompletions(socket: NotebookSocket) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const word = ctx.matchBefore(/[\w.]+/);
    if (!ctx.explicit && (!word || word.from === word.to)) return null;
    try {
      const reply = await socket.complete(ctx.state.doc.toString(), ctx.pos);
      if (!reply.matches.length) return null;
      return {
        from: reply.cursor_start,
        to: reply.cursor_end,
        options: reply.matches.map((label) => ({ label })),
        validFor: /^[\w.]*$/,
      };
    } catch {
      return null;
    }
  };
}

export function Editor({
  cellId,
  cellType,
  initialValue,
  socket,
  onRun,
  onInspect,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onInspectRef = useRef(onInspect);
  onInspectRef.current = onInspect;

  useEffect(() => {
    if (!hostRef.current) return;

    const keys: KeyBinding[] = [
      { key: "Shift-Enter", run: () => (onRunRef.current(), true) },
    ];
    if (cellType === "code") {
      // Shift-Tab: ask the kernel to inspect the symbol at the cursor.
      keys.push({
        key: "Shift-Tab",
        run: (view: EditorView) => {
          void (async () => {
            try {
              const reply = await socket.inspect(
                view.state.doc.toString(),
                view.state.selection.main.head,
              );
              onInspectRef.current?.(
                reply.found ? asString(reply.data["text/plain"]) : null,
              );
            } catch {
              onInspectRef.current?.(null);
            }
          })();
          return true;
        },
      });
    }

    const extensions: Extension[] = [
      Prec.highest(keymap.of(keys)),
      basicSetup,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          useStore.getState().setSource(cellId, u.state.doc.toString());
        }
      }),
    ];
    extensions.push(
      cellType === "markdown" ? markdown() : cellType === "sql" ? sql() : python(),
    );
    if (cellType === "code") {
      extensions.push(autocompletion({ override: [kernelCompletions(socket)] }));
    }

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({ doc: initialValue, extensions }),
    });
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellId, cellType]);

  return <div className="cm-host" ref={hostRef} />;
}
