import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import "./App.css";

// The renderer never sees profile URLs, API keys or session tokens (S4/S12):
// profiles arrive as {id, name, has_key, key_mask} from the Rust core, and
// all HTTP — device flow, chat streaming, model listing — happens in Rust.
// Chat arrives as delta/done/error events only (T4).

interface ProfileView {
  id: string;
  name: string;
  has_key: boolean;
  key_mask: string | null;
}

interface ProfileOverview {
  profiles: ProfileView[];
  active_profile: string | null;
}

// Device-flow payloads (Rust core → renderer). Only non-secret fields cross
// the IPC boundary: the user_code, the status, the key alias (S4).
interface DeviceStarted {
  user_code: string;
}
interface DeviceStatus {
  status: string;
}
interface DeviceApproved {
  key_alias: string;
  profile_id: string;
}
interface DeviceError {
  kind: string;
}

// Chat payloads (T4): the renderer receives only delta text, conversation
// metadata and classified error kinds — never the key, never URLs.
interface ChatDelta {
  conversation_id: number;
  delta: string;
}
interface ChatDone {
  conversation_id: number;
}
interface ChatError {
  conversation_id: number;
  kind: string;
}
// T4b: a deliberate stop — same payload shape as done. Whatever text
// arrived stays persisted as a complete message.
interface ChatStopped {
  conversation_id: number;
}
// TTS payloads (T6): only the classified error kind crosses the IPC
// boundary — never the audio bytes, the key or any URL.
interface TtsError {
  kind: string;
}
// Image payloads (T5): status events plus the saved file's path only — the
// image bytes never cross the IPC boundary; the renderer loads the file
// through the Tauri asset protocol (scope: app data images dir).
interface ImagesStarted {
  conversation_id: number;
}
interface ImagesDone {
  conversation_id: number;
  media_path: string;
}
interface ImagesError {
  conversation_id: number;
  kind: string;
}
interface ImagesStopped {
  conversation_id: number;
}
interface ConversationView {
  id: number;
  title: string;
  updated_at: string;
  last_message: string | null;
}
interface ChatMessageRow {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  model: string | null;
  created_at: string;
  // T4b: crash leftovers of a mid-stream kill — the reply never finished.
  partial: boolean;
  // T5: absolute path of the generated image (assistant image rows only).
  media_path: string | null;
}

// One-line description per locked profile (S2: exactly two, no URLs).
const PROFILE_DESCRIPTIONS: Record<string, string> = {
  nan: "Inference for the NaN builders community.",
  helmcode: "Self-service inference for your team.",
};

const ERROR_KIND_LABELS: Record<string, string> = {
  network: "Could not reach the sign-in service. Check your connection and try again.",
  timeout: "The sign-in service took too long to answer. Try again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  server: "The sign-in service reported an error. Try again.",
  protocol: "Something went wrong on this device. Try again.",
};

// Chat error kinds (src-tauri/src/chat.rs ErrorKind) → inline user copy.
const CHAT_ERROR_LABELS: Record<string, string> = {
  missing_key: "No inference key is stored for this profile — sign in again.",
  unauthorized: "Session expired — sign in again.",
  rate_limited: "Rate limited by the inference service. Wait a moment and try again.",
  server: "The inference service reported an error. Try again.",
  network: "Could not reach the inference service. Check your connection and try again.",
  protocol: "Something went wrong on this device. Try again.",
  decode: "The audio reply could not be decoded. Try again.",
};

// Image error kinds (src-tauri/src/images.rs) → inline user copy. On this
// surface 429 means the tenant's monthly image quota is exhausted (the
// shared 100-images/month pool), so it gets a dedicated quota message.
const IMAGE_ERROR_LABELS: Record<string, string> = {
  ...CHAT_ERROR_LABELS,
  rate_limited: "Monthly image quota reached. Your allowance resets next month.",
  decode: "The image reply could not be decoded. Try again.",
};

function imageErrorLabel(kind: string): string {
  return IMAGE_ERROR_LABELS[kind] ?? "Something went wrong. Try again.";
}

// Must match src-tauri/src/chat.rs DEFAULT_MODEL (the renderer cannot import
// Rust constants; the Rust side falls back to the same value).
const DEFAULT_MODEL = "deepseek-v4-flash";

// Must match src-tauri/src/tts.rs VOICES (the Rust side rejects any other
// voice with a `protocol`-style command error before any request is made).
const VOICES: Array<{ id: string; label: string }> = [
  { id: "ef_dora", label: "Dora · ES" },
  { id: "em_alex", label: "Alex · ES" },
  { id: "af_heart", label: "Heart · EN" },
];
const DEFAULT_VOICE = VOICES[0].id;
const VOICE_STORAGE_KEY = "nan-desktop-tts-voice";

// Must match src-tauri/src/stt.rs MAX_AUDIO_BYTES (the Rust side rejects
// larger uploads locally before anything is sent).
const MAX_STT_BYTES = 25 * 1024 * 1024;

// The recorder MIME types we accept, in preference order (webm/opus where
// supported — Chrome/WebKit; mp4/AAC fallback — Safari).
const RECORDING_MIME_CANDIDATES = ["audio/webm", "audio/mp4"];

const TTS_ERROR_KINDS = new Set([
  "missing_key",
  "unauthorized",
  "rate_limited",
  "server",
  "network",
  "protocol",
  "decode",
]);

// Must match src-tauri/src/images.rs bounds (512..1280, multiples of 16; the
// Rust side rejects anything else with a `protocol` command error before any
// request is made). 1024x1024 is the 1k-tier default.
const IMAGE_SIZES = [
  "1024x1024",
  "512x512",
  "768x512",
  "512x768",
  "1280x768",
  "768x1280",
  "1152x896",
];
const DEFAULT_IMAGE_SIZE = "1024x1024";

// Command errors arrive either as a classified ErrorKind string (stt/tts)
// or as a free-form message; render known kinds with the shared copy.
function commandErrorLabel(err: unknown): string {
  const text = String(err);
  return TTS_ERROR_KINDS.has(text) ? chatErrorLabel(text) : text;
}

type Screen = "loading" | "error" | "picker" | "authorizing" | "chat";
type AuthPhase = "waiting" | "denied" | "expired" | "error";

interface SseChunkPayload {
  seq: number;
  text: string;
}

interface SpikeMessage {
  id: number;
  content: string;
  created_at: string;
  role: string;
}

// Security posture: a key value is never rendered. This helper only ever
// masks the demo value typed into the T1 spike panel, last-4 only.
function maskValue(value: string): string {
  return `••••${value.slice(-4)}`;
}

function errorLabel(kind: string): string {
  return ERROR_KIND_LABELS[kind] ?? "Something went wrong. Try again.";
}

