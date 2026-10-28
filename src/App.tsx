import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
};

// Must match src-tauri/src/chat.rs DEFAULT_MODEL (the renderer cannot import
// Rust constants; the Rust side falls back to the same value).
const DEFAULT_MODEL = "deepseek-v4-flash";

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

  const selectConversation = useCallback(
    (conversationId: number): void => {
      setActiveConvId(conversationId);
      setInlineError("");
      setSessionExpired(false);
      void loadMessages(conversationId);
    },
    [loadMessages],
  );

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

  // Auto-scroll to the newest content.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeDraft, streamingActive]);

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
          {messages.map((m) => (
            <article key={m.id} className={`msg msg-${m.role}`}>
              {m.role === "assistant" ? (
                <Markdown text={m.content} />
              ) : (
                <p className="msg-user-text">{m.content}</p>
              )}
            </article>
          ))}
          {streamingActive && activeDraft !== undefined && (
            <article className="msg msg-assistant streaming">
              <Markdown text={activeDraft} />
              <span className="caret" aria-hidden="true" />
            </article>
          )}
          {inlineError && (
            <div className="msg-error" role="alert">
              {inlineError}
            </div>
          )}
        </div>

        <footer className="composer">
          <textarea
            className="composer-input"
            value={composer}
            onChange={(e) => setComposer(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={streamingActive ? "Waiting for the reply…" : "Message…"}
            rows={3}
            disabled={streamingActive}
          />
          <button
            type="button"
            className="btn btn-primary send-btn"
            onClick={() => void send()}
            disabled={streamingActive || composer.trim().length === 0}
          >
            Send
          </button>
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
