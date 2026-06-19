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

export interface InterruptRequest {
  type: "interrupt_request";
}

export interface RestartRequest {
  type: "restart_request";
}

export interface CompleteRequest {
  type: "complete_request";
  request_id: string;
  code: string;
  cursor_pos: number;
}

export interface InspectRequest {
  type: "inspect_request";
  request_id: string;
  code: string;
  cursor_pos: number;
  detail_level?: number;
}

export interface VariablesRequest {
  type: "variables_request";
  request_id: string;
}

export interface DeleteVariableRequest {
  type: "delete_variable_request";
  request_id: string;
  name: string;
}

export interface VariableChildrenRequest {
  type: "variable_children_request";
  request_id: string;
  name: string;
}

export interface SetVariableRequest {
  type: "set_variable_request";
  request_id: string;
  name: string;
  value: boolean | number | string;
}

export interface ColumnsRequest {
  type: "columns_request";
  request_id: string;
  name: string;
}

// ipywidgets comm messages, browser -> kernel. buffers are base64 strings.
export interface CommOpenRequest {
  type: "comm_open_request";
  comm_id: string;
  target_name: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  buffers: string[];
}

export interface CommMsgRequest {
  type: "comm_msg_request";
  comm_id: string;
  data: Record<string, unknown>;
  buffers: string[];
}

export interface CommCloseRequest {
  type: "comm_close_request";
  comm_id: string;
  data: Record<string, unknown>;
}

export type ClientRequest =
  | ExecuteRequest
  | InterruptRequest
  | RestartRequest
  | CompleteRequest
  | InspectRequest
  | VariablesRequest
  | DeleteVariableRequest
  | VariableChildrenRequest
  | SetVariableRequest
  | ColumnsRequest
  | CommOpenRequest
  | CommMsgRequest
  | CommCloseRequest;

// --------------------------------------------------------------------------
// server → client (discriminated union on `type`)
// --------------------------------------------------------------------------

export interface StatusEvent {
  type: "status";
  cell_id: string | null;
  execution_state: string; // "starting" | "busy" | "idle"
}

export interface ExecInputEvent {
  type: "exec_input";
  cell_id: string | null;
  execution_count: number | null;
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
  data: Record<string, unknown>; // MIME bundle
  metadata: Record<string, unknown>;
  execution_count: number | null;
}

export interface ErrorEvent {
  type: "error";
  cell_id: string | null;
  ename: string;
  evalue: string;
  traceback: string[];
}

export interface ClearOutputEvent {
  type: "clear_output";
  cell_id: string | null;
  wait: boolean;
}

export interface KernelStatusEvent {
  type: "kernel_status";
  state: string; // "ready" | "restarting" | "dead"
  kernel_name: string | null;
}

export interface CompleteReplyEvent {
  type: "complete_reply";
  request_id: string;
  matches: string[];
  cursor_start: number;
  cursor_end: number;
}

export interface InspectReplyEvent {
  type: "inspect_reply";
  request_id: string;
  found: boolean;
  data: Record<string, unknown>;
}

export interface VariableInfo {
  name: string;
  type: string;
  repr: string;
  size?: string;
}

export interface VariablesReplyEvent {
  type: "variables_reply";
  request_id: string;
  variables: VariableInfo[];
}

export interface VariableChild {
  key: string; // "" for set members; repr(key) for dict; index for list/tuple
  type: string;
  repr: string;
  size?: string;
}

export interface VariableChildrenReplyEvent {
  type: "variable_children_reply";
  request_id: string;
  name: string;
  children: VariableChild[];
}

export interface ColumnsReplyEvent {
  type: "columns_reply";
  request_id: string;
  name: string;
  columns: string[];
}

// ipywidgets comm messages, kernel -> browser. buffers are base64 strings.
export interface CommOpenEvent {
  type: "comm_open";
  comm_id: string;
  target_name: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  buffers: string[];
}

export interface CommMsgEvent {
  type: "comm_msg";
  comm_id: string;
  data: Record<string, unknown>;
  buffers: string[];
}

export interface CommCloseEvent {
  type: "comm_close";
  comm_id: string;
  data: Record<string, unknown>;
}

export type ClientEvent =
  | StatusEvent
  | ExecInputEvent
  | StreamEvent
  | DisplayEvent
  | ErrorEvent
  | ClearOutputEvent
  | KernelStatusEvent
  | CompleteReplyEvent
  | InspectReplyEvent
  | VariablesReplyEvent
  | VariableChildrenReplyEvent
  | ColumnsReplyEvent
  | CommOpenEvent
  | CommMsgEvent
  | CommCloseEvent;
