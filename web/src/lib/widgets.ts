// Live ipywidgets support: a widget manager that bridges the Jupyter *comm*
// protocol over our WebSocket. We subclass @jupyter-widgets/html-manager (which
// wires up the @jupyter-widgets/base + /controls model/view classes) and make
// it live by:
//   - routing kernel-originated comm_open/msg/close into the manager, and
//   - giving each model a comm whose send() goes back to the kernel.
//
// loadClass is overridden to resolve classes from ESM imports instead of the
// upstream `require('....css')` calls, which don't work under Vite.
import { HTMLManager } from "@jupyter-widgets/html-manager";
import type { IClassicComm } from "@jupyter-widgets/base";
import * as base from "@jupyter-widgets/base";
import * as controls from "@jupyter-widgets/controls";
import "@jupyter-widgets/controls/css/widgets.built.css";
import type { CommCloseEvent, CommMsgEvent, CommOpenEvent } from "./protocol";

const WIDGET_TARGET = "jupyter.widget";

// What the manager needs from the socket to talk back to the kernel.
export interface CommSink {
  commOpen(
    commId: string,
    targetName: string,
    data: Record<string, unknown>,
    metadata: Record<string, unknown>,
    buffers: string[],
  ): void;
  commMsg(commId: string, data: Record<string, unknown>, buffers: string[]): void;
  commClose(commId: string, data: Record<string, unknown>): void;
}

type Buf = ArrayBuffer | ArrayBufferView;

function toB64(buffers?: Buf[]): string[] {
  if (!buffers || buffers.length === 0) return [];
  return buffers.map((b) => {
    const bytes =
      b instanceof ArrayBuffer
        ? new Uint8Array(b)
        : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });
}

function fromB64(b64: string[]): ArrayBuffer[] {
  return (b64 ?? []).map((s) => {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  });
}

// A comm whose traffic is relayed to/from the kernel over the socket.
class LiveComm implements IClassicComm {
  comm_id: string;
  target_name: string;
  private sink: CommSink;
  private msgCb?: (msg: unknown) => void;
  private closeCb?: (msg: unknown) => void;

  constructor(commId: string, targetName: string, sink: CommSink) {
    this.comm_id = commId;
    this.target_name = targetName;
    this.sink = sink;
  }

  open(data: unknown, _cb?: unknown, metadata?: unknown, buffers?: Buf[]): string {
    this.sink.commOpen(
      this.comm_id,
      this.target_name,
      (data ?? {}) as Record<string, unknown>,
      (metadata ?? {}) as Record<string, unknown>,
      toB64(buffers),
    );
    return crypto.randomUUID();
  }

  send(data: unknown, _cb?: unknown, _metadata?: unknown, buffers?: Buf[]): string {
    this.sink.commMsg(this.comm_id, (data ?? {}) as Record<string, unknown>, toB64(buffers));
    return crypto.randomUUID();
  }

  close(data?: unknown): string {
    this.sink.commClose(this.comm_id, (data ?? {}) as Record<string, unknown>);
    return crypto.randomUUID();
  }

  on_msg(cb: (msg: unknown) => void): void {
    this.msgCb = cb;
  }
  on_close(cb: (msg: unknown) => void): void {
    this.closeCb = cb;
  }
  // Invoked by the manager when the kernel sends to this comm.
  deliverMsg(msg: unknown): void {
    this.msgCb?.(msg);
  }
  deliverClose(msg: unknown): void {
    this.closeCb?.(msg);
  }
}

export class KernelWidgetManager extends HTMLManager {
  private sink: CommSink;
  private comms = new Map<string, LiveComm>();

  constructor(sink: CommSink) {
    super();
    this.sink = sink;
  }

  // Resolve widget model/view classes from bundled ESM modules.
  protected loadClass(
    className: string,
    moduleName: string,
    moduleVersion: string,
  ): Promise<(typeof base.WidgetModel) | (typeof base.WidgetView)> {
    let mod: Record<string, unknown> | undefined;
    if (moduleName === "@jupyter-widgets/base") mod = base as never;
    else if (moduleName === "@jupyter-widgets/controls") mod = controls as never;
    if (!mod) {
      return Promise.reject(new Error(`Unknown widget module ${moduleName}`));
    }
    const cls = mod[className];
    if (!cls) {
      return Promise.reject(
        new Error(`Class ${className} not found in ${moduleName}@${moduleVersion}`),
      );
    }
    return Promise.resolve(cls as typeof base.WidgetModel);
  }

  // Frontend-initiated comms (rare — widgets are normally kernel-created).
  async _create_comm(
    targetName: string,
    commId?: string,
    data?: unknown,
    metadata?: unknown,
    buffers?: Buf[],
  ): Promise<IClassicComm> {
    const id = commId ?? crypto.randomUUID();
    const comm = new LiveComm(id, targetName, this.sink);
    this.comms.set(id, comm);
    if (data !== undefined) comm.open(data, undefined, metadata, buffers);
    return comm;
  }

  async _get_comm_info(): Promise<Record<string, unknown>> {
    return {};
  }

  // --- kernel -> frontend, routed here by the socket ------------------- //
  onCommOpen(ev: CommOpenEvent): void {
    if (ev.target_name !== WIDGET_TARGET) return; // ignore non-widget comms
    const comm = new LiveComm(ev.comm_id, ev.target_name, this.sink);
    this.comms.set(ev.comm_id, comm);
    const msg = {
      channel: "iopub",
      header: { msg_type: "comm_open" },
      parent_header: {},
      metadata: ev.metadata ?? {},
      content: { comm_id: ev.comm_id, target_name: ev.target_name, data: ev.data },
      buffers: fromB64(ev.buffers),
    };
    // handle_comm_open registers the model promise synchronously (before its
    // first await), so a display that references this model_id immediately
    // afterwards can await get_model().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.handle_comm_open(comm, msg as any).catch((e) =>
      console.error("widget comm_open failed", e),
    );
  }

  onCommMsg(ev: CommMsgEvent): void {
    const comm = this.comms.get(ev.comm_id);
    if (!comm) return;
    comm.deliverMsg({
      content: { comm_id: ev.comm_id, data: ev.data },
      metadata: {},
      buffers: fromB64(ev.buffers),
    });
  }

  onCommClose(ev: CommCloseEvent): void {
    const comm = this.comms.get(ev.comm_id);
    if (comm) comm.deliverClose({ content: { comm_id: ev.comm_id, data: ev.data } });
    this.comms.delete(ev.comm_id);
  }
}
