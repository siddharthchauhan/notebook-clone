import type { ClientEvent, ExecuteRequest } from "./protocol";
import { useStore } from "./store";

// WebSocket client for one notebook. Incoming events are dispatched straight
// into the zustand store; outgoing execute requests are sent as JSON.
//
// Phase 1 reconnect is a stub: on an unexpected close we retry with a fixed
// backoff. Full reconnect (resubscribe, replay, jitter) is Phase 2.
export class NotebookSocket {
  private ws: WebSocket | null = null;
  private notebookId: string;
  private closedByUser = false;
  private reconnectTimer: number | null = null;

  constructor(notebookId: string) {
    this.notebookId = notebookId;
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // Relative to the current origin so Vite's dev proxy forwards to :8000.
    const url = `${proto}://${location.host}/ws/${this.notebookId}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => useStore.getState().setConnected(true);

    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as ClientEvent;
        useStore.getState().applyEvent(event);
      } catch (err) {
        console.error("failed to parse server event", err, ev.data);
      }
    };

    ws.onclose = () => {
      useStore.getState().setConnected(false);
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = (err) => console.error("websocket error", err);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  execute(cellId: string, code: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn("cannot execute: socket not open");
      return;
    }
    const req: ExecuteRequest = {
      type: "execute_request",
      cell_id: cellId,
      code,
    };
    this.ws.send(JSON.stringify(req));
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer != null) window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
