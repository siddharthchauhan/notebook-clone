// Hand-mirrored TypeScript types for the server wire protocol.
// Source of truth: server/app/models.py — keep these in sync by hand.

// --------------------------------------------------------------------------
// client → server
// --------------------------------------------------------------------------

export interface ExecuteRequest {
  type: "execute_request";
  cell_id: string;
  code: string;
}

export type ClientRequest = ExecuteRequest;

// --------------------------------------------------------------------------
// server → client (discriminated union on `type`)
// --------------------------------------------------------------------------

export interface StatusEvent {
  type: "status";
  cell_id: string | null;
  execution_state: string; // "starting" | "busy" | "idle"
}

export interface StreamEvent {
  type: "stream";
  cell_id: string | null;
  name: string; // "stdout" | "stderr"
  text: string;
}

export interface DisplayEvent {
  type: "display";
  cell_id: string | null;
  data: Record<string, unknown>; // MIME bundle, e.g. { "image/png": "<base64>" }
  metadata: Record<string, unknown>;
}

export interface ErrorEvent {
  type: "error";
  cell_id: string | null;
  ename: string;
  evalue: string;
  traceback: string[];
}

export type ClientEvent = StatusEvent | StreamEvent | DisplayEvent | ErrorEvent;
