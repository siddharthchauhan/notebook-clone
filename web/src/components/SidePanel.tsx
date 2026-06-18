import { useStore } from "../lib/store";
import type { NotebookSocket } from "../lib/ws";
import { VariableExplorer } from "./VariableExplorer";
import { AiChat } from "./AiChat";

export type PanelTab = "variables" | "chat";

// Right-hand dock hosting the Variable Explorer and the AI Chat as tabs. The
// Chat tab only appears when the server has AI configured.
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
        {active === "variables" ? <VariableExplorer socket={socket} /> : <AiChat />}
      </div>
    </aside>
  );
}
