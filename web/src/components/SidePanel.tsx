import { useStore } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import { VariableExplorer } from "./VariableExplorer";
import { DataConnectors } from "./DataConnectors";
import { AiChat } from "./AiChat";

export type PanelTab = "variables" | "data" | "chat";

// Right-hand dock hosting the Variable Explorer, Data connectors, and the AI
// Chat as tabs. The Chat tab only appears when the server has AI configured.
export function SidePanel({
  tab,
  onTab,
  onClose,
  socket,
}: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  socket: NotebookSocket;
}) {
  const aiAvailable = useStore((s) => s.aiAvailable);
  const active: PanelTab = tab === "chat" && !aiAvailable ? "variables" : tab;

  return (
    <aside className="dock">
      <div className="dock-tabs">
        <button
          className={`dock-tab ${active === "variables" ? "active" : ""}`}
          onClick={() => onTab("variables")}
        >
          Variables
        </button>
        <button
          className={`dock-tab ${active === "data" ? "active" : ""}`}
          onClick={() => onTab("data")}
        >
          Data
        </button>
        {aiAvailable && (
          <button
            className={`dock-tab ${active === "chat" ? "active" : ""}`}
            onClick={() => onTab("chat")}
          >
            ✨ Chat
          </button>
        )}
        <span className="spacer" />
        <button className="dock-close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="dock-body">
        {active === "variables" && <VariableExplorer socket={socket} />}
        {active === "data" && <DataConnectors socket={socket} />}
        {active === "chat" && <AiChat />}
      </div>
    </aside>
  );
}
