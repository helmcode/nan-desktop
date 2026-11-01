import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import "./App.css";
import {
  DEFAULT_IMAGE_SIZE,
  IMAGE_SIZES,
  PROFILE_COPY,
  VOICE_STORAGE_KEY,
  chatErrorLabel,
  commandErrorLabel,
  folderName,
  hostOf,
  imageErrorLabel,
  profileTitle,
  signInErrorLabel,
  storedVoice,
} from "./copy";
import {
  BrandMark,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconComputer,
  IconCopy,
  IconFolder,
  IconGear,
  IconGlobe,
  IconImage,
  IconMic,
  IconPlus,
  IconSpeaker,
  IconStop,
  IconTrash,
  IconWarning,
  Wordmark,
} from "./icons";
import { Settings } from "./Settings";
import type {
  ChatMessageRow,
  ConversationView,
  ProfileOverview,
  ProfileView,
  WebSource,
} from "./types";
import { useWorkspace, type Workspace } from "./workspace";

// The renderer never sees profile URLs, API keys or session tokens (S4/S12):
// profiles arrive as {id, name, has_key, key_mask} from the Rust core, and
// all HTTP — sign-in, chat streaming, web search, memory sync — happens in
// Rust. Chat arrives as delta/done/error/activity events only.

// Device-flow payloads (Rust core → renderer): only non-secret fields.
interface DeviceStarted {
  user_code: string;
}
interface DeviceApproved {
  key_alias: string;
  profile_id: string;
}
interface DeviceError {
  kind: string;
}

// Chat payloads: delta text, conversation ids and classified error kinds.
interface ChatDelta {
  conversation_id: number;
  delta: string;
}
interface ChatIdPayload {
  conversation_id: number;
}
interface ChatError {
  conversation_id: number;
  kind: string;
}
// What the assistant is doing between text deltas.
interface ChatActivity {
  conversation_id: number;
  activity: "searching" | "working" | null;
}
interface TtsError {
  kind: string;
}
interface ImagesError {
  conversation_id: number;
  kind: string;
}

// Must match src-tauri/src/chat.rs DEFAULT_MODEL.
const DEFAULT_MODEL = "deepseek-v4-flash";

// Must match src-tauri/src/stt.rs MAX_AUDIO_BYTES.
const MAX_STT_BYTES = 25 * 1024 * 1024;

// Recorder MIME types in preference order (webm/opus, then mp4/AAC).
const RECORDING_MIME_CANDIDATES = ["audio/webm", "audio/mp4"];

const ACTIVITY_COPY: Record<string, string> = {
  searching: "Buscando en internet…",
  working: "Esperando tu permiso para usar tus archivos…",
};

type Screen = "loading" | "error" | "picker" | "authorizing" | "chat";
type AuthPhase = "waiting" | "denied" | "expired" | "error";

// ---------------------------------------------------------------------------
// Markdown rendering (S3): GFM + highlight + sanitize. NEVER raw HTML.
//
// rehype-highlight keeps the pipeline synchronous (streaming-friendly);
// rehype-sanitize runs AFTER highlighting so its output is the last pass.
// ---------------------------------------------------------------------------

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

const sanitizeSchema = {
  ...defaultSchema,
  // Security review R1 (defense in depth with the app CSP): model markdown
  // may not load remote images — an <img> to an attacker host would be a
  // conversation-content exfiltration channel.
  tagNames: (defaultSchema.tagNames ?? []).filter(
    (t) => t !== "img" && t !== "picture" && t !== "source",
  ),
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-./, /^hljs$/]],
    span: [...(defaultSchema.attributes?.span ?? []), ["className", /^hljs-./]],
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
        <span className="codeblock-lang">{language ?? "texto"}</span>
        <button type="button" className="codeblock-copy" onClick={() => void copy()}>
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (typeof node === "object" && "props" in (node as unknown as Record<string, unknown>)) {
    const props = (node as unknown as { props?: { children?: ReactNode } }).props;
    return nodeToText(props?.children);
  }
  return "";
}

/// Ask the Rust core to open a URL in the system browser (https-only
/// validation happens there). Invalid URLs are rejected silently.
function openExternal(url: string): void {
  if (url) {
    void invoke("open_external", { url }).catch(() => {});
  }
}

