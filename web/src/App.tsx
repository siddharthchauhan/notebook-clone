import { useEffect, useRef, useState } from "react";
import { NotebookSocket } from "./lib/ws";
import { useStore, emptyCell } from "./lib/store";
import { Notebook } from "./Notebook";
import { Toolbar } from "./components/Toolbar";
import {
  createCheckpoint,
  listCheckpoints,
  loadDocument,
  loadKernelSpecs,
  restoreCheckpoint,
  saveDocument,
  type Checkpoint,
  type KernelSpec,
} from "./lib/document";
import { aiStatus } from "./lib/ai";

const NOTEBOOK_ID = "default";

type SaveState = "saved" | "saving" | "dirty";

export default function App() {
  const socketRef = useRef<NotebookSocket | null>(null);
  const [ready, setReady] = useState(false);
  const [kernelSpecs, setKernelSpecs] = useState<KernelSpec[]>([]);
  const [kernelName, setKernelName] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);

  const revision = useStore((s) => s.revision);

  const refreshCheckpoints = async () => {
    try {
      setCheckpoints(await listCheckpoints(NOTEBOOK_ID));
    } catch {
      /* checkpoints are best-effort */
    }
  };

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
      void refreshCheckpoints();
      // Gate the AI controls on whether the server has a provider configured.
      void aiStatus()
        .then((s) => !cancelled && useStore.getState().setAiAvailable(s.available))
        .catch(() => {});
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

  const onCreateCheckpoint = async () => {
    try {
      // Flush current edits so the checkpoint captures the latest state.
      await saveDocument(NOTEBOOK_ID, useStore.getState().cells);
      await createCheckpoint(NOTEBOOK_ID);
      await refreshCheckpoints();
    } catch {
      /* best-effort */
    }
  };

  const onRestoreCheckpoint = async (checkpointId: string) => {
    try {
      useStore.getState().setCells(await restoreCheckpoint(NOTEBOOK_ID, checkpointId));
    } catch {
      /* best-effort */
    }
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
        checkpoints={checkpoints}
        onCreateCheckpoint={onCreateCheckpoint}
        onRestoreCheckpoint={onRestoreCheckpoint}
      />
      <Notebook socket={socketRef.current} />
    </>
  );
}