function chatErrorLabel(kind: string): string {
  return CHAT_ERROR_LABELS[kind] ?? "Something went wrong. Try again.";
}

// ---------------------------------------------------------------------------
// Markdown rendering (S3): GFM + highlight + sanitize. NEVER raw HTML.
//
// Highlighter choice: rehype-highlight (highlight.js) keeps the react-markdown
// pipeline synchronous — shiki's async highlighting would stall or complicate
// the render of streaming deltas, and its grammar bundle dwarfs highlight.js.
// rehype-sanitize runs AFTER highlighting so its output is the last pass; the
// schema below whitelists the highlight classes it must keep.
// ---------------------------------------------------------------------------

// Minimal hast shape used to read language/raw text out of a code block node.
interface HastNode {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

// GitHub-style default schema, extended to keep the highlighter's classes
// (span.hljs-* and code.language-*/hljs) — everything else, including raw
// HTML, is stripped. See the rehype-highlight README recipe.
const sanitizeSchema = {
  ...defaultSchema,
  // Security review R1 (defense in depth with the app CSP): markdown from the
  // model may not load remote images — an <img> to an attacker host would be a
  // conversation-content exfiltration channel. Images are dropped entirely for
  // the MVP; the model still communicates through text.
  tagNames: (defaultSchema.tagNames ?? []).filter(
    (t) => t !== "img" && t !== "picture" && t !== "source",
  ),
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-./, /^hljs$/],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", /^hljs-./],
    ],
  },
};

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeEl = node?.children?.find((child) => child.tagName === "code");
  const classes = Array.isArray(codeEl?.properties?.className)
    ? (codeEl?.properties?.className as unknown[]).filter(
        (cls): cls is string => typeof cls === "string",
      )
    : [];
  const language = classes.find((cls) => cls.startsWith("language-"))?.slice("language-".length);
  const raw = hastText(codeEl);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (rare in the Tauri secure context): keep silent.
    }
  };

  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="codeblock-lang">{language ?? "text"}</span>
        <button type="button" className="codeblock-copy" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema]]}
        components={{ pre: CodeBlock }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Authorizing({
  profileName,
  userCode,
  phase,
  errorKind,
  pollCount,
  onTryAgain,
  onPickAnother,
  onCancel,
}: {
  profileName: string;
  userCode: string;
  phase: AuthPhase;
  errorKind: string;
  pollCount: number;
  onTryAgain: () => void;
  onPickAnother: () => void;
  onCancel: () => void;
}) {
  const waiting = phase === "waiting";
  const headline =
    phase === "denied"
      ? "Sign-in denied"
      : phase === "expired"
        ? "Sign-in request expired"
        : phase === "error"
          ? "Sign-in failed"
          : `Authorizing ${profileName}`;

  return (
    <main className="screen">
      <p className="brand">{"// nan-desktop"}</p>
      <h1>{headline}</h1>
      {waiting ? (
        <>
          <p className="lede">Approve this device in your browser to sign in.</p>
          <div className="user-code" aria-label="device code">
            {userCode || "····-····"}
          </div>
          <p className="status-line">
            <span className="pulse-dot" />
            A browser window has opened — approve the device there.
          </p>
          <p className="status-line muted">
            <span className="dot" />
            Waiting for approval — checking every few seconds ({pollCount} check
            {pollCount === 1 ? "" : "s"}).
          </p>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="lede">
            {phase === "denied" &&
              "The request was denied in the browser. Nothing was stored on this device."}
            {phase === "expired" &&
              "The sign-in request expired. Start again to get a new code."}
            {phase === "error" && errorLabel(errorKind)}
          </p>
          <div className="user-code dimmed" aria-hidden="true">
            {userCode || "····-····"}
          </div>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={onTryAgain}>
              Try again
            </button>
            <button type="button" className="btn btn-ghost" onClick={onPickAnother}>
              Use a different profile
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function ProfilePicker({
  overview,
  busy,
  error,
  onPick,
}: {
  overview: ProfileOverview;
  busy: boolean;
  error: string;
  onPick: (id: string) => void;
}) {
  return (
    <main className="screen">
      <p className="brand">{"// nan-desktop"}</p>
      <h1>Sign in</h1>
      <p className="lede">
        Choose your workspace. Sign-in happens in your browser — no keys to paste.
      </p>
      <div className="cards">
        {overview.profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            className="card"
            onClick={() => onPick(p.id)}
            disabled={busy}
          >
            <strong>{p.name}</strong>
            <span>{PROFILE_DESCRIPTIONS[p.id] ?? ""}</span>
            {p.has_key && (
              <span className="card-meta">
                signed in before — key stored {p.key_mask}
              </span>
            )}
          </button>
        ))}
      </div>
      {error && <p className="status err">{error}</p>}
    </main>
  );
}

// ---------------------------------------------------------------------------
// T8 tools (S7): the Rust core is the security boundary. The renderer can
// only ask for a proposal, see its summary/diff, and approve/deny — the
// exact approved action is stored and executed inside the Rust core.
// ---------------------------------------------------------------------------

interface GrantView {
  id: string;
  canonical_path: string;
  granted_at: string;
  profile_id: string;
}

interface ToolsSettingsView {
  tools_allow_run_command: boolean;
}

interface ProposalView {
  proposal_id: string;
  action_kind: string;
  path: string | null;
  summary: string;
  diff: string | null;
}

interface ToolOutcome {
  action: string;
  summary: string;
  content: string | null;
  entries: string[] | null;
  bytes_written: number | null;
  stdout: string | null;
  stderr: string | null;
  exit_code: number | null;
  timed_out: boolean;
}

interface AuditEntry {
  ts: string;
  event: string;
  action: string;
  outcome: string;
  grant_id: string | null;
  profile_id: string | null;
  detail: string | null;
}

/// Tools rejections arrive as structured {kind, message} IPC errors.
function toolsErrorLabel(err: unknown): string {
  if (typeof err === "object" && err !== null && "kind" in err && "message" in err) {
    const rejection = err as { kind: string; message: string };
    return `${rejection.kind}: ${rejection.message}`;
  }
  return String(err);
}

const TOOLS_PROPOSAL_EXAMPLE = '{"type":"read_file","path":"/absolute/path/inside/a/grant"}';
const TOOLS_PREVIEW_CHARS = 2000;

function previewText(text: string): string {
  return text.length > TOOLS_PREVIEW_CHARS
    ? `${text.slice(0, TOOLS_PREVIEW_CHARS)}\n… (preview truncated)`
    : text;
}

/// Sidebar panel: folder grants, the experimental run_command switch and
/// the audit log viewer (last 50 entries).
function ToolsPanel({ profileId }: { profileId: string | null }) {
  const [grants, setGrants] = useState<GrantView[]>([]);
  const [runCommandEnabled, setRunCommandEnabled] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [grantList, settings, auditTail] = await Promise.all([
        invoke<GrantView[]>("tools_grant_list"),
        invoke<ToolsSettingsView>("tools_settings_get"),
        invoke<AuditEntry[]>("tools_audit_tail", { count: 50 }),
      ]);
      setGrants(grantList);
      setRunCommandEnabled(settings.tools_allow_run_command);
      setAudit(auditTail);
      setStatus(null);
    } catch (err) {
      setStatus({ ok: false, text: toolsErrorLabel(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addFolder = async (path: string) => {
    if (!profileId || !path) return;
    setBusy(true);
    try {
      await invoke("tools_grant_add", { profileId, path });
      setManualPath("");
      await refresh();
      setStatus({ ok: true, text: `Granted ${path}` });
    } catch (err) {
      setStatus({ ok: false, text: toolsErrorLabel(err) });
    } finally {
      setBusy(false);
    }
  };

  const pickFolder = async () => {
    const picked = await openFileDialog({ directory: true, multiple: false });
    if (typeof picked === "string") {
      await addFolder(picked);
    }
  };

  const revoke = async (grantId: string) => {
    setBusy(true);
    try {
      await invoke("tools_grant_revoke", { grantId });
      await refresh();
    } catch (err) {
      setStatus({ ok: false, text: toolsErrorLabel(err) });
    } finally {
      setBusy(false);
    }
  };

  const toggleRunCommand = async (enabled: boolean) => {
    setBusy(true);
    try {
      await invoke("tools_set_run_command_enabled", { enabled });
      setRunCommandEnabled(enabled);
      await refresh();
    } catch (err) {
      setStatus({ ok: false, text: toolsErrorLabel(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Tools</h2>
      <p className="hint">
        Folders the assistant may read/write after you approve each action.
      </p>
      <ul className="tools-grant-list">
        {grants.map((grant) => (
          <li key={grant.id}>
            <code>{grant.canonical_path}</code>
            <span className="key-note">{grant.profile_id}</span>
            <button
              type="button"
              className="btn btn-ghost tools-grant-revoke"
              onClick={() => void revoke(grant.id)}
              disabled={busy}
            >
              revoke
            </button>
          </li>
        ))}
        {grants.length === 0 && <li className="hint">No folders granted yet.</li>}
      </ul>
      <div className="row-h">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void pickFolder()}
          disabled={busy || !profileId}
        >
          Choose folder…
        </button>
        <input
          value={manualPath}
          onChange={(e) => setManualPath(e.currentTarget.value)}
          placeholder="/absolute/path"
          aria-label="Grant an absolute folder path"
        />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void addFolder(manualPath.trim())}
          disabled={busy || !profileId || manualPath.trim().length === 0}
        >
          Add
        </button>
      </div>
      <label className="tools-runcommand-row">
        <input
          type="checkbox"
          checked={runCommandEnabled}
          onChange={(e) => void toggleRunCommand(e.currentTarget.checked)}
          disabled={busy}
        />
        <span>Enable run_command (experimental)</span>
      </label>
      <p className="tools-warning">
        ⚠ run_command lets the assistant execute shell commands inside granted
        folders after per-action approval. Keep it OFF unless you need it.
      </p>
      <details className="tools-audit">
        <summary>Audit log (last 50)</summary>
        <ul className="tools-audit-list">
          {audit.map((entry, index) => (
            <li key={index}>
              <code>{entry.ts}</code> {entry.event}/{entry.action} → {entry.outcome}
              {entry.detail ? ` — ${entry.detail}` : ""}
            </li>
          ))}
          {audit.length === 0 && <li className="hint">Empty.</li>}
        </ul>
      </details>
      <div className="row-h">
        <button type="button" className="btn btn-ghost" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </div>
      {status && <p className={`status ${status.ok ? "ok" : "err"}`}>{status.text}</p>}
    </div>
  );
}

/// Composer-adjacent test surface for the propose → approve/deny → execute
/// flow. Model tool-calling integration is a later task; this panel drives
/// the exact same Rust-core path that integration will use.
function ProposalDemo({
  profileId,
  conversationId,
}: {
  profileId: string | null;
  conversationId: number | null;
}) {
  const [actionJson, setActionJson] = useState("");
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [outcome, setOutcome] = useState<ToolOutcome | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const propose = async () => {
    if (!profileId) return;
    setBusy(true);
    setProposal(null);
    setOutcome(null);
    try {
      const view = await invoke<ProposalView>("tools_propose", {
        profileId,
        conversationId,
        actionJson,
      });
      setProposal(view);
      setStatus({ ok: true, text: "Proposal stored — review and approve or deny." });
    } catch (err) {
      setStatus({ ok: false, text: toolsErrorLabel(err) });
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      const result = await invoke<ToolOutcome>("tools_execute", {
        proposalId: proposal.proposal_id,
      });
      setOutcome(result);
      setProposal(null);
      setStatus({ ok: true, text: "Executed." });
    } catch (err) {
      setStatus({ ok: false, text: toolsErrorLabel(err) });
    } finally {
      setBusy(false);
    }
  };

  const deny = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      await invoke("tools_deny", { proposalId: proposal.proposal_id });
      setProposal(null);
      setStatus({ ok: true, text: "Denied — nothing was executed." });
    } catch (err) {
      setStatus({ ok: false, text: toolsErrorLabel(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="tools-demo">
      <summary>Tools demo — test surface (model integration comes later)</summary>
      <div className="panel">
        <p className="hint">
          Paste an action JSON. The Rust core validates it against your
          grants and stores a proposal; execution happens only after you
          approve, and runs the exact stored action.
        </p>
        <textarea
          className="tools-json"
          value={actionJson}
          onChange={(e) => setActionJson(e.currentTarget.value)}
          placeholder={TOOLS_PROPOSAL_EXAMPLE}
          rows={4}
          spellCheck={false}
        />
        <div className="row-h">
          <button type="button" className="btn btn-ghost" onClick={() => void propose()} disabled={busy || !profileId}>
            Propose
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setActionJson(TOOLS_PROPOSAL_EXAMPLE)}
            disabled={busy}
          >
            Example
          </button>
        </div>
        {proposal && (
          <div className="tools-proposal">
            <p>
              <strong>{proposal.action_kind}</strong> <code>{proposal.path}</code>
            </p>
            <p className="hint">{proposal.summary}</p>
            {proposal.diff && <pre className="tools-diff">{previewText(proposal.diff)}</pre>}
            <div className="row-h">
              <button type="button" className="btn btn-primary" onClick={() => void approve()} disabled={busy}>
                Approve
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void deny()} disabled={busy}>
                Deny
              </button>
            </div>
          </div>
        )}
        {outcome && (
          <div className="tools-outcome">
            <p className="hint">{outcome.summary}</p>
            {outcome.content != null && <pre className="tools-diff">{previewText(outcome.content)}</pre>}
            {outcome.entries && (
              <ul className="tools-entries">
                {outcome.entries.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            )}
            {outcome.stdout != null && (
              <pre className="tools-diff">
                {previewText(
                  `exit ${outcome.exit_code ?? "signal"}${outcome.timed_out ? " (killed after timeout)" : ""}\n${outcome.stdout}`,
                )}
              </pre>
            )}
            {outcome.stderr && <pre className="tools-diff tools-stderr">{previewText(outcome.stderr)}</pre>}
          </div>
        )}
        {status && <p className={`status ${status.ok ? "ok" : "err"}`}>{status.text}</p>}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Chat shell (T4, S3)
// ---------------------------------------------------------------------------

function ChatShell({
  overview,
  busy,
  onSignOut,
  spike,
}: {
  overview: ProfileOverview;
  busy: boolean;
  onSignOut: () => void;
  spike: ReactNode;
}) {
  const activeProfile = overview.profiles.find((p) => p.id === overview.active_profile);

  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [drafts, setDrafts] = useState<Map<number, string>>(() => new Map());
  const [streamingIds, setStreamingIds] = useState<Set<number>>(() => new Set());
  const [composer, setComposer] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [inlineError, setInlineError] = useState<string>("");

  // Image mode (T5): the composer switches into image generation — the
  // prompt is sent to `image_generate` and the reply renders inline.
  const [imageMode, setImageMode] = useState(false);
  const [imageSize, setImageSize] = useState(DEFAULT_IMAGE_SIZE);
  const [imageGeneratingIds, setImageGeneratingIds] = useState<Set<number>>(
    () => new Set(),
  );

  // Voice (T6): TTS playback + dictation. The chosen voice persists across
  // sessions; only the three app-locked kokoro voices are offered.
  const [voice, setVoice] = useState<string>(() => {
    const stored = window.localStorage.getItem(VOICE_STORAGE_KEY);
    return VOICES.some((v) => v.id === stored) ? (stored as string) : DEFAULT_VOICE;
  });
  const [speakingMsgId, setSpeakingMsgId] = useState<number | null>(null);
  const [ttsHint, setTtsHint] = useState("");
  const [recording, setRecording] = useState(false);
  const [sttBusy, setSttBusy] = useState(false);
  const [sttHint, setSttHint] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);

  const activeProfileRef = useRef<string | null>(overview.active_profile);
  useEffect(() => {
    activeProfileRef.current = overview.active_profile;
  }, [overview.active_profile]);
  const activeConvRef = useRef<number | null>(activeConvId);
  useEffect(() => {
    activeConvRef.current = activeConvId;
  }, [activeConvId]);

  const messagesRef = useRef<HTMLDivElement | null>(null);

  const refreshConversations = useCallback(async (): Promise<void> => {
    const profileId = activeProfileRef.current;
    if (!profileId) return;
    try {
      const list = await invoke<ConversationView[]>("conversation_list", { profileId });
      setConversations(list);
    } catch {
      // The sidebar stays as-is on a transient failure.
    }
  }, []);

  const refreshModels = useCallback(async (): Promise<void> => {
    try {
      const list = await invoke<string[]>("models_list");
      setModels(list);
      setModel((current) => (list.includes(current) ? current : (list[0] ?? DEFAULT_MODEL)));
    } catch {
      // models_list failed (missing key / offline): the picker keeps the
      // default model; the send path surfaces the real error.
    }
  }, []);

  const loadMessages = useCallback(async (conversationId: number): Promise<void> => {
    try {
      const rows = await invoke<ChatMessageRow[]>("messages_list", { conversationId });
      setMessages(rows);
    } catch {
      setMessages([]);
    }
  }, []);

  // Boot the chat: conversations + models, most recent conversation open.
  useEffect(() => {
    void refreshConversations().then(async () => {
      // Re-read via the same source so the id can drive the first selection.
      const profileId = activeProfileRef.current;
      if (!profileId) return;
      try {
        const list = await invoke<ConversationView[]>("conversation_list", { profileId });
        if (list.length > 0) {
          setActiveConvId(list[0].id);
          void loadMessages(list[0].id);
        }
      } catch {
        // handled by refreshConversations' own failure path
      }
    });
    void refreshModels();
  }, [refreshConversations, refreshModels, loadMessages]);

  // Chat event transport (T4). Registered once; refs carry the active ids.
  useEffect(() => {
    const markStreaming = (conversationId: number, streaming: boolean): void => {
      setStreamingIds((prev) => {
        const next = new Set(prev);
        if (streaming) next.add(conversationId);
        else next.delete(conversationId);
        return next;
      });
    };
    const clearDraft = (conversationId: number): void => {
      setDrafts((prev) => {
        const next = new Map(prev);
        next.delete(conversationId);
        return next;
      });
    };
    const unlistens: Promise<UnlistenFn>[] = [
      listen<ChatDelta>("chat://delta", (event) => {
        const { conversation_id, delta } = event.payload;
        setDrafts((prev) => {
          const next = new Map(prev);
          next.set(conversation_id, (next.get(conversation_id) ?? "") + delta);
          return next;
        });
      }),
      listen<ChatDone>("chat://done", (event) => {
        const conversationId = event.payload.conversation_id;
        markStreaming(conversationId, false);
        clearDraft(conversationId);
        if (activeConvRef.current === conversationId) {
          void loadMessages(conversationId);
        }
        void refreshConversations();
      }),
      // T4b: the user pressed Stop. The text that arrived stays persisted;
      // reload to render it as a normal (complete) message.
      listen<ChatStopped>("chat://stopped", (event) => {
        const conversationId = event.payload.conversation_id;
        markStreaming(conversationId, false);
        clearDraft(conversationId);
        if (activeConvRef.current === conversationId) {
          void loadMessages(conversationId);
        }
        void refreshConversations();
      }),
      listen<ChatError>("chat://error", (event) => {
        const { conversation_id, kind } = event.payload;
        markStreaming(conversation_id, false);
        clearDraft(conversation_id);
        if (kind === "unauthorized") {
          setSessionExpired(true);
        } else if (activeConvRef.current === conversation_id) {
          setInlineError(chatErrorLabel(kind));
        }
        void refreshConversations();
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        promise.then((unlisten) => unlisten());
      });
    };
  }, [loadMessages, refreshConversations]);

  // Image event transport (T5): the Rust core persists the message row
  // before `done` fires, so reloading the transcript renders the image.
  useEffect(() => {
    const markGenerating = (conversationId: number, generating: boolean): void => {
      setImageGeneratingIds((prev) => {
        const next = new Set(prev);
        if (generating) next.add(conversationId);
        else next.delete(conversationId);
        return next;
      });
    };
    const unlistens: Promise<UnlistenFn>[] = [
      listen<ImagesStarted>("images://started", (event) => {
        markGenerating(event.payload.conversation_id, true);
      }),
      listen<ImagesDone>("images://done", (event) => {
        const conversationId = event.payload.conversation_id;
        markGenerating(conversationId, false);
        if (activeConvRef.current === conversationId) {
          void loadMessages(conversationId);
        }
        void refreshConversations();
      }),
      listen<ImagesError>("images://error", (event) => {
        const { conversation_id, kind } = event.payload;
        markGenerating(conversation_id, false);
        if (kind === "unauthorized") {
          setSessionExpired(true);
        } else if (activeConvRef.current === conversation_id) {
          setInlineError(imageErrorLabel(kind));
        }
        void refreshConversations();
      }),
      listen<ImagesStopped>("images://stopped", (event) => {
        markGenerating(event.payload.conversation_id, false);
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        promise.then((unlisten) => unlisten());
      });
    };
  }, [loadMessages, refreshConversations]);

  const selectConversation = useCallback(
    (conversationId: number): void => {
      setActiveConvId(conversationId);
      setInlineError("");
      setSessionExpired(false);
      void loadMessages(conversationId);
    },
    [loadMessages],
  );

  // Voice event transport (T6): one global playback — any end or error
  // clears the playing marker; errors surface as an inline hint.
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [
      listen("tts://ended", () => setSpeakingMsgId(null)),
      listen<TtsError>("tts://error", (event) => {
        setSpeakingMsgId(null);
        setTtsHint(chatErrorLabel(event.payload.kind));
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        promise.then((unlisten) => unlisten());
      });
    };
  }, []);

  // Persist the chosen voice across sessions (localStorage, UI-only data).
  useEffect(() => {
    window.localStorage.setItem(VOICE_STORAGE_KEY, voice);
  }, [voice]);

  // Stop any playback and recording when the chat shell unmounts.
  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
      recorderRef.current = null;
      void invoke("tts_stop").catch(() => {});
    };
  }, []);

  const toggleSpeak = useCallback(
    async (message: ChatMessageRow): Promise<void> => {
      setTtsHint("");
      if (speakingMsgId === message.id) {
        try {
          await invoke("tts_stop");
        } catch (err) {
          setSpeakingMsgId(null);
          setTtsHint(commandErrorLabel(err));
        }
        return;
      }
      const profileId = activeProfileRef.current;
      if (!profileId) return;
      // Optimistic: the Rust core keeps exactly one global playback — a new
      // speak silently replaces the previous one (no ended event for it).
      setSpeakingMsgId(message.id);
      try {
        await invoke("tts_speak", { profileId, voice, input: message.content });
      } catch (err) {
        setSpeakingMsgId(null);
        setTtsHint(commandErrorLabel(err));
      }
    },
    [speakingMsgId, voice],
  );

  const stopRecording = useCallback((): void => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }, []);

  const finishRecording = useCallback(
    async (chunks: Blob[], mimeType: string): Promise<void> => {
      const profileId = activeProfileRef.current;
      if (!profileId) return;
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      if (blob.size === 0) {
        setSttHint("The recording was empty — try again.");
        return;
      }
      if (blob.size > MAX_STT_BYTES) {
        setSttHint("The recording is too long (over 25 MB) — record a shorter clip.");
        return;
      }
      setSttBusy(true);
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const { text } = await invoke<{ text: string }>("stt_transcribe", {
          profileId,
          audioBytes: bytes,
          mime: blob.type,
        });
        if (text.trim().length > 0) {
          setComposer((prev) => (prev.trim().length > 0 ? `${prev} ${text}` : text));
        } else {
          setSttHint("Nothing was transcribed — try again, a bit closer to the mic.");
        }
      } catch (err) {
        setSttHint(commandErrorLabel(err));
      } finally {
        setSttBusy(false);
      }
    },
    [],
  );

  const toggleRecording = useCallback(async (): Promise<void> => {
    setSttHint("");
    if (recording) {
      stopRecording();
      return;
    }
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof window.MediaRecorder === "undefined"
    ) {
      setSttHint("Voice input is not available on this device.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = RECORDING_MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        void finishRecording(chunks, recorder.mimeType);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setSttHint("Microphone access was denied — dictation is unavailable.");
    }
  }, [recording, stopRecording, finishRecording]);

  const newChat = useCallback((): void => {
    setActiveConvId(null);
    setMessages([]);
    setInlineError("");
    setSessionExpired(false);
  }, []);

  const deleteConversation = useCallback(
    async (conversationId: number): Promise<void> => {
      try {
        await invoke("conversation_delete", { conversationId });
      } catch {
        return; // keep the list untouched on failure
      }
      if (activeConvRef.current === conversationId) {
        activeConvRef.current = null;
        setActiveConvId(null);
        setMessages([]);
      }
      void refreshConversations();
    },
    [refreshConversations],
  );

  const streamingActive = activeConvId !== null && streamingIds.has(activeConvId);
  const activeDraft = activeConvId !== null ? drafts.get(activeConvId) : undefined;
  const imageGeneratingActive =
    activeConvId !== null && imageGeneratingIds.has(activeConvId);
  const composerBusy = streamingActive || imageGeneratingActive;

  // Stop button (T4b): abort the active stream; the text that already
  // arrived stays persisted. The chat://stopped handler clears the draft
  // and reloads the persisted transcript.
  const stopGenerating = useCallback(async (): Promise<void> => {
    const conversationId = activeConvRef.current;
    if (conversationId === null) return;
    try {
      await invoke("chat_stop", { conversationId });
    } catch (err) {
      setInlineError(commandErrorLabel(err));
    }
  }, []);

  // Cancel button (T5): abort the active image generation (~1 min — worth
  // an escape hatch). image_cancel emits images://stopped; the local clear
  // makes the UI reset instant even if the event races.
  const cancelImage = useCallback(async (): Promise<void> => {
    const conversationId = activeConvRef.current;
    if (conversationId === null) return;
    try {
      await invoke("image_cancel", { conversationId });
    } catch (err) {
      setInlineError(commandErrorLabel(err));
      return;
    }
    setImageGeneratingIds((prev) => {
      const next = new Set(prev);
      next.delete(conversationId);
      return next;
    });
  }, []);

  const send = useCallback(async (): Promise<void> => {
    const text = composer.trim();
    if (!text || streamingActive) return;
    setSessionExpired(false);
    setInlineError("");
    const profileId = activeProfileRef.current;
    if (!profileId) return;

    let conversationId = activeConvId;
    try {
      if (conversationId === null) {
        conversationId = await invoke<number>("conversation_create", { profileId });
        activeConvRef.current = conversationId;
        setActiveConvId(conversationId);
      }
      // Optimistic user bubble; the Rust core persists the real row before
      // streaming starts (the refetch after done/error is the source of truth).
      setMessages((prev) => [
        ...prev,
        {
          id: -Date.now(),
          conversation_id: conversationId as number,
          role: "user",
          content: text,
          model: null,
          created_at: "",
          partial: false,
          media_path: null,
        },
      ]);
      setComposer("");
      setStreamingIds((prev) => new Set(prev).add(conversationId as number));
      setDrafts((prev) => new Map(prev).set(conversationId as number, ""));
      await invoke("chat_send", {
        conversationId,
        model,
        content: text,
      });
    } catch (err) {
      setStreamingIds((prev) => {
        const next = new Set(prev);
        if (conversationId !== null) next.delete(conversationId);
        return next;
      });
      setDrafts((prev) => {
        const next = new Map(prev);
        if (conversationId !== null) next.delete(conversationId);
        return next;
      });
      setInlineError(String(err));
      void refreshConversations();
    }
  }, [composer, streamingActive, activeConvId, model, refreshConversations]);

  // Image send (T5): nothing is stored client-side — the Rust core saves
  // the PNG, appends the assistant row (media_path) and only then emits
  // done, which reloads the transcript.
  const sendImage = useCallback(async (): Promise<void> => {
    const prompt = composer.trim();
    if (!prompt || imageGeneratingActive) return;
    setSessionExpired(false);
    setInlineError("");
    const profileId = activeProfileRef.current;
    if (!profileId) return;

    let conversationId = activeConvId;
    try {
      if (conversationId === null) {
        conversationId = await invoke<number>("conversation_create", { profileId });
        activeConvRef.current = conversationId;
        setActiveConvId(conversationId);
      }
      setImageGeneratingIds((prev) => new Set(prev).add(conversationId as number));
      setComposer("");
      await invoke("image_generate", {
        conversationId,
        prompt,
        size: imageSize,
      });
    } catch (err) {
      setImageGeneratingIds((prev) => {
        const next = new Set(prev);
        if (conversationId !== null) next.delete(conversationId);
        return next;
      });
      setInlineError(commandErrorLabel(err));
      void refreshConversations();
    }
  }, [composer, imageGeneratingActive, activeConvId, imageSize, refreshConversations]);

  // Auto-scroll to the newest content.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeDraft, streamingActive, imageGeneratingActive]);

  return (
    <main className="chat-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <p className="brand">{"// nan-desktop"}</p>
          <button type="button" className="btn btn-primary new-chat-btn" onClick={newChat}>
            + New chat
          </button>
        </div>
        <nav className="conv-list" aria-label="conversations">
          {conversations.length === 0 && (
            <p className="conv-empty">No conversations yet</p>
          )}
          {conversations.map((c) => (
            <div key={c.id} className={`conv-item${c.id === activeConvId ? " active" : ""}`}>
              <button
                type="button"
                className="conv-main"
                onClick={() => selectConversation(c.id)}
                title={c.title}
              >
                <span className="conv-title">{c.title}</span>
                {c.last_message && <span className="conv-preview">{c.last_message}</span>}
              </button>
              <button
                type="button"
                className="conv-delete"
                aria-label={`Delete conversation ${c.title}`}
                onClick={() => void deleteConversation(c.id)}
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-row">
            <span className="profile-name">{activeProfile?.name ?? "unknown profile"}</span>
            {activeProfile?.has_key && (
              <span className="key-note">key {activeProfile.key_mask}</span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost signout-btn"
            onClick={onSignOut}
            disabled={busy}
          >
            Sign out
          </button>
          {/* T1 spike diagnostics, kept working and collapsed. */}
          <details className="spike-details">{spike}</details>
          {/* T8 tools settings: grants, run_command switch, audit viewer. */}
          <details className="tools-details">
            <summary>Tools &amp; folder grants</summary>
            <ToolsPanel profileId={overview.active_profile} />
          </details>
        </div>
      </aside>

      <section className="chat-main">
        {sessionExpired && (
          <div className="banner banner-error" role="alert">
            <span>Session expired — sign in again</span>
            <button type="button" className="btn btn-ghost banner-btn" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        )}
        <header className="chat-header">
          <label className="model-label" htmlFor="model-select">
            Model
          </label>
          <select
            id="model-select"
            className="model-select"
            value={model}
            onChange={(e) => setModel(e.currentTarget.value)}
          >
            {(models.length > 0 ? models : [model]).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <label className="model-label voice-label" htmlFor="voice-select">
            Voice
          </label>
          <select
            id="voice-select"
            className="model-select"
            value={voice}
            onChange={(e) => setVoice(e.currentTarget.value)}
            aria-label="Text-to-speech voice"
          >
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          {imageMode && (
            <>
              <label className="model-label voice-label" htmlFor="image-size-select">
                Size
              </label>
              <select
                id="image-size-select"
                className="model-select"
                value={imageSize}
                onChange={(e) => setImageSize(e.currentTarget.value)}
                aria-label="Image size"
              >
                {IMAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </>
          )}
        </header>

        <div className="messages" ref={messagesRef}>
          {messages.length === 0 && !activeDraft && (
            <div className="empty-state">
              <p className="empty-title">New conversation</p>
              <p className="empty-hint">
                Send your first message — Enter sends, Shift+Enter adds a newline.
              </p>
            </div>
          )}
          {messages.map((m) =>
            m.role === "assistant" ? (
              m.media_path ? (
                // T5: inline generated image. The renderer loads the saved
                // file through the Tauri asset protocol (scope: the app
                // data images dir) — the bytes never crossed IPC.
                <article key={m.id} className="msg msg-assistant msg-image-row">
                  <img
                    className="msg-image"
                    src={convertFileSrc(m.media_path)}
                    alt={m.content}
                  />
                  <p className="image-caption">{m.content}</p>
                </article>
              ) : (
                <article
                  key={m.id}
                  className={`msg msg-assistant${speakingMsgId === m.id ? " speaking" : ""}`}
                >
                  <Markdown text={m.content} />
                  {m.partial && (
                    <span className="partial-note" role="note">
                      message interrupted
                    </span>
                  )}
                  {m.content.trim().length > 0 && (
                    <button
                      type="button"
                      className="speak-btn"
                      aria-label={
                        speakingMsgId === m.id ? "Stop reading aloud" : "Read message aloud"
                      }
                      title={speakingMsgId === m.id ? "Stop" : "Read aloud"}
                      onClick={() => void toggleSpeak(m)}
                    >
                      {speakingMsgId === m.id ? "■" : "▶"}
                    </button>
                  )}
                </article>
              )
            ) : (
              <article key={m.id} className="msg msg-user">
                <p className="msg-user-text">{m.content}</p>
              </article>
            ),
          )}
          {streamingActive && activeDraft !== undefined && (
            <article className="msg msg-assistant streaming">
              <Markdown text={activeDraft} />
              <span className="caret" aria-hidden="true" />
            </article>
          )}
          {imageGeneratingActive && (
            <article className="msg msg-assistant image-pending" role="status">
              <span className="pulse-dot" aria-hidden="true" />
              Generating image (~1 min)
            </article>
          )}
          {ttsHint && (
            <div className="msg-error" role="status">
              {ttsHint}
            </div>
          )}
          {inlineError && (
            <div className="msg-error" role="alert">
              {inlineError}
            </div>
          )}
        </div>

        <footer className="composer">
          {/* T8 proposal demo: test surface driving the Rust-core
              propose → approve/deny → execute path. */}
          <ProposalDemo profileId={overview.active_profile} conversationId={activeConvId} />
          {sttHint && (
            <p className="hint composer-hint" role="status">
              {sttHint}
            </p>
          )}
          <div className="composer-row">
            <button
              type="button"
              className={`btn icon-btn image-btn${imageMode ? " active" : ""}`}
              aria-pressed={imageMode}
              aria-label={imageMode ? "Switch to text chat" : "Image mode"}
              title={imageMode ? "Switch to text chat" : "Generate an image"}
              onClick={() => setImageMode((value) => !value)}
              disabled={composerBusy}
            >
              img
            </button>
            <textarea
              className="composer-input"
              value={composer}
              onChange={(e) => setComposer(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void (imageMode ? sendImage() : send());
                }
              }}
              placeholder={
                sttBusy
                  ? "Transcribing…"
                  : imageGeneratingActive
                    ? "Generating image…"
                    : streamingActive
                      ? "Waiting for the reply…"
                      : imageMode
                        ? "Describe the image"
                        : "Message…"
              }
              rows={3}
              disabled={composerBusy}
            />
            <button
              type="button"
              className={`btn icon-btn mic-btn${recording ? " recording" : ""}`}
              aria-label={recording ? "Stop recording" : "Dictate"}
              title={recording ? "Stop recording" : "Dictate"}
              onClick={() => void toggleRecording()}
              disabled={sttBusy || composerBusy}
            >
              {recording ? "■" : "●"}
            </button>
            {imageGeneratingActive ? (
              // T5: while an image is generating (~1 min), Send is replaced
              // by a cancel button — the task aborts, nothing is persisted.
              <button
                type="button"
                className="btn stop-btn"
                onClick={() => void cancelImage()}
              >
                Cancel image
              </button>
            ) : streamingActive ? (
              // T4b: while streaming, Send is replaced by Stop — the reply
              // is being persisted as it arrives, so stopping keeps it.
              <button
                type="button"
                className="btn stop-btn"
                onClick={() => void stopGenerating()}
              >
                Stop generating
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary send-btn"
                onClick={() => void (imageMode ? sendImage() : send())}
                disabled={composer.trim().length === 0}
              >
                {imageMode ? "Generate" : "Send"}
              </button>
            )}
          </div>
        </footer>
      </section>
    </main>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [loadError, setLoadError] = useState("");
  const [overview, setOverview] = useState<ProfileOverview | null>(null);
  const [pickerError, setPickerError] = useState("");
  const [busy, setBusy] = useState(false);

  // Device-flow login state.
  const [authProfileId, setAuthProfileId] = useState<string | null>(null);
  const [authPhase, setAuthPhase] = useState<AuthPhase>("waiting");
  const [userCode, setUserCode] = useState("");
  const [pollCount, setPollCount] = useState(0);
  const [errorKind, setErrorKind] = useState("");
  const authProfileRef = useRef<string | null>(null);
  useEffect(() => {
    authProfileRef.current = authProfileId;
  }, [authProfileId]);

  // (a) SSE demo (T1 spike panel)
  const [sseUrl, setSseUrl] = useState("http://127.0.0.1:14321/events");
  const [chunks, setChunks] = useState<string[]>([]);
  const [sseStatus, setSseStatus] = useState<"idle" | "streaming" | "done" | "error">("idle");
  const [sseError, setSseError] = useState("");

  // (b) Keychain demo (T1 spike panel)
  const [krService, setKrService] = useState("nan-desktop-spike");
  const [krAccount, setKrAccount] = useState("demo-api-key");
  const [krValue, setKrValue] = useState("");
  const [krStatus, setKrStatus] = useState("");

  // (c) SQLite demo (T1 spike panel)
  const [spikeMessages, setSpikeMessages] = useState<SpikeMessage[]>([]);
  const [dbStatus, setDbStatus] = useState("");

  const refreshOverview = useCallback(
    async (): Promise<ProfileOverview> => invoke<ProfileOverview>("profiles_load"),
    [],
  );

  const boot = useCallback(async (): Promise<void> => {
    setScreen("loading");
    try {
      const next = await refreshOverview();
      setOverview(next);
      const active = next.profiles.find((p) => p.id === next.active_profile);
      setScreen(active && active.has_key ? "chat" : "picker");
    } catch (err) {
      setLoadError(String(err));
      setScreen("error");
    }
  }, [refreshOverview]);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Rust → frontend event transport. Registered once; cleanup on unmount.
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [
      listen<DeviceStarted>("device://started", (event) => {
        setUserCode(event.payload.user_code);
      }),
      listen<DeviceStatus>("device://status", (event) => {
        if (event.payload.status === "pending") {
          setPollCount((count) => count + 1);
        }
      }),
      listen<DeviceApproved>("device://approved", (event) => {
        // Ignore stale approvals from an earlier, cancelled flow.
        if (authProfileRef.current !== event.payload.profile_id) return;
        refreshOverview()
          .then((next) => {
            setOverview(next);
            setAuthProfileId(null);
            setScreen("chat");
          })
          .catch((err) => {
            setLoadError(String(err));
            setScreen("error");
          });
      }),
      listen<DeviceStatus>("device://denied", () => setAuthPhase("denied")),
      listen<DeviceStatus>("device://expired", () => setAuthPhase("expired")),
      listen<DeviceError>("device://error", (event) => {
        setErrorKind(event.payload.kind);
        setAuthPhase("error");
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        promise.then((unlisten) => unlisten());
      });
    };
  }, [refreshOverview]);

  // Spike-panel event transport (T1).
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [
      listen<SseChunkPayload>("sse://chunk", (event) => {
        setChunks((prev) => [...prev, event.payload.text]);
        setSseStatus("streaming");
      }),
      listen<number>("sse://done", () => setSseStatus("done")),
      listen<string>("sse://error", (event) => {
        setSseError(event.payload);
        setSseStatus("error");
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        promise.then((unlisten) => unlisten());
      });
    };
  }, []);

  const startLogin = useCallback(
    async (profileId: string): Promise<void> => {
      setBusy(true);
      setPickerError("");
      // Track the flow from before the request so no early event is missed.
      setAuthProfileId(profileId);
      setAuthPhase("waiting");
      setUserCode("");
      setPollCount(0);
      setErrorKind("");
      try {
        await invoke("device_login_start", { profileId });
        setScreen("authorizing");
      } catch (err) {
        setAuthProfileId(null);
        setPickerError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const cancelLogin = useCallback(async (): Promise<void> => {
    try {
      await invoke("device_login_cancel");
    } catch {
      // The loop may already have finished; nothing to undo.
    }
    setAuthProfileId(null);
    setScreen("picker");
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    const profileId = overview?.active_profile;
    if (!profileId) return;
    setBusy(true);
    try {
      await invoke("device_logout", { profileId });
      const next = await refreshOverview();
      setOverview(next);
      setScreen("picker");
    } catch (err) {
      setLoadError(String(err));
      setScreen("error");
    } finally {
      setBusy(false);
    }
  }, [overview, refreshOverview]);

  async function startSse(): Promise<void> {
    setChunks([]);
    setSseError("");
    setSseStatus("streaming");
    try {
      await invoke("sse_demo_start", { url: sseUrl });
    } catch (err) {
      setSseError(String(err));
      setSseStatus("error");
    }
  }

  async function keyringSet(): Promise<void> {
    try {
      await invoke("keyring_set", {
        service: krService,
        account: krAccount,
        value: krValue,
      });
      setKrStatus("stored in the OS keychain");
      setKrValue(""); // do not keep the secret in the DOM
    } catch (err) {
      setKrStatus(`error: ${String(err)}`);
    }
  }

  async function keyringGet(): Promise<void> {
    try {
      const value = await invoke<string | null>("keyring_get", {
        service: krService,
        account: krAccount,
      });
      setKrStatus(
        value === null ? "no entry found" : `retrieved: ${maskValue(value)}`,
      );
    } catch (err) {
      setKrStatus(`error: ${String(err)}`);
    }
  }

  async function runDbDemo(): Promise<void> {
    try {
      const rows = await invoke<SpikeMessage[]>("db_demo");
      setSpikeMessages(rows);
      setDbStatus(`${rows.length} row(s) returned (last 10 by id)`);
    } catch (err) {
      setDbStatus(`error: ${String(err)}`);
    }
  }

  // The T1 spike panel JSX (rendered inside the sidebar's <details> on the
  // chat screen; it needs no props — all state lives here). Dev-only:
  // the spike IPC commands do not exist in release builds (security review
  // B1/B2/B6), so the panel must not render there either.
  const spikePanel = import.meta.env.DEV ? (
    <>
      <summary>T1 spike diagnostics (SSE / keychain / SQLite)</summary>

      <section className="panel">
        <h2>SSE demo (Rust → UI)</h2>
        <p className="hint">
          Requires the mock server: <code>node test/mock-sse.mjs</code>
        </p>
        <div className="row-h">
          <input
            value={sseUrl}
            onChange={(e) => setSseUrl(e.currentTarget.value)}
            placeholder="SSE URL"
          />
          <button type="button" className="btn btn-ghost" onClick={() => void startSse()}>
            Start
          </button>
        </div>
        <p className="status">
          status: {sseStatus}
          {sseError ? ` — ${sseError}` : ""}
        </p>
        <ul className="chunk-list">
          {chunks.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Keychain (OS credential store)</h2>
        <div className="row-h">
          <input
            value={krService}
            onChange={(e) => setKrService(e.currentTarget.value)}
            placeholder="service"
          />
          <input
            value={krAccount}
            onChange={(e) => setKrAccount(e.currentTarget.value)}
            placeholder="account"
          />
        </div>
        <div className="row-h">
          <input
            type="password"
            value={krValue}
            onChange={(e) => setKrValue(e.currentTarget.value)}
            placeholder="value to store"
            autoComplete="off"
          />
          <button type="button" className="btn btn-ghost" onClick={() => void keyringSet()}>
            Set
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void keyringGet()}>
            Get
          </button>
        </div>
        <p className="status">{krStatus}</p>
      </section>

      <section className="panel">
        <h2>SQLite (local history foundation)</h2>
        <div className="row-h">
          <button type="button" className="btn btn-ghost" onClick={() => void runDbDemo()}>
            Insert demo row + list last 10
          </button>
        </div>
        <p className="status">{dbStatus}</p>
        <ul className="chunk-list">
          {spikeMessages.map((m) => (
            <li key={m.id}>
              #{m.id} [{m.role}] {m.content} — {m.created_at}
            </li>
          ))}
        </ul>
      </section>
    </>
  ) : null;

  if (screen === "loading") {
    return (
      <main className="screen">
        <p className="brand">{"// nan-desktop"}</p>
        <p className="status-line muted">
          <span className="pulse-dot" /> Loading…
        </p>
      </main>
    );
  }

  if (screen === "error") {
    return (
      <main className="screen">
        <p className="brand">{"// nan-desktop"}</p>
        <h1>Something went wrong</h1>
        <p className="status err">{loadError}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => void boot()}>
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (screen === "authorizing" && authProfileId) {
    const profile = overview?.profiles.find((p) => p.id === authProfileId);
    return (
      <Authorizing
        profileName={profile?.name ?? authProfileId}
        userCode={userCode}
        phase={authPhase}
        errorKind={errorKind}
        pollCount={pollCount}
        onTryAgain={() => void startLogin(authProfileId)}
        onPickAnother={() => void cancelLogin()}
        onCancel={() => void cancelLogin()}
      />
    );
  }

  if (screen === "picker" && overview) {
    return (
      <ProfilePicker
        overview={overview}
        busy={busy}
        error={pickerError}
        onPick={(id) => void startLogin(id)}
      />
    );
  }

  if (screen !== "chat" || !overview) {
    return null; // unreachable with a consistent state machine
  }

  return (
    <ChatShell overview={overview} busy={busy} onSignOut={() => void signOut()} spike={spikePanel} />
  );
}

export default App;
