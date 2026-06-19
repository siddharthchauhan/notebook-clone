import { useStore, type CellType } from "./lib/store";
import { Cell } from "./components/Cell";
import type { NotebookSocket } from "./lib/ws";

export function Notebook({ socket }: { socket: NotebookSocket }) {
  const cells = useStore((s) => s.cells);
  const appMode = useStore((s) => s.appMode);

  const add = (type: CellType) => useStore.getState().addCell(null, type);

  return (
    <main className={`notebook${appMode ? " app" : ""}`}>
      {cells.map((cell) => (
        <Cell key={cell.id} cellId={cell.id} socket={socket} />
      ))}
      {!appMode && (
        <div className="add-row">
          <button onClick={() => add("code")}>+ Code</button>
          <button onClick={() => add("markdown")}>+ Markdown</button>
        </div>
      )}
    </main>
  );
}
