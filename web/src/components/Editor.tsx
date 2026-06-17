import { useEffect, useRef } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { python } from "@codemirror/lang-python";
import { useStore } from "../lib/store";

interface EditorProps {
  cellId: string;
  initialValue: string;
  onRun: () => void;
}

// A thin React wrapper around a CodeMirror 6 view. Edits are pushed into the
// store on every change; Shift+Enter triggers the cell's run handler.
export function Editor({ cellId, initialValue, onRun }: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep the latest onRun without re-creating the editor on every render.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  useEffect(() => {
    if (!hostRef.current) return;

    const runKeymap = Prec.highest(
      keymap.of([
        {
          key: "Shift-Enter",
          run: () => {
            onRunRef.current();
            return true;
          },
        },
      ]),
    );

    const syncToStore = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        useStore.getState().setSource(cellId, update.state.doc.toString());
      }
    });

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialValue,
        extensions: [runKeymap, basicSetup, python(), syncToStore],
      }),
    });

    return () => view.destroy();
    // initialValue is the seed only; cellId identifies the editor instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellId]);

  return <div className="cm-host" ref={hostRef} />;
}
