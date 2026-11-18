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
import type { AttachmentKind, GrantView } from "./types";

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
  /// The skill turned on for this conversation (T14). Only the id crosses
  /// the boundary: the core reads the skill from its own store and adds it
  /// to this reply's context. Omitted when no skill is on.
  skillId?: string;
  /// A "Continue" click on an unfinished turn. The content is a normal
  /// user message; the flag only reaches the core's turn summary.
  continuation?: boolean;
  /// Files attached in the composer: the staged id, plus the text the
  /// renderer extracted for a document. Omitted when there are none.
  attachments?: AttachmentInput[];
};

// ---------------------------------------------------------------------------
// Chat attachments - src-tauri/src/attachments.rs
//
// The core opens the native picker and reads dropped files from the
// window's own drop event, so the renderer never names a path; it only
// receives staged ids (plus a thumbnail path for images) and reads a
// staged DOCUMENT back once to extract its text locally.
// ---------------------------------------------------------------------------

/// A file staged for the next message (`StagedAttachment` in the core).
export interface StagedAttachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  size: number;
  /// The prepared image (asset protocol); null for documents.
  preview_path: string | null;
}

/// A file that could not be attached, with the core's reason
/// (`too_many`, `too_large`, `total_too_large`, `unsupported`,
/// `unreadable`, `not_allowed`, `protocol`).
export interface RejectedFile {
  name: string;
  reason: string;
}

export interface StageResult {
  staged: StagedAttachment[];
  rejected: RejectedFile[];
}

export interface AttachmentInput {
  id: string;
  text?: string;
}

/// Files dropped on the window, staged by the core.
export const ATTACHMENTS_DROPPED_EVENT = "attachments://dropped";

export function pickAttachments(): Promise<StageResult> {
  return invoke<StageResult>("attachments_pick");
}

export function stageAttachmentBytes(name: string, dataBase64: string): Promise<StagedAttachment> {
  return invoke<StagedAttachment>("attachments_stage_bytes", { name, dataBase64 });
}

export async function readAttachment(id: string): Promise<Uint8Array> {
  // Raw IPC response: an ArrayBuffer (a number array from older shims).
  const raw = await invoke<ArrayBuffer | ArrayBufferView | number[]>("attachment_read", { id });
  if (Array.isArray(raw)) return Uint8Array.from(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return new Uint8Array(raw);
}

export function discardAttachment(id: string): Promise<void> {
  return invoke("attachment_discard", { id });
}

export function onAttachmentsDropped(handler: (result: StageResult) => void): Promise<UnlistenFn> {
  return listen<StageResult>(ATTACHMENTS_DROPPED_EVENT, (event) => handler(event.payload));
}

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
/// in `tools_grant_list`, the whole-computer grant included (R22).
export type GrantMode = "ask" | "allow";

export const DEFAULT_GRANT_MODE: GrantMode = "ask";

export function normalizeGrantMode(value: unknown): GrantMode {
  return value === "allow" ? "allow" : "ask";
}

/// The stored mode of one grant.
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
  /// R20-D: set by the CORE only, when its gating marker says this is a
  /// website write_website wrote this session (src-tauri/src/site_preview.rs).
  selfContainedWebsite?: boolean;
  /// R22: set by the CORE only, for a user's own .html/.htm it registered
  /// in the ephemeral document class (same sandbox and no-network policy;
  /// released with releaseSitePreview when the preview closes).
  htmlDocument?: boolean;
  /// The sandboxed site URL, present with selfContainedWebsite or htmlDocument.
  siteUrl?: string;
}

export interface FileForPreview {
  bytes: Uint8Array;
  /// The sandboxed site URL when the core flagged the file as a
  /// self-contained website or a user HTML document; null otherwise.
  siteUrl: string | null;
  /// R22: true when siteUrl is an ephemeral user-document token the
  /// renderer must release on close (never for a tool website).
  releasable: boolean;
}

