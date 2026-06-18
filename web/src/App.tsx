import { useEffect, useRef, useState } from "react";
import { NotebookSocket } from "./lib/ws";
import { useStore, emptyCell } from "./lib/store";
import { Notebook } from "./Notebook";
import { Toolbar } from "./components/Toolbar";
import {
  loadDocument,
  loadKernelSpecs,
  saveDocument,
  type KernelSpec,
} from "./lib/document";

const NOTEBOOK_ID = "default";

type SaveState = "saved" | "saving" | "dirty";

export default function App() {
  const socketRef = useRef<NotebookSocket | null>(null);
  const [ready, setReady] = useState(false);
  const [kernelSpecs, setKernelSpecs] = useState<KernelSpec[]>([]);
  const [kernelName, setKernelName] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");

  const revision = useStore((s) => s.revision);

  // -- initial load: kernelspecs + document, then connect -------------- #
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let initialKernel: string | null = null;
      try {
        const specs = await loadKernelSpecs();
        if (!cancelled) {
          setKernelSpecs(specs.kernelspecs);
          initialKernel = specs.default;
          setKernelName(specs.default);
        }
      } catch {
        /* kernelspecs are optional; picker just stays empty */
      }
      try {
        const cells = await loadDocument(NOTEBOOK_ID);
        if (!cancelled) useStore.getState().setCells(cells.length ? cells : [emptyCell("code")]);
      } catch {
        if (!cancelled) useStore.getState().setCells([emptyCell("code")]);
      }
      if (cancelled) return;
      const socket = new NotebookSocket(NOTEBOOK_ID, initialKernel);
      socketRef.current = socket;
      socket.connect();
      setReady(true);
    })();

    return () => {
      cancelled = true;
      socketRef.current?.close();
    };
  }, []);

  // -- debounced autosave on persistable changes ----------------------- #
  useEffect(() => {
    if (!ready || revision === 0) return; // nothing edited yet
    setSaveState("dirty");
    const timer = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        await saveDocument(NOTEBOOK_ID, useStore.getState().cells);
        setSaveState("saved");
      } catch {
        setSaveState("dirty");
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [revision, ready]);

  const changeKernel = async (name: string) => {
    if (name === kernelName) return;
    // Switching kernels means a fresh session: drop the server session, then
    // reconnect with the chosen kernelspec.
    await fetch(`/api/kernels/${NOTEBOOK_ID}`, { method: "DELETE" }).catch(() => {});
    socketRef.current?.close();
    useStore.getState().setKernel("connecting", name);
    const socket = new NotebookSocket(NOTEBOOK_ID, name);
    socketRef.current = socket;
    socket.connect();
    setKernelName(name);
  };

  if (!ready || !socketRef.current) {
    return <div className="loading">Loading…</div>;
  }

  return (
    <>
      <Toolbar
        socket={socketRef.current}
        kernelSpecs={kernelSpecs}
        kernelName={kernelName}
        onChangeKernel={changeKernel}
        saveState={saveState}
      />
      <Notebook socket={socketRef.current} />
    </>
  );
}
