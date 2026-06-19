import type {
  ClientEvent,
  ClientRequest,
  ColumnsReplyEvent,
  CompleteReplyEvent,
  InspectReplyEvent,
  VariableChildrenReplyEvent,
  VariablesReplyEvent,
} from "./protocol";
import { useStore, type DocOp } from "./store";
import { KernelWidgetManager } from "./widgets";

type ReplyEvent =
  | CompleteReplyEvent
  | InspectReplyEvent
  | VariablesReplyEvent
  | VariableChildrenReplyEvent
  | ColumnsReplyEvent;

// WebSocket client for one notebook. Output/status events are dispatched into
// the store; complete/inspect replies resolve the matching pending promise by
// request_id. Reconnect uses exponential backoff with jitter; the server keeps
// the kernel alive across the gap, so a reconnect just re-attaches.
export class NotebookSocket {
  private ws: WebSocket | null = null;
  private readonly notebookId: string;
  private readonly kernelName: string | null;
  private readonly name: string | null;
  private closedByUser = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private readonly pending = new Map<string, (event: ReplyEvent) => void>();
  // Live ipywidgets manager for this notebook; renders widget-view outputs.
  readonly widgets: KernelWidgetManager;

  constructor(
    notebookId: string,
    kernelName: string | null = null,
    name: string | null = null,
  ) {
    this.notebookId = notebookId;
    this.kernelName = kernelName;
    this.name = name;
    this.widgets = new KernelWidgetManager(this);
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams();
    if (this.kernelName) params.set("kernel", this.kernelName);
    if (this.name) params.set("name", this.name);
    const q = params.toString() ? `?${params}` : "";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.notebookId}${q}`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      useStore.getState().setConnected(true);
    };

    ws.onmessage = (ev) => {
      let event: ClientEvent;
      try {
        event = JSON.parse(ev.data) as ClientEvent;
      } catch (err) {
        console.error("failed to parse server event", err, ev.data);
        return;
      }
      if (
        event.type === "complete_reply" ||
        event.type === "inspect_reply" ||
        event.type === "variables_reply" ||
        event.type === "variable_children_reply" ||
        event.type === "columns_reply"
      ) {
        const resolve = this.pending.get(event.request_id);
        if (resolve) {
          this.pending.delete(event.request_id);
          resolve(event);
        }
        return;
      }
      // ipywidgets comm traffic is routed to the widget manager, not the store.
      if (event.type === "comm_open") {
        this.widgets.onCommOpen(event);
        return;
      }
      if (event.type === "comm_msg") {
        this.widgets.onCommMsg(event);
        return;
      }
      if (event.type === "comm_close") {
        this.widgets.onCommClose(event);
        return;
      }
      // Collaboration: a peer's edit, or the presence roster.
      if (event.type === "doc_op") {
        useStore.getState().applyRemoteOp(event.op as never);
        return;
      }
      if (event.type === "presence") {
        useStore.getState().setPeers(event.peers);
        return;
      }
      useStore.getState().applyEvent(event);
    };

    ws.onclose = () => {
      useStore.getState().setConnected(false);
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = (err) => console.error("websocket error", err);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    // Exponential backoff capped at 10s, with jitter to avoid thundering herd.
    const base = Math.min(1000 * 2 ** this.reconnectAttempts, 10000);
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(req: ClientRequest): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn("cannot send: socket not open", req.type);
      return false;
    }
    this.ws.send(JSON.stringify(req));
    return true;
  }

  execute(cellId: string, code: string): void {
    this.send({ type: "execute_request", cell_id: cellId, code });
  }

  interrupt(): void {
    this.send({ type: "interrupt_request" });
  }

  restart(): void {
    this.send({ type: "restart_request" });
  }

  private request<T extends ReplyEvent>(
    req: ClientRequest & { request_id: string },
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(req.request_id);
        reject(new Error("request timed out"));
      }, timeoutMs);
      this.pending.set(req.request_id, (event) => {
        window.clearTimeout(timer);
        resolve(event as T);
      });
      if (!this.send(req)) {
        window.clearTimeout(timer);
        this.pending.delete(req.request_id);
        reject(new Error("socket not open"));
      }
    });
  }

  complete(code: string, cursorPos: number): Promise<CompleteReplyEvent> {
    return this.request<CompleteReplyEvent>({
      type: "complete_request",
      request_id: crypto.randomUUID(),
      code,
      cursor_pos: cursorPos,
    });
  }

  inspect(code: string, cursorPos: number): Promise<InspectReplyEvent> {
    return this.request<InspectReplyEvent>({
      type: "inspect_request",
      request_id: crypto.randomUUID(),
      code,
      cursor_pos: cursorPos,
      detail_level: 0,
    });
  }

  variables(): Promise<VariablesReplyEvent> {
    return this.request<VariablesReplyEvent>({
      type: "variables_request",
      request_id: crypto.randomUUID(),
    });
  }

  deleteVariable(name: string): Promise<VariablesReplyEvent> {
    return this.request<VariablesReplyEvent>({
      type: "delete_variable_request",
      request_id: crypto.randomUUID(),
      name,
    });
  }

  variableChildren(name: string): Promise<VariableChildrenReplyEvent> {
    return this.request<VariableChildrenReplyEvent>({
      type: "variable_children_request",
      request_id: crypto.randomUUID(),
      name,
    });
  }

  // Bind a global to a scalar (input blocks); resolves with the refreshed list.
  setVariable(
    name: string,
    value: boolean | number | string,
  ): Promise<VariablesReplyEvent> {
    return this.request<VariablesReplyEvent>({
      type: "set_variable_request",
      request_id: crypto.randomUUID(),
      name,
      value,
    });
  }

  // A DataFrame's column names (chart-block X/Y pickers).
  columns(name: string): Promise<ColumnsReplyEvent> {
    return this.request<ColumnsReplyEvent>({
      type: "columns_request",
      request_id: crypto.randomUUID(),
      name,
    });
  }

  // Collaboration: broadcast a local document edit to peers on this notebook.
  docOp(op: DocOp): void {
    this.send({ type: "doc_op_request", op: op as unknown as Record<string, unknown> });
  }

  // --- comm protocol (ipywidgets), browser -> kernel; CommSink interface --- //
  commOpen(
    commId: string,
    targetName: string,
    data: Record<string, unknown>,
    metadata: Record<string, unknown>,
    buffers: string[],
  ): void {
    this.send({
      type: "comm_open_request",
      comm_id: commId,
      target_name: targetName,
      data,
      metadata,
      buffers,
    });
  }

  commMsg(commId: string, data: Record<string, unknown>, buffers: string[]): void {
    this.send({ type: "comm_msg_request", comm_id: commId, data, buffers });
  }

  commClose(commId: string, data: Record<string, unknown>): void {
    this.send({ type: "comm_close_request", comm_id: commId, data });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer != null) window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
