import { useEffect, useRef, useState } from "react";
import { NotebookSocket } from "./lib/ws";
import { useStore, emptyCell } from "./lib/store";
import { runAllCells } from "./lib/run";
import { Notebook } from "./Notebook";
import { Toolbar } from "./components/Toolbar";
import { NotebookBrowser } from "./components/NotebookBrowser";
import { SidePanel, type PanelTab } from "./components/SidePanel";
import {
  createCheckpoint,
  exportNotebookUrl,
  listCheckpoints,
  loadDocument,
  loadKernelSpecs,
  restoreCheckpoint,
  saveDocument,
  type Checkpoint,
  type KernelSpec,
} from "./lib/document";
import { aiStatus } from "./lib/ai";
import { listComments, getAuthor } from "./lib/comments";

type SaveState = "saved" | "saving" | "dirty";

export default function App() {
  const socketRef = useRef<NotebookSocket | null>(null);
  const [notebookId, setNotebookId] = useState("default");
  const [ready, setReady] = useState(false);
  const [kernelSpecs, setKernelSpecs] = useState<KernelSpec[]>([]);
  const [kernelName, setKernelName] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [panel, setPanel] = useState<PanelTab | null>(null);

  const revision = useStore((s) => s.revision);
  const autoRunMs = useStore((s) => s.autoRunMs);

  // Doc edits broadcast to collaborators through whatever socket is live now.
  useEffect(() => {
    useStore.getState().setBroadcaster((op) => socketRef.current?.docOp(op));
    return () => useStore.getState().setBroadcaster(null);
  }, []);

  const refreshCheckpoints = async () => {
    try {
      setCheckpoints(await listCheckpoints(notebookId));
    } catch {
      /* checkpoints are best-effort */
    }
  };

  // -- load document + connect, re-running when the notebook changes ---- #
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    socketRef.current?.close();
    useStore.getState().setNotebookId(notebookId);
    useStore.getState().setComments({});
    (async () => {
      let initialKernel: string | null = kernelName;
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
        const cells = await loadDocument(notebookId);
        if (!cancelled) useStore.getState().setCells(cells.length ? cells : [emptyCell("code")]);
      } catch {
        if (!cancelled) useStore.getState().setCells([emptyCell("code")]);
      }
      if (cancelled) return;
      const socket = new NotebookSocket(notebookId, initialKernel, getAuthor());
      socketRef.current = socket;
      socket.connect();
      setReady(true);
      void refreshCheckpoints();
      void listComments(notebookId)
        .then((c) => !cancelled && useStore.getState().setComments(c))
        .catch(() => {});
      void aiStatus()
        .then((s) => !cancelled && useStore.getState().setAiAvailable(s.available))
        .catch(() => {});
    })();

    return () => {
      cancelled = true;
      socketRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookId]);

  // -- debounced autosave on persistable changes ----------------------- #
  useEffect(() => {
    if (!ready || revision === 0) return; // nothing edited yet
    setSaveState("dirty");
    const timer = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        await saveDocument(notebookId, useStore.getState().cells);
        setSaveState("saved");
      } catch {
        setSaveState("dirty");
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [revision, ready, notebookId]);

  // -- scheduled runs: re-run the whole notebook on an interval (live apps) -- #
  useEffect(() => {
    if (!ready || autoRunMs <= 0) return;
    const timer = window.setInterval(() => {
      if (socketRef.current) void runAllCells(socketRef.current);
    }, autoRunMs);
    return () => window.clearInterval(timer);
  }, [autoRunMs, ready, notebookId]);

  const changeKernel = async (name: string) => {
    if (name === kernelName) return;
    // Switching kernels means a fresh session: drop the server session, then
    // reconnect with the chosen kernelspec.
    await fetch(`/api/kernels/${notebookId}`, { method: "DELETE" }).catch(() => {});
    socketRef.current?.close();
    useStore.getState().setKernel("connecting", name);
    const socket = new NotebookSocket(notebookId, name, getAuthor());
    socketRef.current = socket;
    socket.connect();
    setKernelName(name);
  };

  // Flush the current notebook before switching so no last edit is lost.
  const openNotebook = (id: string) => {
    if (id === notebookId) return;
    void saveDocument(notebookId, useStore.getState().cells)
      .catch(() => {})
      .finally(() => setNotebookId(id));
  };

  const onExport = async (fmt: "ipynb" | "html") => {
    try {
      await saveDocument(notebookId, useStore.getState().cells);
    } catch {
      /* export the last saved state if the flush fails */
    }
    window.open(exportNotebookUrl(notebookId, fmt), "_blank");
  };

  const onCreateCheckpoint = async () => {
    try {
      await saveDocument(notebookId, useStore.getState().cells);
      await createCheckpoint(notebookId);
      await refreshCheckpoints();
    } catch {
      /* best-effort */
    }
  };

  const onRestoreCheckpoint = async (checkpointId: string) => {
    try {
      useStore.getState().setCells(await restoreCheckpoint(notebookId, checkpointId));
    } catch {
      /* best-effort */
    }
  };

  const togglePanel = (tab: PanelTab) => setPanel((p) => (p === tab ? null : tab));

  if (!ready || !socketRef.current) {
    return <div className="loading">Loading…</div>;
  }

  return (
    <>
      <Toolbar
        socket={socketRef.current}
        notebookId={notebookId}
        kernelSpecs={kernelSpecs}
        kernelName={kernelName}
        onChangeKernel={changeKernel}
        saveState={saveState}
        checkpoints={checkpoints}
        onCreateCheckpoint={onCreateCheckpoint}
        onRestoreCheckpoint={onRestoreCheckpoint}
        onToggleBrowser={() => setBrowserOpen((b) => !b)}
        onTogglePanel={togglePanel}
        onExport={onExport}
      />
      <div className="layout">
        {browserOpen && (
          <NotebookBrowser
            current={notebookId}
            onOpen={openNotebook}
            onClose={() => setBrowserOpen(false)}
          />
        )}
        <Notebook socket={socketRef.current} />
        {panel && (
          <SidePanel
            tab={panel}
            onTab={setPanel}
            onClose={() => setPanel(null)}
            socket={socketRef.current}
          />
        )}
      </div>
    </>
  );
}