/// Model-supplied links never navigate the main window (external review
/// B3): a neutral element with no href; clicking asks the Rust core to open
/// the URL in the system browser. The URL stays visible so the target is
/// never hidden. The Rust-side navigation allowlist is a second layer.
function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  const url = typeof href === "string" ? href : "";
  const label = nodeToText(children);
  return (
    <span
      className="safe-link"
      role="link"
      tabIndex={0}
      title={url}
      onClick={() => openExternal(url)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") openExternal(url);
      }}
    >
      {children}
      {url && !label.includes(url) ? <span className="safe-link-url"> ({url})</span> : null}
    </span>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema]]}
        components={{ pre: CodeBlock, a: SafeLink }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/// Citation chips under an answer that used the built-in web search.
function SourceChips({ sources }: { sources: WebSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="sources" aria-label="Fuentes">
      <span className="sources-label">Fuentes</span>
      <ul>
        {sources.map((source, index) => (
          <li key={source.url}>
            <button
              type="button"
              className="source-chip"
              title={source.url}
              onClick={() => openExternal(source.url)}
            >
              <span className="source-index">{index + 1}</span>
              <span className="source-title">{source.title}</span>
              <span className="source-host">{hostOf(source.url)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sign-in screens
// ---------------------------------------------------------------------------

function CenterScreen({ children }: { children: ReactNode }) {
  return (
    <main className="center-screen">
      <div className="center-card">{children}</div>
    </main>
  );
}

function BrandHero() {
  return (
    <div className="brand-hero">
      <BrandMark variant="tile" size={56} />
      <Wordmark />
    </div>
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
    <CenterScreen>
      <BrandHero />
      <h1>Te damos la bienvenida</h1>
      <p className="lede">
        Elige cómo quieres entrar. Confirmarás el acceso en tu navegador: no tienes que copiar
        ninguna clave.
      </p>
      <div className="profile-cards">
        {overview.profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            className="profile-card"
            onClick={() => onPick(p.id)}
            disabled={busy}
          >
            <span className="profile-card-text">
              <strong>{profileTitle(p.id, p.name)}</strong>
              <span>{PROFILE_COPY[p.id]?.description ?? ""}</span>
              {p.has_key && <span className="profile-card-meta">Ya has entrado antes en este equipo</span>}
            </span>
            <span className="profile-card-arrow" aria-hidden="true">
              →
            </span>
          </button>
        ))}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </CenterScreen>
  );
}

function Authorizing({
  profileName,
  userCode,
  phase,
  errorKind,
  onTryAgain,
  onPickAnother,
  onCancel,
}: {
  profileName: string;
  userCode: string;
  phase: AuthPhase;
  errorKind: string;
  onTryAgain: () => void;
  onPickAnother: () => void;
  onCancel: () => void;
}) {
  const waiting = phase === "waiting";
  const headline =
    phase === "denied"
      ? "Acceso rechazado"
      : phase === "expired"
        ? "El código ha caducado"
        : phase === "error"
          ? "No hemos podido completar el acceso"
          : "Confirma el acceso en tu navegador";

  return (
    <CenterScreen>
      <BrandHero />
      <p className="eyebrow">{profileName}</p>
      <h1>{headline}</h1>
      {waiting ? (
        <>
          <p className="lede">
            Hemos abierto una ventana en tu navegador. Comprueba que muestra este mismo código y
            confirma el acceso.
          </p>
          <div className="device-code" aria-label="Código de acceso">
            {userCode || "····-····"}
          </div>
          <p className="status-line" role="status">
            <span className="pulse-dot" aria-hidden="true" />
            Esperando tu confirmación…
          </p>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancelar
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="lede">
            {phase === "denied" &&
              "Se ha rechazado el acceso desde el navegador. No se ha guardado nada en este equipo."}
            {phase === "expired" && "Ha pasado demasiado tiempo. Empieza de nuevo para obtener un código nuevo."}
            {phase === "error" && signInErrorLabel(errorKind)}
          </p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={onTryAgain}>
              Volver a intentarlo
            </button>
            <button type="button" className="btn btn-ghost" onClick={onPickAnother}>
              Elegir otra cuenta
            </button>
          </div>
        </>
      )}
    </CenterScreen>
  );
}

// ---------------------------------------------------------------------------
// Workspace chip + whole-computer confirmation (composer)
// ---------------------------------------------------------------------------

function workspaceLabel(workspace: Workspace): string {
  if (workspace.computerWide) return "Todo el equipo — bajo tu responsabilidad";
  const [first, ...rest] = workspace.folders;
  if (!first) return "Elegir carpeta de trabajo";
  const extra = rest.length > 0 ? ` +${rest.length}` : "";
  return `Carpeta privada: ${folderName(first.canonical_path)}${extra}`;
}

function WorkspaceChip({
  workspace,
  onAskComputerWide,
  onOpenSettings,
}: {
  workspace: Workspace;
  onAskComputerWide: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const wide = workspace.computerWide !== null;
  const empty = !wide && workspace.folders.length === 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = async (action: () => Promise<unknown> | void): Promise<void> => {
    setOpen(false);
    await action();
  };

  return (
    <div className="ws" ref={rootRef}>
      <button
        type="button"
        className={`ws-chip${wide ? " ws-chip-wide" : ""}${empty ? " ws-chip-empty" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Dónde puede trabajar el asistente"
        onClick={() => {
          if (empty) {
            void workspace.addFolder();
          } else {
            setOpen((value) => !value);
          }
        }}
        disabled={workspace.busy}
      >
        {wide ? <IconWarning size={15} /> : empty ? <IconPlus size={15} /> : <IconFolder size={15} />}
        <span className="ws-chip-label">{workspaceLabel(workspace)}</span>
        {!empty && <IconChevronDown size={14} />}
      </button>
      {open && (
        <div className="ws-menu" role="menu" aria-label="Dónde trabaja el asistente">
          <p className="ws-menu-heading">Carpeta privada</p>
          {workspace.folders.map((grant) => (
            <button
              key={grant.id}
              type="button"
              role="menuitemradio"
              aria-checked={!wide}
              className="ws-menu-item"
              onClick={() => void pick(() => (wide ? workspace.disableComputerWide() : undefined))}
            >
              <IconFolder size={15} />
              <span className="ws-menu-text">{folderName(grant.canonical_path)}</span>
              {!wide && <IconCheck size={14} />}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="ws-menu-item"
            onClick={() => void pick(() => workspace.addFolder())}
          >
            <IconPlus size={15} />
            <span className="ws-menu-text">Añadir carpeta…</span>
          </button>
          <div className="ws-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={wide}
            className="ws-menu-item ws-menu-item-wide"
            onClick={() => void pick(() => (wide ? undefined : onAskComputerWide()))}
          >
            <IconComputer size={15} />
            <span className="ws-menu-text">Todo el equipo — bajo tu responsabilidad</span>
            {wide && <IconCheck size={14} />}
          </button>
          <div className="ws-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="ws-menu-item ws-menu-item-muted"
            onClick={() => void pick(onOpenSettings)}
          >
            <IconGear size={15} />
            <span className="ws-menu-text">Gestionar carpetas</span>
          </button>
        </div>
      )}
    </div>
  );
}

/// Plain-language warning before the whole-computer mode. Continuing asks
/// the Rust core, which shows its own native confirmation — this dialog
/// explains, the native one decides (the renderer cannot grant anything).
function ComputerWideDialog({
  onCancel,
  onContinue,
}: {
  onCancel: () => void;
  onContinue: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="modal modal-warn"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cw-title"
        aria-describedby="cw-body"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="modal-icon">
          <IconWarning size={22} />
        </span>
        <h2 id="cw-title">¿Dar acceso a todo tu equipo?</h2>
        <div id="cw-body">
          <ul className="modal-points">
            <li>
              El asistente podrá pedirte permiso para leer, crear o cambiar <strong>cualquier
              archivo de tu usuario</strong>: documentos, fotos, descargas…
            </li>
            <li>
              Te pedirá confirmación antes de cada acción. Pero si aceptas algo por error, podría
              borrar o estropear archivos importantes.
            </li>
            <li>Los datos de esta aplicación siempre quedan protegidos.</li>
            <li>Puedes volver a una carpeta privada cuando quieras.</li>
          </ul>
          <p className="modal-note">A continuación tu equipo te pedirá una última confirmación.</p>
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn btn-warn-solid" onClick={onContinue}>
            Continuar bajo mi responsabilidad
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat shell
// ---------------------------------------------------------------------------

function ChatShell({
  overview,
  busy,
  onSignOut,
}: {
  overview: ProfileOverview;
  busy: boolean;
  onSignOut: () => void;
}) {
  const activeProfile: ProfileView | undefined = overview.profiles.find(
    (p) => p.id === overview.active_profile,
  );
  const workspace = useWorkspace(overview.active_profile);

  const [view, setView] = useState<"chat" | "settings">("chat");
  const [askComputerWide, setAskComputerWide] = useState(false);

  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [drafts, setDrafts] = useState<Map<number, string>>(() => new Map());
  const [streamingIds, setStreamingIds] = useState<Set<number>>(() => new Set());
  const [activities, setActivities] = useState<Map<number, string>>(() => new Map());
  const [composer, setComposer] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [inlineError, setInlineError] = useState("");

  // Image mode: the composer sends the prompt to `image_generate`.
  const [imageMode, setImageMode] = useState(false);
  const [imageSize, setImageSize] = useState(DEFAULT_IMAGE_SIZE);
  const [imageGeneratingIds, setImageGeneratingIds] = useState<Set<number>>(() => new Set());

  // Voice: read-aloud + dictation. The voice is chosen in Settings.
  const [voice, setVoice] = useState<string>(storedVoice);
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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshConversations = useCallback(async (): Promise<ConversationView[]> => {
    const profileId = activeProfileRef.current;
    if (!profileId) return [];
    try {
      const list = await invoke<ConversationView[]>("conversation_list", { profileId });
      setConversations(list);
      return list;
    } catch {
      return []; // the sidebar stays as-is on a transient failure
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

  // Account memory: reconcile with the account in the background. Silent
  // by design — any failure keeps the local copy; nothing is ever shown.
  const syncMemory = useCallback(async (): Promise<void> => {
    const profileId = activeProfileRef.current;
    if (!profileId) return;
    try {
      const changed = await invoke<boolean>("memory_sync", { profileId });
      if (changed) {
        await refreshConversations();
        const current = activeConvRef.current;
        if (current !== null) void loadMessages(current);
      }
    } catch {
      // Silent: memory sync never interrupts the user.
    }
  }, [refreshConversations, loadMessages]);

  // Boot: conversations, models, most recent conversation open, then sync.
  useEffect(() => {
    void refreshConversations().then((list) => {
      if (list.length > 0) {
        setActiveConvId(list[0].id);
        void loadMessages(list[0].id);
      }
      void syncMemory();
    });
    void invoke<string[]>("models_list")
      .then((list) => {
        setModels(list);
        setModel((current) => (list.includes(current) ? current : (list[0] ?? DEFAULT_MODEL)));
      })
      .catch(() => {
        // Offline or no key: keep the default; sending surfaces the error.
      });
  }, [refreshConversations, loadMessages, syncMemory]);

  // Chat event transport. Registered once; refs carry the active ids.
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
      setActivities((prev) => {
        const next = new Map(prev);
        next.delete(conversationId);
        return next;
      });
    };
    const finish = (conversationId: number): void => {
      markStreaming(conversationId, false);
      clearDraft(conversationId);
      if (activeConvRef.current === conversationId) void loadMessages(conversationId);
      void refreshConversations();
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
      listen<ChatActivity>("chat://activity", (event) => {
        const { conversation_id, activity } = event.payload;
        setActivities((prev) => {
          const next = new Map(prev);
          if (activity) next.set(conversation_id, activity);
          else next.delete(conversation_id);
          return next;
        });
      }),
      listen<ChatIdPayload>("chat://done", (event) => {
        finish(event.payload.conversation_id);
        void syncMemory();
      }),
      // The user pressed Stop: what arrived stays persisted.
      listen<ChatIdPayload>("chat://stopped", (event) => {
        finish(event.payload.conversation_id);
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
        void promise.then((unlisten) => unlisten());
      });
    };
  }, [loadMessages, refreshConversations, syncMemory]);

  // Image event transport: the core persists the row before `done`.
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
      listen<ChatIdPayload>("images://started", (event) => {
        markGenerating(event.payload.conversation_id, true);
      }),
      listen<ChatIdPayload>("images://done", (event) => {
        const conversationId = event.payload.conversation_id;
        markGenerating(conversationId, false);
        if (activeConvRef.current === conversationId) void loadMessages(conversationId);
        void refreshConversations();
        void syncMemory();
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
      listen<ChatIdPayload>("images://stopped", (event) => {
        markGenerating(event.payload.conversation_id, false);
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        void promise.then((unlisten) => unlisten());
      });
    };
  }, [loadMessages, refreshConversations, syncMemory]);

  // Voice transport: one global playback.
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
        void promise.then((unlisten) => unlisten());
      });
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(VOICE_STORAGE_KEY, voice);
  }, [voice]);

  // Stop playback and recording when the shell unmounts.
  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
      recorderRef.current = null;
      void invoke("tts_stop").catch(() => {});
    };
  }, []);

  const selectConversation = useCallback(
    (conversationId: number): void => {
      setView("chat");
      setActiveConvId(conversationId);
      setInlineError("");
      setSessionExpired(false);
      void loadMessages(conversationId);
    },
    [loadMessages],
  );

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

  const finishRecording = useCallback(async (chunks: Blob[], mimeType: string): Promise<void> => {
    const profileId = activeProfileRef.current;
    if (!profileId) return;
    const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
    if (blob.size === 0) {
      setSttHint("No se ha grabado nada. Vuelve a intentarlo.");
      return;
    }
    if (blob.size > MAX_STT_BYTES) {
      setSttHint("La grabación es demasiado larga. Prueba con un mensaje más corto.");
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
        composerRef.current?.focus();
      } else {
        setSttHint("No hemos entendido nada. Prueba a hablar un poco más cerca del micrófono.");
      }
    } catch (err) {
      setSttHint(commandErrorLabel(err));
    } finally {
      setSttBusy(false);
    }
  }, []);

  const toggleRecording = useCallback(async (): Promise<void> => {
    setSttHint("");
    if (recording) {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setRecording(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === "undefined") {
      setSttHint("El dictado por voz no está disponible en este equipo.");
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
      setSttHint("No tenemos permiso para usar el micrófono.");
    }
  }, [recording, finishRecording]);

  const newChat = useCallback((): void => {
    setView("chat");
    setActiveConvId(null);
    setMessages([]);
    setInlineError("");
    setSessionExpired(false);
    composerRef.current?.focus();
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
      await refreshConversations();
      void syncMemory();
    },
    [refreshConversations, syncMemory],
  );

  // Deletion is permanent: the first click arms an inline confirmation
  // (auto-disarmed after 4 s); the second, explicit click deletes.
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const deleteArmTimer = useRef<number | null>(null);
  const confirmDeleteConversation = useCallback(
    (conversationId: number): void => {
      if (pendingDeleteId !== conversationId) {
        setPendingDeleteId(conversationId);
        if (deleteArmTimer.current !== null) window.clearTimeout(deleteArmTimer.current);
        deleteArmTimer.current = window.setTimeout(() => setPendingDeleteId(null), 4000);
        return;
      }
      if (deleteArmTimer.current !== null) window.clearTimeout(deleteArmTimer.current);
      setPendingDeleteId(null);
      void deleteConversation(conversationId);
    },
    [pendingDeleteId, deleteConversation],
  );

  const streamingActive = activeConvId !== null && streamingIds.has(activeConvId);
  const activeDraft = activeConvId !== null ? drafts.get(activeConvId) : undefined;
  const activeActivity = activeConvId !== null ? activities.get(activeConvId) : undefined;
  const imageGeneratingActive = activeConvId !== null && imageGeneratingIds.has(activeConvId);
  const composerBusy = streamingActive || imageGeneratingActive;

  // Stop: abort the stream; what already arrived stays persisted.
  const stopGenerating = useCallback(async (): Promise<void> => {
    const conversationId = activeConvRef.current;
    if (conversationId === null) return;
    try {
      await invoke("chat_stop", { conversationId });
    } catch (err) {
      setInlineError(commandErrorLabel(err));
    }
  }, []);

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

  const ensureConversation = useCallback(async (): Promise<number | null> => {
    const profileId = activeProfileRef.current;
    if (!profileId) return null;
    if (activeConvRef.current !== null) return activeConvRef.current;
    const created = await invoke<number>("conversation_create", { profileId });
    activeConvRef.current = created;
    setActiveConvId(created);
    return created;
  }, []);

  const send = useCallback(async (): Promise<void> => {
    const text = composer.trim();
    if (!text || streamingActive) return;
    setSessionExpired(false);
    setInlineError("");
    let conversationId: number | null = null;
    try {
      conversationId = await ensureConversation();
      if (conversationId === null) return;
      const id = conversationId;
      // Optimistic user bubble; the core persists the real row first.
      setMessages((prev) => [
        ...prev,
        {
          id: -Date.now(),
          conversation_id: id,
          role: "user",
          content: text,
          model: null,
          created_at: "",
          partial: false,
          media_path: null,
          sources: [],
        },
      ]);
      setComposer("");
      setStreamingIds((prev) => new Set(prev).add(id));
      setDrafts((prev) => new Map(prev).set(id, ""));
      await invoke("chat_send", { conversationId: id, model, content: text });
    } catch {
      if (conversationId !== null) {
        const id = conversationId;
        setStreamingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setDrafts((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }
      setInlineError("No se ha podido enviar el mensaje. Vuelve a intentarlo.");
      void refreshConversations();
    }
  }, [composer, streamingActive, ensureConversation, model, refreshConversations]);

  const sendImage = useCallback(async (): Promise<void> => {
    const prompt = composer.trim();
    if (!prompt || imageGeneratingActive) return;
    setSessionExpired(false);
    setInlineError("");
    let conversationId: number | null = null;
    try {
      conversationId = await ensureConversation();
      if (conversationId === null) return;
      const id = conversationId;
      setImageGeneratingIds((prev) => new Set(prev).add(id));
      setComposer("");
      await invoke("image_generate", { conversationId: id, prompt, size: imageSize });
    } catch (err) {
      if (conversationId !== null) {
        const id = conversationId;
        setImageGeneratingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
      setInlineError(commandErrorLabel(err));
      void refreshConversations();
    }
  }, [composer, imageGeneratingActive, ensureConversation, imageSize, refreshConversations]);

  // Auto-scroll to the newest content.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeDraft, activeActivity, streamingActive, imageGeneratingActive]);

  const confirmComputerWide = useCallback(async (): Promise<void> => {
    setAskComputerWide(false);
    await workspace.enableComputerWide();
  }, [workspace]);

  const submit = (): void => {
    void (imageMode ? sendImage() : send());
  };

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Conversaciones">
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <BrandMark size={22} />
            <Wordmark />
          </div>
          <button type="button" className="btn btn-primary new-chat-btn" onClick={newChat}>
            <IconPlus size={16} />
            Nueva conversación
          </button>
        </div>
        <nav className="conv-list" aria-label="Historial">
          {conversations.length === 0 && (
            <p className="conv-empty">Tus conversaciones aparecerán aquí.</p>
          )}
          {conversations.map((c) => {
            const armed = pendingDeleteId === c.id;
            return (
              <div
                key={c.id}
                className={`conv-item${c.id === activeConvId && view === "chat" ? " active" : ""}`}
              >
                <button
                  type="button"
                  className="conv-main"
                  onClick={() => selectConversation(c.id)}
                  title={c.title}
                  aria-current={c.id === activeConvId ? "page" : undefined}
                >
                  <span className="conv-title">{c.title}</span>
                </button>
                <button
                  type="button"
                  className={`conv-delete${armed ? " armed" : ""}`}
                  aria-label={
                    armed
                      ? `Pulsa otra vez para borrar «${c.title}» para siempre`
                      : `Borrar la conversación «${c.title}»`
                  }
                  title={armed ? "Pulsa otra vez para borrar" : "Borrar"}
                  onClick={() => confirmDeleteConversation(c.id)}
                >
                  {armed ? "¿Borrar?" : <IconTrash size={15} />}
                </button>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <span className="account-dot" aria-hidden="true" />
          <span className="account-name">
            {activeProfile ? profileTitle(activeProfile.id, activeProfile.name) : "Sin cuenta"}
          </span>
        </div>
      </aside>

      {view === "settings" ? (
        <Settings
          profile={activeProfile}
          workspace={workspace}
          voice={voice}
          onVoiceChange={setVoice}
          onAskComputerWide={() => setAskComputerWide(true)}
          onBack={() => setView("chat")}
          onSignOut={onSignOut}
          signingOut={busy}
        />
      ) : (
        <section className="chat-main">
          {sessionExpired && (
            <div className="banner" role="alert">
              <span>Tu sesión ha caducado. Vuelve a entrar para seguir.</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut}>
                Volver a entrar
              </button>
            </div>
          )}
          <header className="chat-header">
            <label className="model-picker">
              <span className="visually-hidden">Modelo</span>
              <select
                value={model}
                onChange={(e) => setModel(e.currentTarget.value)}
                aria-label="Modelo del asistente"
              >
                {(models.length > 0 ? models : [model]).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <IconChevronDown size={14} />
            </label>
            <button
              type="button"
              className="icon-btn"
              aria-label="Ajustes"
              title="Ajustes"
              onClick={() => setView("settings")}
            >
              <IconGear size={19} />
            </button>
          </header>

          <div className="messages" ref={messagesRef}>
            <div className="messages-inner">
              {messages.length === 0 && activeDraft === undefined && (
                <div className="empty-state">
                  <BrandMark size={40} />
                  <p className="empty-title">¿En qué puedo ayudarte?</p>
                  <p className="empty-hint">
                    Escribe tu mensaje abajo. Intro envía; Mayús + Intro añade una línea.
                  </p>
                </div>
              )}
              {messages.map((m) =>
                m.role === "assistant" ? (
                  m.media_path ? (
                    <article key={m.id} className="msg msg-assistant">
                      <img className="msg-image" src={convertFileSrc(m.media_path)} alt={m.content} />
                      <p className="image-caption">{m.content}</p>
                    </article>
                  ) : (
                    <article
                      key={m.id}
                      className={`msg msg-assistant${speakingMsgId === m.id ? " speaking" : ""}`}
                    >
                      <Markdown text={m.content} />
                      {m.partial && (
                        <p className="partial-note" role="note">
                          La respuesta se interrumpió.
                        </p>
                      )}
                      <SourceChips sources={m.sources ?? []} />
                      {m.content.trim().length > 0 && (
                        <div className="msg-actions">
                          <button
                            type="button"
                            className={`msg-action${speakingMsgId === m.id ? " active" : ""}`}
                            onClick={() => void toggleSpeak(m)}
                          >
                            {speakingMsgId === m.id ? <IconStop size={14} /> : <IconSpeaker size={14} />}
                            {speakingMsgId === m.id ? "Detener" : "Escuchar"}
                          </button>
                        </div>
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
                <article className="msg msg-assistant streaming" aria-live="polite">
                  {activeDraft.length > 0 && <Markdown text={activeDraft} />}
                  {activeActivity ? (
                    <p className="activity" role="status">
                      {activeActivity === "searching" ? <IconGlobe size={15} /> : <IconFolder size={15} />}
                      {ACTIVITY_COPY[activeActivity] ?? ""}
                    </p>
                  ) : activeDraft.length === 0 ? (
                    <p className="activity" role="status">
                      <span className="pulse-dot" aria-hidden="true" />
                      Pensando…
                    </p>
                  ) : (
                    <span className="caret" aria-hidden="true" />
                  )}
                </article>
              )}
              {imageGeneratingActive && (
                <article className="msg msg-assistant" role="status">
                  <p className="activity">
                    <span className="pulse-dot" aria-hidden="true" />
                    Creando la imagen… suele tardar alrededor de un minuto.
                  </p>
                </article>
              )}
              {ttsHint && (
                <p className="inline-error" role="status">
                  {ttsHint}
                </p>
              )}
              {inlineError && (
                <p className="inline-error" role="alert">
                  {inlineError}
                </p>
              )}
            </div>
          </div>

          <footer className="composer">
            <div className={`composer-box${imageMode ? " image-mode" : ""}`}>
              <textarea
                ref={composerRef}
                className="composer-input"
                value={composer}
                onChange={(e) => setComposer(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  sttBusy
                    ? "Transcribiendo…"
                    : imageMode
                      ? "Describe la imagen que quieres crear"
                      : "Escribe tu mensaje"
                }
                aria-label={imageMode ? "Descripción de la imagen" : "Mensaje"}
                rows={2}
                disabled={composerBusy}
              />
              <div className="composer-bar">
                <WorkspaceChip
                  workspace={workspace}
                  onAskComputerWide={() => setAskComputerWide(true)}
                  onOpenSettings={() => setView("settings")}
                />
                <div className="composer-tools">
                  {imageMode && (
                    <label className="size-picker">
                      <span className="visually-hidden">Formato de la imagen</span>
                      <select
                        value={imageSize}
                        onChange={(e) => setImageSize(e.currentTarget.value)}
                        aria-label="Formato de la imagen"
                      >
                        {IMAGE_SIZES.map((size) => (
                          <option key={size.id} value={size.id}>
                            {size.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    className={`icon-btn${imageMode ? " active" : ""}`}
                    aria-pressed={imageMode}
                    aria-label={imageMode ? "Volver a escribir mensajes" : "Crear una imagen"}
                    title={imageMode ? "Volver a escribir mensajes" : "Crear una imagen"}
                    onClick={() => setImageMode((value) => !value)}
                    disabled={composerBusy}
                  >
                    <IconImage size={18} />
                  </button>
                  <button
                    type="button"
                    className={`icon-btn${recording ? " recording" : ""}`}
                    aria-label={recording ? "Terminar el dictado" : "Dictar por voz"}
                    title={recording ? "Terminar el dictado" : "Dictar por voz"}
                    onClick={() => void toggleRecording()}
                    disabled={sttBusy || composerBusy}
                  >
                    {recording ? <IconStop size={18} /> : <IconMic size={18} />}
                  </button>
                  {imageGeneratingActive ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancelImage()}>
                      <IconStop size={14} />
                      Cancelar
                    </button>
                  ) : streamingActive ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void stopGenerating()}>
                      <IconStop size={14} />
                      Detener
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="send-btn"
                      onClick={submit}
                      disabled={composer.trim().length === 0}
                      aria-label={imageMode ? "Crear imagen" : "Enviar"}
                      title={imageMode ? "Crear imagen" : "Enviar"}
                    >
                      <IconArrowUp size={18} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {(sttHint || workspace.error) && (
              <p className="composer-hint" role="status">
                {sttHint || workspace.error}
              </p>
            )}
          </footer>
        </section>
      )}

      {askComputerWide && (
        <ComputerWideDialog
          onCancel={() => setAskComputerWide(false)}
          onContinue={() => void confirmComputerWide()}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// App state machine
// ---------------------------------------------------------------------------

function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [overview, setOverview] = useState<ProfileOverview | null>(null);
  const [pickerError, setPickerError] = useState("");
  const [busy, setBusy] = useState(false);

  // Device-flow login state.
  const [authProfileId, setAuthProfileId] = useState<string | null>(null);
  const [authPhase, setAuthPhase] = useState<AuthPhase>("waiting");
  const [userCode, setUserCode] = useState("");
  const [errorKind, setErrorKind] = useState("");
  const authProfileRef = useRef<string | null>(null);
  useEffect(() => {
    authProfileRef.current = authProfileId;
  }, [authProfileId]);

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
    } catch {
      setScreen("error");
    }
  }, [refreshOverview]);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Rust → frontend sign-in events. Registered once; cleanup on unmount.
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [
      listen<DeviceStarted>("device://started", (event) => {
        setUserCode(event.payload.user_code);
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
          .catch(() => setScreen("error"));
      }),
      listen("device://denied", () => setAuthPhase("denied")),
      listen("device://expired", () => setAuthPhase("expired")),
      listen<DeviceError>("device://error", (event) => {
        setErrorKind(event.payload.kind);
        setAuthPhase("error");
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        void promise.then((unlisten) => unlisten());
      });
    };
  }, [refreshOverview]);

  const startLogin = useCallback(async (profileId: string): Promise<void> => {
    setBusy(true);
    setPickerError("");
    // Track the flow from before the request so no early event is missed.
    setAuthProfileId(profileId);
    setAuthPhase("waiting");
    setUserCode("");
    setErrorKind("");
    try {
      await invoke("device_login_start", { profileId });
      setScreen("authorizing");
    } catch {
      setAuthProfileId(null);
      setPickerError("No hemos podido iniciar el acceso. Revisa tu conexión y vuelve a intentarlo.");
    } finally {
      setBusy(false);
    }
  }, []);

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
    } catch {
      setScreen("error");
    } finally {
      setBusy(false);
    }
  }, [overview, refreshOverview]);

  if (screen === "loading") {
    return (
      <CenterScreen>
        <BrandHero />
        <p className="status-line" role="status">
          <span className="pulse-dot" aria-hidden="true" />
          Cargando…
        </p>
      </CenterScreen>
    );
  }

  if (screen === "error") {
    return (
      <CenterScreen>
        <BrandHero />
        <h1>Algo no ha ido bien</h1>
        <p className="lede">No hemos podido abrir tu cuenta en este equipo. Vuelve a intentarlo.</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => void boot()}>
            Volver a intentarlo
          </button>
        </div>
      </CenterScreen>
    );
  }

  if (screen === "authorizing" && authProfileId) {
    const profile = overview?.profiles.find((p) => p.id === authProfileId);
    return (
      <Authorizing
        profileName={profileTitle(authProfileId, profile?.name ?? authProfileId)}
        userCode={userCode}
        phase={authPhase}
        errorKind={errorKind}
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

  return <ChatShell overview={overview} busy={busy} onSignOut={() => void signOut()} />;
}

export default App;
