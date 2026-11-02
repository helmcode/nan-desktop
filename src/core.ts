// Round-2 IPC contract with the Rust core, in ONE typed module.
//
// Every command name, event name and payload shape introduced in round 2
// (inline approvals, per-grant approval modes, web preview, local file
// preview) lives here, so integrating with the core is a single-file change.
// The core stays the security model: the renderer only renders affordances
// and forwards the user's decision; the core decides and enforces.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Inline approvals (S14)
// ---------------------------------------------------------------------------

/// Event the core emits when an assistant action needs the user's decision.
export const APPROVAL_REQUEST_EVENT = "tools://approval-request";
/// Event the core emits when a pending action was resolved (by the user,
/// by an allow-mode grant, by a timeout or by a cancelled turn).
export const APPROVAL_RESOLVED_EVENT = "tools://approval-resolved";

/// What the assistant wants to do. Unknown kinds render generically.
export type ApprovalAction =
  | "read"
  | "list"
  | "write"
  | "create"
  | "move"
  | "rename"
  | "delete"
  | "run_command"
  | (string & {});

export interface ApprovalRequest {
  /// Pending-action id; echoed back in `tools_approval_respond`.
  id: string;
  conversation_id: number;
  action: ApprovalAction;
  /// Primary target (path or command line), already display-safe.
  target: string;
  /// Secondary target (destination of a move/rename), when any.
  destination?: string | null;
}

export interface ApprovalResolved {
  id: string;
  conversation_id: number;
  granted: boolean;
}

export function respondToApproval(id: string, granted: boolean): Promise<void> {
  return invoke("tools_approval_respond", { id, granted });
}

export function onApprovalRequest(handler: (req: ApprovalRequest) => void): Promise<UnlistenFn> {
  return listen<ApprovalRequest>(APPROVAL_REQUEST_EVENT, (event) => handler(event.payload));
}

export function onApprovalResolved(handler: (res: ApprovalResolved) => void): Promise<UnlistenFn> {
  return listen<ApprovalResolved>(APPROVAL_RESOLVED_EVENT, (event) => handler(event.payload));
}

// ---------------------------------------------------------------------------
// Per-grant approval mode (S13)
// ---------------------------------------------------------------------------

export type GrantMode = "ask" | "allow";

export const DEFAULT_GRANT_MODE: GrantMode = "ask";

export function normalizeGrantMode(value: unknown): GrantMode {
  return value === "allow" ? "allow" : "ask";
}

export async function getGrantMode(grantId: string): Promise<GrantMode> {
  return normalizeGrantMode(await invoke<unknown>("tools_grant_mode_get", { grantId }));
}

export function setGrantMode(grantId: string, mode: GrantMode): Promise<void> {
  return invoke("tools_grant_mode_set", { grantId, mode });
}

// ---------------------------------------------------------------------------
// Web preview through the platform fetch wrapper (S21)
// ---------------------------------------------------------------------------

export interface WebPreview {
  /// Final URL after redirects.
  url: string;
  title: string | null;
  content_type: string;
  /// Readable text (markdown or plain) extracted by the platform.
  text: string;
}

export function fetchWebPreview(profileId: string, url: string): Promise<WebPreview> {
  return invoke<WebPreview>("web_preview_fetch", { profileId, url });
}

// ---------------------------------------------------------------------------
// Local file preview (S21)
//
// The CSP forbids data:/blob: images and fetches to asset:, so the renderer
// never reads disk directly: the core reads a file inside an active grant
// and returns its bytes (base64). Images and PDFs are painted on a canvas.
// ---------------------------------------------------------------------------

export interface FilePreviewPayload {
  /// Base64 of the file bytes (the core caps the size).
  base64: string;
  size: number;
}

export async function readFileForPreview(profileId: string, path: string): Promise<Uint8Array> {
  const payload = await invoke<FilePreviewPayload>("preview_read_file", { profileId, path });
  return base64ToBytes(payload.base64);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