/// The only origins a sandboxed site may be loaded from (the core's custom
/// scheme; WebView2 serves it as http://nan-site.localhost). Anything else
/// in the reply is ignored, so the frame never loads an arbitrary URL.
const SITE_URL = /^(?:nan-site:\/\/localhost|http:\/\/nan-site\.localhost)\/[0-9a-f]{32}$/;

export function sandboxedSiteUrl(payload: FilePreviewPayload): string | null {
  const flagged = payload.selfContainedWebsite === true || payload.htmlDocument === true;
  if (!flagged || typeof payload.siteUrl !== "string") return null;
  return SITE_URL.test(payload.siteUrl) ? payload.siteUrl : null;
}

export async function readFileWithSiteForPreview(profileId: string, path: string): Promise<FileForPreview> {
  const payload = await invoke<FilePreviewPayload>("preview_read_file", { profileId, path });
  const siteUrl = sandboxedSiteUrl(payload);
  return {
    bytes: base64ToBytes(payload.base64),
    siteUrl,
    releasable: siteUrl !== null && payload.selfContainedWebsite !== true && payload.htmlDocument === true,
  };
}

/// R22: tell the core a user HTML document's preview closed, so it forgets
/// the bytes. Fire and forget: a failure only leaves the bytes to the
/// core's small ring, which evicts them anyway.
export function releaseSitePreview(siteUrl: string): void {
  const token = siteUrl.slice(siteUrl.lastIndexOf("/") + 1);
  void Promise.resolve()
    .then(() => invoke("preview_release_site", { token }))
    .catch(() => {});
}

/// The typed rejection kind a core command failed with, when it has one.
export function rejectionKind(err: unknown): string | null {
  if (typeof err === "object" && err !== null && typeof (err as { kind?: unknown }).kind === "string") {
    return (err as { kind: string }).kind;
  }
  return null;
}

export async function readFileForPreview(profileId: string, path: string): Promise<Uint8Array> {
  return (await readFileWithSiteForPreview(profileId, path)).bytes;
}

// ---------------------------------------------------------------------------
// "Save as…" on a generated image (round 6) - src-tauri/src/images.rs
//
// The user's own action: the core opens the NATIVE save dialog and copies
// the image there, so the destination never comes from the renderer. The
// renderer only names which generated image (under app_data/images) to save.
// Resolves to the saved path, or null when the user cancelled the dialog.
// ---------------------------------------------------------------------------

export function saveImageAs(sourcePath: string): Promise<string | null> {
  return invoke<string | null>("image_save_as", { sourcePath });
}

// ---------------------------------------------------------------------------
// Auto-update (round 7) - src-tauri/src/updater.rs
// ---------------------------------------------------------------------------

/// A newer signed release the core found (and keeps ready to install).
export interface UpdateInfo {
  version: string;
  current_version: string;
}

/// Asks the release feed for a newer version. Never downloads anything.
export function checkForUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("update_check");
}

/// Downloads, verifies (minisign) and installs the update found by the last
/// check, then relaunches the app. Only ever called from the user's click.
export function installUpdate(): Promise<void> {
  return invoke<void>("update_install");
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Crash telemetry - src-tauri/src/telemetry.rs
// ---------------------------------------------------------------------------

/// The only shape of an error the renderer may report: its NAME, from a
/// fixed list (standard error classes + the `typeof` of a non-Error
/// rejection). Mirrors `RENDERER_ERROR_NAMES` in the core, which validates
/// again and owns everything else (no message, no stack).
const ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "DOMException",
  "string",
  "number",
  "bigint",
  "boolean",
  "symbol",
  "undefined",
  "object",
  "function",
]);

export function crashName(raw: unknown): string {
  return typeof raw === "string" && ERROR_NAMES.has(raw) ? raw : "Error";
}

/// Report a renderer crash by error name only. Fire-and-forget: it never
/// throws and never rejects (a failing report must not become a second
/// unhandled rejection).
export function reportRendererCrash(name: unknown): void {
  try {
    void invoke("telemetry_renderer_crash", { name: crashName(name) }).catch(() => undefined);
  } catch {
    // No IPC (tests, a torn-down window): nothing to do.
  }
}
