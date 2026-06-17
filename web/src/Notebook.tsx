import { useStore } from "./lib/store";
import { Cell } from "./components/Cell";
import type { NotebookSocket } from "./lib/ws";

export function Notebook({ socket }: { socket: NotebookSocket }) {
  const cells = useStore((s) => s.cells);
  const connected = useStore((s) => s.connected);

  return (
    <div className="notebook">
      <header className="nb-header">
        <h1>Notebook Clone</h1>
        <span className={`conn ${connected ? "on" : "off"}`}>
          {connected ? "● kernel connected" : "○ disconnected"}
        </span>
      </header>
      {cells.map((cell) => (
        <Cell key={cell.id} cellId={cell.id} socket={socket} />
      ))}
    </div>
  );
}
