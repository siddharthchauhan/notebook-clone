import { useStore, type CellType } from "./lib/store";
import { Cell } from "./components/Cell";
import type { NotebookSocket } from "./lib/ws";

export function Notebook({ socket }: { socket: NotebookSocket }) {
  const cells = useStore((s) => s.cells);

  const add = (type: CellType) => useStore.getState().addCell(null, type);

  return (
    <main className="notebook">
      {cells.map((cell) => (
        <Cell key={cell.id} cellId={cell.id} socket={socket} />
      ))}
      <div className="add-row">
        <button onClick={() => add("code")}>+ Code</button>
        <button onClick={() => add("markdown")}>+ Markdown</button>
      </div>
    </main>
  );
}
