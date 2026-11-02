// Round-2 IPC contract with the Rust core, in ONE typed module.
//
// Every command name, event name and payload shape introduced in round 2
// (inline approvals, per-grant approval modes, web preview, local file
// preview) lives here and mirrors the core exactly:
//   - event payloads are serde structs WITHOUT rename_all, so their fields
//     are snake_case (src-tauri/src/tools/approvals.rs, src/preview.rs);
//   - command arguments are Tauri's default camelCase (`approval_id` in
//     Rust is `approvalId` here), like every other command in the app.
// The core stays the security model: the renderer only renders affordances
// and forwards the user's decision; the core decides and enforces.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { GrantView } from "./types";

// ---------------------------------------------------------------------------
// Inline approvals (S14) - src-tauri/src/tools/approvals.rs
// ---------------------------------------------------------------------------

/// Event the core emits when an assistant action needs the user's decision.
export const APPROVAL_REQUEST_EVENT = "tools://approval-request";
/// Event the core emits when a pending request is closed (answered,
/// expired or abandoned by a stopped turn).
export const APPROVAL_RESOLVED_EVENT = "tools://approval-resolved";

/// Tool action kind (`ToolAction::kind()` in the core). Unknown kinds
/// render generically.
export type ApprovalAction =
  | "read_file"
  | "list_files"
  | "write_file"
  | "replace_file"
  | "move_path"
  | "delete_path"
  | "run_command"
  | (string & {});

/// `tools://approval-request` payload (`ApprovalRequest` in the core).
export interface ApprovalRequest {
  /// Pending request id; echoed back in `tools_approval_respond`.
  approval_id: string;
  conversation_id: number | null;
  action: ApprovalAction;
  /// Ready-made Spanish copy (the native dialog wording).
  title: string;
  text: string;
  summary: string;
  /// Target path (for run_command: the working folder).
  path: string | null;
  /// move_path destination.
  dest_path: string | null;
  /// run_command command line.
  command: string | null;
  /// Bounded change preview for writes.
  diff_preview: string | null;
  /// delete_path without a reachable trash: the deletion is permanent.
  permanent: boolean;
  expires_in_secs: number;
}

/// `tools://approval-resolved` payload (`ApprovalResolved` in the core).
export interface ApprovalResolved {
  approval_id: string;
  granted: boolean;
}

/// Event the core emits after a NATIVE per-action dialog (computer-wide)
/// was answered. Informational only (it carries no capability): the chat
/// counts it for the allow-mode suggestion.
export const APPROVAL_NATIVE_EVENT = "tools://approval-native";

/// `tools://approval-native` payload (`NativeDecision` in the core).
export interface NativeDecision {
  conversation_id: number | null;
  action: ApprovalAction;
  path: string | null;
  granted: boolean;
}

export function onNativeDecision(handler: (decision: NativeDecision) => void): Promise<UnlistenFn> {
  return listen<NativeDecision>(APPROVAL_NATIVE_EVENT, (event) => handler(event.payload));
}

/// `chat_send` arguments. `grantIds` is the conversation's folder
/// selection: the core validates its file actions against those grants
/// only (empty = no folder: the session temp folder is offered instead).
export type ChatSendArgs = {
  conversationId: number;
  model: string;
  content: string;
  grantIds: string[];
};

export function sendChat(args: ChatSendArgs): Promise<void> {
  return invoke("chat_send", { ...args });
}

export function respondToApproval(approvalId: string, granted: boolean): Promise<void> {
  return invoke("tools_approval_respond", { approvalId, granted });
}

export function onApprovalRequest(handler: (req: ApprovalRequest) => void): Promise<UnlistenFn> {
  return listen<ApprovalRequest>(APPROVAL_REQUEST_EVENT, (event) => handler(event.payload));
}

export function onApprovalResolved(handler: (res: ApprovalResolved) => void): Promise<UnlistenFn> {
  return listen<ApprovalResolved>(APPROVAL_RESOLVED_EVENT, (event) => handler(event.payload));
}

// ---------------------------------------------------------------------------
// Per-grant approval mode (S13) - src-tauri/src/tools/mod.rs
// ---------------------------------------------------------------------------

/// `ApprovalMode` (serde snake_case). `Grant.mode` is part of every grant
/// in `tools_grant_list`; computer-wide grants always ask.
export type GrantMode = "ask" | "allow";

export const DEFAULT_GRANT_MODE: GrantMode = "ask";

export function normalizeGrantMode(value: unknown): GrantMode {
  return value === "allow" ? "allow" : "ask";
}

/// The EFFECTIVE mode of one grant (computer-wide always reports ask).
export async function getGrantMode(grantId: string): Promise<GrantMode> {
  return normalizeGrantMode(await invoke<unknown>("tools_grant_mode_get", { grantId }));
}

/// Switch a grant's mode. `allow` shows a native confirmation in the core;
/// when the user declines it the grant comes back UNCHANGED, so callers
/// must trust the returned grant, not the requested mode.
export function setGrantMode(grantId: string, mode: GrantMode): Promise<GrantView> {
  return invoke<GrantView>("tools_grant_set_mode", { grantId, mode });
}

/// Open the native folder picker and grant the chosen folder with `mode`
/// (the core confirms `allow` natively). Null when the picker was cancelled.
export function addGrant(profileId: string, mode: GrantMode = DEFAULT_GRANT_MODE): Promise<GrantView | null> {
  return invoke<GrantView | null>("tools_grant_add", { profileId, mode });
}

// ---------------------------------------------------------------------------
// Web preview through the platform fetch wrapper (S21) - src/preview.rs
// ---------------------------------------------------------------------------

export interface WebPreview {
  /// Final URL after redirects.
  url: string;
  title: string | null;
  content_type: string;
  /// Readable text (markdown or plain), capped at 256 KiB by the core.
  text: string;
}

/// Typed failure kinds of `web_preview_fetch` (`Rejection.kind`). Every one
/// of them falls back to the open-in-browser card.
export type WebPreviewErrorKind =
  | "invalid_url"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "protocol";

export function fetchWebPreview(profileId: string, url: string): Promise<WebPreview> {
  return invoke<WebPreview>("web_preview_fetch", { profileId, url });
}

// ---------------------------------------------------------------------------
// Local file preview (S21) - src/preview.rs
//
// The CSP forbids data:/blob: images and fetches to asset:, so the renderer
// never reads disk directly: the core reads a file inside an active grant
// (8 MiB cap, deny-list and symlinks refused) and returns its bytes.
// ---------------------------------------------------------------------------

export interface FilePreviewPayload {
  /// Standard base64 of the file bytes.
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
