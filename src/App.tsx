import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";
import { BrandLogo, BrandMark } from "./brand";
import {
  initialNudgeState,
  loadShownNudges,
  nudgeReducer,
  saveShownNudges,
  targetForPath,
  type Nudge,
} from "./chat/allowNudge";
import { approvalsReducer, placeCards, type ApprovalCardState } from "./chat/approvals";
import { lastProducedTarget } from "./chat/autoOpen";
import { rowsForDisplay, titleFromFirstMessage, withConversation } from "./chat/conversationList";
import { messageFiles } from "./chat/filePaths";
import {
  adoptSelection,
  loadSelections,
  pruneSelection,
  saveSelections,
  selectionFor,
  type Selections,
} from "./chat/folderSelection";
import { stripToolMarkup } from "./chat/toolMarkup";
import { AllowNudgeCard } from "./components/AllowNudgeCard";
import { ApprovalCard } from "./components/ApprovalCard";
import { ChatImage } from "./components/ChatImage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FolderPicker } from "./components/FolderPicker";
import { LanguageScreen } from "./components/LanguageScreen";
import { SaveImageButton, type SaveImageResult } from "./components/SaveImageButton";
import { Toast, type ToastNotice } from "./components/Toast";
import { UpdateBanner, UPDATE_CHECK_INTERVAL_MS } from "./components/UpdateBanner";
import { UserMenu, type SettingsPane, type SettingsSection } from "./components/UserMenu";
import {
  DEFAULT_IMAGE_SIZE,
  IMAGE_SIZES,
  VOICE_STORAGE_KEY,
  chatErrorLabel,
  commandErrorLabel,
  editErrorLabel,
  folderName,
  grantErrorLabel,
  hostOf,
  imageErrorLabel,
  profileDescription,
  profileTitle,
  signInErrorLabel,
  storedVoice,
} from "./copy";
import {
  checkForUpdate,
  installUpdate,
  onApprovalRequest,
  onApprovalResolved,
  onNativeDecision,
  respondToApproval,
  sendChat,
  type UpdateInfo,
} from "./core";
import { VOICE_UI } from "./flags";
import { useI18n, useT, type Strings } from "./i18n";
import {
  IconArrowUp,
  IconUser,
  IconBolt,
  IconChevronDown,
  IconFile,
  IconFolder,
  IconGlobe,
  IconMemory,
  IconMic,
  IconPanel,
  IconImage,
  IconPlus,
  IconSparkles,
  IconSpeaker,
  IconStop,
  IconTrash,
  IconWarning,
  IconX,
} from "./icons";
import { Markdown } from "./Markdown";
import { targetKey, type PreviewTarget } from "./preview/kind";
import { Settings } from "./Settings";
import type {
  ChatMessageRow,
  ConversationView,
  ProfileOverview,
  ProfileView,
  WebSource,
} from "./types";
import type { StudioSeed } from "./studio/studio";
import { SkillPicker } from "./skills/SkillPicker";
import { SkillsView } from "./skills/SkillsView";
import {
  EMPTY_VIEW,
  TEAM_PROFILE,
  fetchIdentity,
  fetchSkillsSharing,
  isTeamSkillId,
  loadCache,
  planNextSync,
  setLink,
  syncTeam,
  teamAsSkill,
  teamLibrary,
  usableTeamSkills,
  type TeamMeta,
  type TeamState,
} from "./skills/team";
import {
  activeSkillFor,
  adoptActiveSkill,
  draftFromConversation,
  emptyDraft,
  filterSkills,
  listSkills,
  slashQuery,
  upsertSkill,
  withActiveSkill,
  withoutSkill,
  type ActiveSkills,
  type Skill,
  type SkillDraft,
} from "./skills/skills";
import { useWorkspace } from "./workspace";

// The preview pane and its renderers load on first use (S21).
const PreviewPane = lazy(() => import("./preview/PreviewPane"));
// So does the Image Studio (its own view).
const ImageStudio = lazy(() => import("./studio/ImageStudio").then((m) => ({ default: m.ImageStudio })));

// The renderer never sees profile URLs, API keys or session tokens (S4/S12):
// profiles arrive as {id, name, has_key, key_mask} from the Rust core, and
// all HTTP (sign-in, chat streaming, web search, memory sync, web preview)
// happens in Rust. Chat arrives as delta/done/error/activity events only.

// Device-flow payloads (Rust core -> renderer): only non-secret fields.
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
  activity: "searching" | "working" | "generating_image" | null;
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

// Preview state key for a chat that has no conversation row yet.
const NEW_CHAT_KEY = -1;

// Round 14 (S2): the Settings surface lists its sections in the sidebar that
// normally holds the chats, and shows one section at a time. Order is the
// reading order of the owner's reference; Account comes first because it is
// where "about" and sign out live.
const SETTINGS_SECTIONS: readonly SettingsPane[] = ["account", "folders", "memory", "language", "skills"];

/// The sidebar text of a Settings section (existing keys, no new copy).
function settingsSectionLabel(t: Strings, section: SettingsPane): string {
  switch (section) {
    case "account":
      return t.userMenu.account;
    case "folders":
      return t.settings.folders.title;
    case "memory":
      return t.settings.memory.title;
    case "language":
      return t.settings.language.title;
    case "skills":
      return t.skills.title;
  }
}

/// The sidebar glyph of a Settings section (the same icon set as the rail).
function SettingsSectionIcon({ section }: { section: SettingsPane }) {
  switch (section) {
    case "account":
      return <IconUser size={16} />;
    case "folders":
      return <IconFolder size={16} />;
    case "memory":
      return <IconMemory size={16} />;
    case "language":
      return <IconGlobe size={16} />;
    case "skills":
      return <IconBolt size={16} />;
  }
}

/// A copy of `set` without `key` (state updates never mutate).
function withoutKey(set: Set<number>, key: number): Set<number> {
  const next = new Set(set);
  next.delete(key);
  return next;
}

type Screen = "loading" | "error" | "picker" | "authorizing" | "chat";
type AuthPhase = "waiting" | "denied" | "expired" | "error";

interface PreviewState {
  target: PreviewTarget;
  open: boolean;
}

/// Citation chips under an answer that used the built-in web search. They
/// open the preview pane; the pane links out to the browser.
function SourceChips({ sources, onOpen }: { sources: WebSource[]; onOpen: (url: string) => void }) {
  const t = useT();
  if (sources.length === 0) return null;
  return (
    <div className="sources" aria-label={t.chat.sources}>
      <span className="sources-label">{t.chat.sources}</span>
      <ul>
        {sources.map((source, index) => (
          <li key={source.url}>
            <button type="button" className="source-chip" title={source.url} onClick={() => onOpen(source.url)}>
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

/// Chips for local files the assistant mentions (inside working folders).
function FileChips({ paths, onOpen }: { paths: string[]; onOpen: (path: string) => void }) {
  const t = useT();
  if (paths.length === 0) return null;
  return (
    <div className="sources" aria-label={t.chat.files}>
      <span className="sources-label">{t.chat.files}</span>
      <ul>
        {paths.map((path) => (
          <li key={path}>
            <button
              type="button"
              className="source-chip file-chip"
              title={path}
              aria-label={`${t.preview.open}: ${folderName(path)}`}
              onClick={() => onOpen(path)}
            >
              <IconFile size={13} />
              <span className="source-title">{folderName(path)}</span>
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
  const t = useT();
  return (
    <div className="brand-hero">
      <BrandLogo label={t.app.name} />
    </div>
  );
}

export function ProfilePicker({
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
  const t = useT();
  return (
    <CenterScreen>
      <BrandHero />
      <h1>{t.login.title}</h1>
      <p className="lede">{t.login.choose}</p>
      <div className="profile-cards">
        {overview.profiles.map((p) => (
          <button key={p.id} type="button" className="profile-card" onClick={() => onPick(p.id)} disabled={busy}>
            <span className="profile-card-text">
              <strong>{profileTitle(t, p.id, p.name)}</strong>
              <span>{profileDescription(t, p.id)}</span>
              {p.has_key && <span className="profile-card-meta">{t.login.signedInBefore}</span>}
            </span>
            <span className="profile-card-arrow" aria-hidden="true">
              →
            </span>
          </button>
        ))}
      </div>
      <p className="hint">{t.login.hint}</p>
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
  const t = useT();
  const [copied, setCopied] = useState(false);
  const waiting = phase === "waiting";
  const headline =
    phase === "denied"
      ? t.login.deniedTitle
      : phase === "expired"
        ? t.login.expiredTitle
        : phase === "error"
          ? t.login.failedTitle
          : t.login.confirmTitle;

  return (
    <CenterScreen>
      <BrandHero />
      <p className="eyebrow">{profileName}</p>
      <h1>{headline}</h1>
      {waiting ? (
        <>
          <p className="lede">{t.login.confirmBody}</p>
          <div className="device-code-row">
            <div className="device-code" aria-label={t.login.codeLabel}>
              {userCode || "····-····"}
            </div>
            {userCode ? (
              <button
                type="button"
                className="btn btn-ghost code-copy"
                aria-label={t.login.copyCode}
                title={t.login.copyCode}
                onClick={() => {
                  void navigator.clipboard.writeText(userCode);
                  setCopied(true);
                }}
              >
                {copied ? "✓" : "⧉"}
              </button>
            ) : null}
          </div>
          <p className="status-line" role="status">
            <span className="pulse-dot" aria-hidden="true" />
            {t.login.waiting}
          </p>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              {t.app.cancel}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="lede">
            {phase === "denied" && t.login.deniedBody}
            {phase === "expired" && t.login.expiredBody}
            {phase === "error" && signInErrorLabel(t, errorKind)}
          </p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={onTryAgain}>
              {t.app.tryAgain}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onPickAnother}>
              {t.login.pickAnother}
            </button>
          </div>
        </>
      )}
    </CenterScreen>
  );
}

// ---------------------------------------------------------------------------
// Whole-computer confirmation (the composer folder picker opens it)
// ---------------------------------------------------------------------------

/// Plain-language warning before the whole-computer mode. Continuing asks
/// the Rust core, which shows its own native confirmation: this dialog
/// explains, the native one decides (the renderer cannot grant anything).
function ComputerWideDialog({ onCancel, onContinue }: { onCancel: () => void; onContinue: () => void }) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Focus once on open; re-renders of the shell must not steal focus back.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Round 14 (B1/B2): an open dialog is the innermost surface and
        // consumes Escape, so the surface behind it stays where it is.
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
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
        <h2 id="cw-title">{t.computerWide.title}</h2>
        <div id="cw-body">
          <ul className="modal-points">
            <li>{t.computerWide.point1}</li>
            <li>{t.computerWide.point2}</li>
            <li>{t.computerWide.point3}</li>
            <li>{t.computerWide.point4}</li>
          </ul>
          <p className="modal-note">{t.computerWide.note}</p>
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onCancel}>
            {t.app.cancel}
          </button>
          <button type="button" className="btn btn-warn-solid" onClick={onContinue}>
            {t.computerWide.continue}
          </button>
        </div>
      </div>
    </div>
  );
}

function ApprovalCards({
  cards,
  onRespond,
}: {
  cards: ApprovalCardState[] | undefined;
  onRespond: (id: string, granted: boolean) => void;
}) {
  if (!cards || cards.length === 0) return null;
  return (
    <>
      {cards.map((card) => (
        <ApprovalCard key={card.id} card={card} onRespond={onRespond} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Chat shell
// ---------------------------------------------------------------------------

function ChatShell({ overview, busy, onSignOut }: { overview: ProfileOverview; busy: boolean; onSignOut: () => void }) {
  const t = useT();
  const activeProfile: ProfileView | undefined = overview.profiles.find((p) => p.id === overview.active_profile);
  const workspace = useWorkspace(overview.active_profile);

  const [view, setView] = useState<"chat" | "settings" | "studio">("chat");
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  // Which Settings section the surface shows (the sidebar picks it).
  const [settingsSection, setSettingsSection] = useState<SettingsPane>("account");
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
  // One install at a time, shared by the banner and the user menu: the busy
  // state lives here so the two surfaces cannot start a second install.
  const [installing, setInstalling] = useState(false);
  const startInstall = useCallback(async (): Promise<void> => {
    if (installing) return;
    setInstalling(true);
    try {
      await installUpdate();
    } finally {
      setInstalling(false);
    }
  }, [installing]);

  // Round 14/S1: the newer version the updater found. ONE check feeds the
  // banner and the user menu, so a dismissed banner never hides the update.
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null);

  // Inline approval cards (S14) and per-conversation preview pane (S21).
  const [approvals, dispatchApproval] = useReducer(approvalsReducer, [] as ApprovalCardState[]);
  const [previews, setPreviews] = useState<Map<number, PreviewState>>(() => new Map());

  // Per-conversation folder selection (composer picker): none by default.
  const [selections, setSelections] = useState<Selections>(loadSelections);
  useEffect(() => saveSelections(selections), [selections]);
  const selectionsRef = useRef(selections);
  useEffect(() => {
    selectionsRef.current = selections;
  }, [selections]);
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  });

  // Allow-mode suggestion: one per conversation, remembered across runs.
  const [nudges, dispatchNudge] = useReducer(nudgeReducer, undefined, () => initialNudgeState(loadShownNudges()));
  useEffect(() => saveShownNudges(nudges.shown), [nudges.shown]);
  const countedApprovals = useRef<Set<string>>(new Set());

  // Image mode: the composer sends the prompt to `image_generate`. It is a
  // per-conversation setting (round 4): switching chats shows that chat's
  // own mode; the unsaved new chat uses NEW_CHAT_KEY until its row exists.
  const [imageModes, setImageModes] = useState<Set<number>>(() => new Set());
  const imageMode = imageModes.has(activeConvId ?? NEW_CHAT_KEY);
  const [imageSize, setImageSize] = useState(DEFAULT_IMAGE_SIZE);
  const [imageGeneratingIds, setImageGeneratingIds] = useState<Set<number>>(() => new Set());

  // Local skills (T14/S1). `activeSkills` is the skill turned on per
  // conversation (the blank chat uses NEW_CHAT_KEY until its row exists);
  // only its id travels with `chat_send`, the core adds the text. The
  // picker opens from the "Use skill" button or a leading "/".
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoadError, setSkillsLoadError] = useState(false);
  const [skillForm, setSkillForm] = useState<SkillDraft | null>(null);
  const [activeSkills, setActiveSkills] = useState<ActiveSkills>(() => new Map());
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);

  // Shared skills (S4, Helmcode only; the community has no orgs): the team
  // library as the core caches it plus the last sync problem, and the org's
  // `skills_sharing` flag (the share actions). A team skill turns on like a
  // local one; its id is `team:<id>` and the core reads the cached bundle.
  const teamProfile = overview.active_profile === TEAM_PROFILE ? TEAM_PROFILE : null;
  const [teamState, setTeamState] = useState<TeamState>({ view: EMPTY_VIEW, problem: null });
  const [skillsSharing, setSkillsSharing] = useState(false);
  const teamSkills = useMemo(() => teamLibrary(teamState.view).map(teamAsSkill), [teamState.view]);
  const pickerSkills = useMemo(() => [...skills, ...usableTeamSkills(teamState.view)], [skills, teamState.view]);
  const knownSkills = useMemo(() => [...skills, ...teamSkills], [skills, teamSkills]);
  const activeSkill = activeSkillFor(activeSkills, activeConvId ?? NEW_CHAT_KEY, knownSkills);

  // Image edits happen in the Image Studio, its own view. `studio` is the
  // current session (null until first opened); the Studio stays mounted
  // while hidden so an edit in flight still lands in its history. A new
  // `key` starts a fresh session. `editingIds` tracks which running image
  // jobs are edits (chat copy and error labels); `studioJobsRef` which of
  // them the Studio reports itself (the chat does not repeat its errors).
  // While a Studio edit runs (`studioBusy`), switching conversations or
  // starting another Studio session is paused so the result and any error
  // land in the open Studio session (no lost work).
  // Image generation, editing and the Studio are offered on BOTH profiles:
  // each tenant's platform serves them to desktop sessions only (desktop
  // routes server-side), and the plan is enforced there (403
  // tier_restricted, 404 not_available when a route is not mounted).
  const [studio, setStudio] = useState<{ key: number; seed: StudioSeed } | null>(null);
  const studioReturnRef = useRef<"chat" | "settings">("chat");
  const studioJobsRef = useRef<Set<number>>(new Set());
  const [studioBusy, setStudioBusy] = useState(false);
  /// Forget a Studio job; true when it was one. Keeps `studioBusy` in sync.
  const endStudioJob = useCallback((conversationId: number): boolean => {
    const had = studioJobsRef.current.delete(conversationId);
    setStudioBusy(studioJobsRef.current.size > 0);
    return had;
  }, []);
  const [editingIds, setEditingIds] = useState<Set<number>>(() => new Set());
  // The ref is updated synchronously so the image event handlers always know
  // whether the job that just ended was an edit.
  const editingIdsRef = useRef(editingIds);
  const markEditing = useCallback((conversationId: number, editing: boolean): void => {
    const next = new Set(editingIdsRef.current);
    if (editing) next.add(conversationId);
    else next.delete(conversationId);
    editingIdsRef.current = next;
    setEditingIds(next);
  }, []);

  // Voice: read-aloud + dictation (hidden this round, S24).
  const [voice, setVoice] = useState<string>(storedVoice);
  const [speakingMsgId, setSpeakingMsgId] = useState<number | null>(null);
  // Round 6: transient notice (the outcome of "Save as…" on an image).
  const [notice, setNotice] = useState<ToastNotice | null>(null);
  const dismissNotice = useCallback((): void => setNotice(null), []);
  const onImageSaved = useCallback(
    (result: SaveImageResult): void =>
      setNotice({
        id: Date.now(),
        kind: result.kind === "saved" ? "success" : "error",
        text: result.kind === "saved" ? t.chat.imageSaved(result.path) : t.chat.imageSaveFailed,
      }),
    [t],
  );
  const [ttsHint, setTtsHint] = useState("");
  const [recording, setRecording] = useState(false);
  const [sttBusy, setSttBusy] = useState(false);
  const [sttHint, setSttHint] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);

  // Round 13: the signed-in user's email for the bottom-left chip. Fetched on
  // profile change; a miss keeps the platform label (both tenants answer
  // /api/auth/me, but a session that cannot read it must not break the chip).
  const [userEmail, setUserEmail] = useState<{ [profileId: string]: string }>({});
  useEffect(() => {
    const profileId = overview.active_profile;
    if (!profileId) return;
    let alive = true;
    fetchIdentity(profileId).then(({ email }) => {
      if (!alive || !email) return;
      setUserEmail((prev) => (prev[profileId] === email ? prev : { ...prev, [profileId]: email }));
    });
    return () => {
      alive = false;
    };
  }, [overview.active_profile]);
  const activeProfileRef = useRef<string | null>(overview.active_profile);
  useEffect(() => {
    activeProfileRef.current = overview.active_profile;
  }, [overview.active_profile]);
  const activeConvRef = useRef<number | null>(activeConvId);
  useEffect(() => {
    activeConvRef.current = activeConvId;
  }, [activeConvId]);
  const messageCountRef = useRef(0);
  useEffect(() => {
    messageCountRef.current = messages.length;
  }, [messages]);
  const streamingIdsRef = useRef(streamingIds);
  useEffect(() => {
    streamingIdsRef.current = streamingIds;
  }, [streamingIds]);

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
      // A conversation still streaming (the user switched away and back)
      // shows its live draft, not the core's in-progress copy of it.
      setMessages(rowsForDisplay(rows, streamingIdsRef.current.has(conversationId)));
    } catch {
      setMessages([]);
    }
  }, []);

  // A reply (or a composer image) just finished in `conversationId`: reload
  // its rows and open what it produced in that conversation's preview pane
  // (round 4 auto-open; see chat/autoOpen.ts). Works for a conversation the
  // user is not looking at too: the pane is open when they come back.
  const reloadAfterReply = useCallback(async (conversationId: number): Promise<void> => {
    let rows: ChatMessageRow[];
    try {
      rows = await invoke<ChatMessageRow[]>("messages_list", { conversationId });
    } catch {
      if (activeConvRef.current === conversationId) setMessages([]);
      return;
    }
    if (activeConvRef.current === conversationId) setMessages(rows);
    const target = lastProducedTarget(rows);
    if (target) setPreviews((prev) => new Map(prev).set(conversationId, { target, open: true }));
  }, []);

  // Account memory: reconcile with the account in the background. Silent
  // by design: any failure keeps the local copy; nothing is ever shown.
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

  // Local skills: listed once; every save/delete updates the list in place.
  useEffect(() => {
    let alive = true;
    listSkills()
      .then((list) => {
        if (!alive) return;
        setSkills(list);
        setSkillsLoadError(false);
      })
      .catch(() => {
        if (alive) setSkillsLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Auto-update (round 7): a silent check on startup and every 6 hours. The
  // result is kept here (round 14/S1) so the user menu can offer "Update"
  // after the banner is dismissed; the banner is given this same check and
  // the same install flow, so there is one update path, not two.
  const runUpdateCheck = useCallback(async (): Promise<UpdateInfo | null> => {
    try {
      const found = await checkForUpdate();
      setAvailableUpdate(found);
      return found;
    } catch {
      // Silent by design: dev builds, offline and a missing release feed.
      setAvailableUpdate(null);
      return null;
    }
  }, []);

  useEffect(() => {
    void runUpdateCheck();
    const timer = window.setInterval(() => void runUpdateCheck(), UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [runUpdateCheck]);

  // Team library (S4): one sync now, then again when the previous round is
  // due, and whenever the Skills view opens. ETag-conditional, so a quiet
  // sync is a 304. The cached copy shows first (offline "Use" keeps working).
  // Round 14/S3: a round stopped by a rate limit or an expired session left
  // the rows listed with no bundles on disk, so it retries in a minute
  // instead of waiting the full 15 minutes.
  const syncTeamLibrary = useCallback(async (): Promise<TeamState | null> => {
    const profileId = activeProfileRef.current;
    if (profileId !== TEAM_PROFILE) return null;
    const [next, sharing] = await Promise.all([
      syncTeam(profileId).catch(() => null),
      fetchSkillsSharing(profileId),
    ]);
    if (activeProfileRef.current !== profileId) return next;
    setSkillsSharing(sharing);
    if (!next) return null;
    setTeamState(next);
    if (next.problem === "expired") setSessionExpired(true);
    return next;
  }, []);

  useEffect(() => {
    if (!teamProfile) {
      setTeamState({ view: EMPTY_VIEW, problem: null });
      setSkillsSharing(false);
      return;
    }
    let alive = true;
    let timer = 0;
    let failures = 0;

    function scheduleNext(state: TeamState | null): void {
      const plan = planNextSync(state?.problem ?? null, failures);
      failures = plan.failures;
      timer = window.setTimeout(() => void runRound(), plan.delayMs);
    }

    async function runRound(): Promise<void> {
      const state = await syncTeamLibrary();
      if (alive) scheduleNext(state);
    }

    loadCache(teamProfile)
      .then((view) => {
        if (alive) setTeamState((prev) => (prev.view === EMPTY_VIEW ? { view, problem: null } : prev));
      })
      .catch(() => {});
    void runRound();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [teamProfile, syncTeamLibrary]);

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
      void reloadAfterReply(conversationId);
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
          setInlineError(kind);
        }
        void refreshConversations();
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        void promise.then((unlisten) => unlisten());
      });
    };
  }, [reloadAfterReply, refreshConversations, syncMemory]);

  // Approval transport (S14): the core asks, the card answers in place.
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [
      onApprovalRequest((incoming) => {
        // A request the core did not tie to a conversation belongs to the
        // one on screen (otherwise its card would never render and the
        // request would silently expire as a deny).
        const request = { ...incoming, conversation_id: incoming.conversation_id ?? activeConvRef.current };
        const anchorIndex = activeConvRef.current === request.conversation_id ? messageCountRef.current : null;
        dispatchApproval({ type: "request", request, anchorIndex });
      }),
      onApprovalResolved((resolved) => {
        dispatchApproval({ type: "resolved", id: resolved.approval_id, granted: resolved.granted });
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        void promise.then((unlisten) => unlisten());
      });
    };
  }, []);

  const respondApproval = useCallback(async (id: string, granted: boolean): Promise<void> => {
    dispatchApproval({ type: "sending", id });
    try {
      await respondToApproval(id, granted);
      dispatchApproval({ type: "resolved", id, granted });
    } catch {
      dispatchApproval({ type: "failed", id });
    }
  }, []);

  // Allow-mode suggestion inputs: every answered card counts once (the
  // card can be resolved both by the answer and by the core's event), and
  // native decisions (computer-wide) arrive as their own event. Actions
  // count towards the conversation's SELECTED folders only.
  const nudgeDecision = useCallback(
    (conversationId: number, path: string | null, granted: boolean): void => {
      const ws = workspaceRef.current;
      const selected = selectionFor(selectionsRef.current, conversationId);
      const folders = ws.folders.filter((grant) => selected.includes(grant.id));
      dispatchNudge({
        type: "decision",
        conversationId,
        target: targetForPath(path, folders, ws.computerWide),
        granted,
        anchorIndex: activeConvRef.current === conversationId ? messageCountRef.current : Number.MAX_SAFE_INTEGER,
      });
    },
    [],
  );

  useEffect(() => {
    for (const card of approvals) {
      if (card.status !== "granted" && card.status !== "denied") continue;
      if (countedApprovals.current.has(card.id)) continue;
      countedApprovals.current.add(card.id);
      if (card.conversationId === null) continue;
      nudgeDecision(card.conversationId, card.cwd ?? card.target, card.status === "granted");
    }
  }, [approvals, nudgeDecision]);

  useEffect(() => {
    const unlisten = onNativeDecision((decision) => {
      const conversationId = decision.conversation_id ?? activeConvRef.current;
      if (conversationId !== null) nudgeDecision(conversationId, decision.path, decision.granted);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [nudgeDecision]);

  const allowFromNudge = useCallback(
    async (nudge: Nudge): Promise<void> => {
      if (nudge.target.kind !== "folder") return;
      const conversationId = nudge.conversationId;
      dispatchNudge({ type: "switching", conversationId });
      // The core asks for its own native confirmation; trust what it stored.
      const stored = await workspace.setMode(nudge.target.grantId, "allow");
      dispatchNudge(stored === "allow" ? { type: "allowed", conversationId } : { type: "dismiss", conversationId });
    },
    [workspace],
  );

  // Image event transport: the core persists the row before `done`.
  useEffect(() => {
    const markGenerating = (conversationId: number, generating: boolean): void => {
      setImageGeneratingIds((prev) => {
        const next = new Set(prev);
        if (generating) next.add(conversationId);
        else next.delete(conversationId);
        return next;
      });
      if (!generating) {
        markEditing(conversationId, false);
        endStudioJob(conversationId);
      }
    };
    const unlistens: Promise<UnlistenFn>[] = [
      listen<ChatIdPayload>("images://started", (event) => {
        markGenerating(event.payload.conversation_id, true);
      }),
      listen<ChatIdPayload>("images://done", (event) => {
        const conversationId = event.payload.conversation_id;
        markGenerating(conversationId, false);
        void reloadAfterReply(conversationId);
        void refreshConversations();
        void syncMemory();
      }),
      listen<ImagesError>("images://error", (event) => {
        const { conversation_id, kind } = event.payload;
        // Read before markGenerating clears it: edits get their own copy.
        const prefix = editingIdsRef.current.has(conversation_id) ? "edit" : "image";
        // Studio edits report their errors only in the Studio (it stays
        // mounted, so the error is there when the user comes back).
        const studioJob = endStudioJob(conversation_id);
        markGenerating(conversation_id, false);
        if (kind === "unauthorized") {
          setSessionExpired(true);
        } else if (!studioJob && activeConvRef.current === conversation_id) {
          setInlineError(`${prefix}:${kind}`);
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
  }, [reloadAfterReply, refreshConversations, syncMemory, markEditing, endStudioJob]);

  // Voice transport: one global playback.
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [
      listen("tts://ended", () => setSpeakingMsgId(null)),
      listen<TtsError>("tts://error", (event) => {
        setSpeakingMsgId(null);
        setTtsHint(`chat:${event.payload.kind}`);
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
      if (studioJobsRef.current.size > 0) return;
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
          setTtsHint(`cmd:${String(err)}`);
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
        setTtsHint(`cmd:${String(err)}`);
      }
    },
    [speakingMsgId, voice],
  );

  const finishRecording = useCallback(
    async (chunks: Blob[], mimeType: string): Promise<void> => {
      const profileId = activeProfileRef.current;
      if (!profileId) return;
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      if (blob.size === 0) {
        setSttHint(t.chat.sttEmpty);
        return;
      }
      if (blob.size > MAX_STT_BYTES) {
        setSttHint(t.chat.sttTooLong);
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
          setSttHint(t.chat.sttNotUnderstood);
        }
      } catch (err) {
        setSttHint(commandErrorLabel(t, err));
      } finally {
        setSttBusy(false);
      }
    },
    [t],
  );

  const toggleRecording = useCallback(async (): Promise<void> => {
    setSttHint("");
    if (recording) {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setRecording(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === "undefined") {
      setSttHint(t.chat.sttUnavailable);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = RECORDING_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
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
      setSttHint(t.chat.sttNoPermission);
    }
  }, [recording, finishRecording, t]);

  const newChat = useCallback((): void => {
    if (studioJobsRef.current.size > 0) return;
    setView("chat");
    setActiveConvId(null);
    setMessages([]);
    setInlineError("");
    setSessionExpired(false);
    setPreviews((prev) => {
      const next = new Map(prev);
      next.delete(NEW_CHAT_KEY);
      return next;
    });
    // A new conversation starts with no folder selected and in text mode.
    setSelections((prev) => {
      const next = { ...prev };
      delete next[String(NEW_CHAT_KEY)];
      return next;
    });
    setImageModes((prev) => withoutKey(prev, NEW_CHAT_KEY));
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
      dispatchApproval({ type: "clearConversation", conversationId });
      dispatchNudge({ type: "clearConversation", conversationId });
      setSelections((prev) => {
        const next = { ...prev };
        delete next[String(conversationId)];
        return next;
      });
      setPreviews((prev) => {
        const next = new Map(prev);
        next.delete(conversationId);
        return next;
      });
      setImageModes((prev) => withoutKey(prev, conversationId));
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
      if (studioJobsRef.current.has(conversationId)) return;
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
  const visibleDraft = activeDraft !== undefined ? stripToolMarkup(activeDraft, { streaming: true }) : undefined;
  const activeActivity = activeConvId !== null ? activities.get(activeConvId) : undefined;
  const imageGeneratingActive = activeConvId !== null && imageGeneratingIds.has(activeConvId);
  const composerBusy = streamingActive || imageGeneratingActive;

  // Preview pane (S21): one state per conversation.
  const previewKey = activeConvId ?? NEW_CHAT_KEY;
  const preview = previews.get(previewKey);
  const openPreview = useCallback((target: PreviewTarget): void => {
    const key = activeConvRef.current ?? NEW_CHAT_KEY;
    setPreviews((prev) => new Map(prev).set(key, { target, open: true }));
  }, []);
  const openWebPreview = useCallback((url: string) => openPreview({ kind: "web", ref: url }), [openPreview]);
  const openFilePreview = useCallback((path: string) => openPreview({ kind: "file", ref: path }), [openPreview]);
  const setPreviewOpen = useCallback((open: boolean): void => {
    const key = activeConvRef.current ?? NEW_CHAT_KEY;
    setPreviews((prev) => {
      const current = prev.get(key);
      if (!current) return prev;
      return new Map(prev).set(key, { ...current, open });
    });
  }, []);
  const closePreview = useCallback(() => setPreviewOpen(false), [setPreviewOpen]);
  // "Remove from preview" on an image: the pane forgets it (no reopen
  // toggle until something else is opened). The file itself is untouched.
  const removeFromPreview = useCallback((): void => {
    const key = activeConvRef.current ?? NEW_CHAT_KEY;
    setPreviews((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // Image mode toggles for the open conversation only.
  const toggleImageMode = useCallback((): void => {
    const key = activeConvRef.current ?? NEW_CHAT_KEY;
    setImageModes((prev) => {
      if (prev.has(key)) return withoutKey(prev, key);
      return new Set(prev).add(key);
    });
  }, []);

  // Image Studio: every entry point starts a fresh session, except the
  // sidebar entry, which resumes the current one (or opens an empty Studio).
  // While a Studio edit runs, every entry point resumes the running session
  // instead (a new session would drop the edit's result).
  const openStudio = useCallback((seed: StudioSeed | null): void => {
    if (viewRef.current !== "studio") studioReturnRef.current = viewRef.current === "settings" ? "settings" : "chat";
    if (seed && studioJobsRef.current.size === 0) setStudio((prev) => ({ key: (prev?.key ?? 0) + 1, seed }));
    else setStudio((prev) => prev ?? { key: 1, seed: { conversationId: null, base: null, stagePath: null } });
    setView("studio");
  }, []);
  const closeStudio = useCallback((): void => setView(studioReturnRef.current), []);

  // "Edit image" on a chat image: the Studio opens on it; results land in
  // the same conversation as children of that message.
  const startEdit = useCallback(
    (messageId: number, path: string, label: string): void => {
      openStudio({
        conversationId: activeConvRef.current,
        base: { path, label, messageId, staged: false },
        stagePath: null,
      });
    },
    [openStudio],
  );

  // "Edit image" in the preview pane: an app image opens directly (linked
  // to its chat message when it is one); a user file is staged first.
  const editFromPreview = useCallback(
    (target: PreviewTarget): void => {
      if (target.kind === "media") {
        const row = messages.find(
          (m) => m.media_path === target.ref || (m.artifacts ?? []).some((a) => a.path === target.ref),
        );
        const label = row && row.media_path === target.ref ? row.content : folderName(target.ref);
        openStudio({
          conversationId: activeConvRef.current,
          base: { path: target.ref, label, messageId: row?.id ?? null, staged: false },
          stagePath: null,
        });
      } else if (target.kind === "file") {
        openStudio({ conversationId: activeConvRef.current, base: null, stagePath: target.ref });
      }
    },
    [messages, openStudio],
  );

  // A Studio session without a conversation gets its own on the first edit.
  const createStudioConversation = useCallback(
    async (title: string): Promise<number | null> => {
      const profileId = activeProfileRef.current;
      if (!profileId) return null;
      const created = await invoke<number>("conversation_create", { profileId });
      setConversations((prev) => withConversation(prev, created, titleFromFirstMessage(title)));
      return created;
    },
    [],
  );

  const onStudioJob = useCallback(
    (conversationId: number, running: boolean): void => {
      markEditing(conversationId, running);
      if (running) {
        studioJobsRef.current.add(conversationId);
        setStudioBusy(true);
        setImageGeneratingIds((prev) => new Set(prev).add(conversationId));
      } else {
        endStudioJob(conversationId);
        setImageGeneratingIds((prev) => withoutKey(prev, conversationId));
      }
    },
    [markEditing, endStudioJob],
  );

  const fileRoots: string[] | "any" = workspace.computerWide
    ? "any"
    : workspace.folders.map((grant) => grant.canonical_path);

  // The open conversation's folder selection (only folders that exist).
  const selectedFolders = pruneSelection(selectionFor(selections, activeConvId ?? NEW_CHAT_KEY), workspace.folders);
  const changeSelection = useCallback((grantIds: string[]): void => {
    const key = String(activeConvRef.current ?? NEW_CHAT_KEY);
    setSelections((prev) => ({ ...prev, [key]: grantIds }));
  }, []);

  // Stop: abort the stream; what already arrived stays persisted.
  const stopGenerating = useCallback(async (): Promise<void> => {
    const conversationId = activeConvRef.current;
    if (conversationId === null) return;
    try {
      await invoke("chat_stop", { conversationId });
    } catch (err) {
      setInlineError(`cmd:${String(err)}`);
    }
  }, []);

  const cancelImage = useCallback(async (): Promise<void> => {
    const conversationId = activeConvRef.current;
    if (conversationId === null) return;
    try {
      await invoke("image_cancel", { conversationId });
    } catch (err) {
      setInlineError(`cmd:${String(err)}`);
      return;
    }
    setImageGeneratingIds((prev) => {
      const next = new Set(prev);
      next.delete(conversationId);
      return next;
    });
    markEditing(conversationId, false);
  }, [markEditing]);

  const ensureConversation = useCallback(async (): Promise<number | null> => {
    const profileId = activeProfileRef.current;
    if (!profileId) return null;
    if (activeConvRef.current !== null) return activeConvRef.current;
    const created = await invoke<number>("conversation_create", { profileId });
    activeConvRef.current = created;
    setActiveConvId(created);
    // Carry a preview opened on the blank chat over to the new row.
    setPreviews((prev) => {
      const pending = prev.get(NEW_CHAT_KEY);
      if (!pending) return prev;
      const next = new Map(prev);
      next.delete(NEW_CHAT_KEY);
      next.set(created, pending);
      return next;
    });
    // ...and the folders picked on the blank chat, and its image mode.
    setSelections((prev) => adoptSelection(prev, NEW_CHAT_KEY, created));
    setImageModes((prev) => {
      if (!prev.has(NEW_CHAT_KEY)) return prev;
      const next = withoutKey(prev, NEW_CHAT_KEY);
      next.add(created);
      return next;
    });
    // ...and the skill turned on there.
    setActiveSkills((prev) => adoptActiveSkill(prev, NEW_CHAT_KEY, created));
    return created;
  }, []);

  const send = useCallback(async (): Promise<void> => {
    const text = composer.trim();
    if (!text || streamingActive) return;
    setSessionExpired(false);
    setInlineError("");
    let conversationId: number | null = null;
    // The open conversation's folders (read before a new row adopts them).
    const grantIds = selectedFolders;
    // ...and its skill: only the id is sent; the core reads the text.
    const skillId = activeSkill?.id ?? null;
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
      // Round 5: a new chat is listed (streaming) right away, so switching
      // away mid-reply never hides it; the refresh after `chat_send` swaps
      // in the core's stored title and ordering.
      setConversations((prev) => withConversation(prev, id, titleFromFirstMessage(text)));
      await sendChat({ conversationId: id, model, content: text, grantIds, ...(skillId ? { skillId } : {}) });
      void refreshConversations();
    } catch (err) {
      // The skill was deleted elsewhere: nothing was sent or stored. Turn it
      // off and give the text back so the user can resend.
      if (skillId && String(err).startsWith("skill:")) {
        const key = conversationId ?? NEW_CHAT_KEY;
        setActiveSkills((prev) => withActiveSkill(withActiveSkill(prev, key, null), NEW_CHAT_KEY, null));
        setSkills((prev) => prev.filter((skill) => skill.id !== skillId));
        // A team skill revoked since the last sync: refresh the library.
        if (isTeamSkillId(skillId)) void syncTeamLibrary();
        setComposer(text);
        if (conversationId !== null) {
          const id = conversationId;
          setStreamingIds((prev) => withoutKey(prev, id));
          setDrafts((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
          void loadMessages(id);
        }
        setInlineError("skill");
        void refreshConversations();
        return;
      }
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
      setInlineError("send");
      void refreshConversations();
    }
  }, [composer, streamingActive, ensureConversation, model, refreshConversations, selectedFolders, activeSkill, loadMessages, syncTeamLibrary]);

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
      setConversations((prev) => withConversation(prev, id, titleFromFirstMessage(prompt)));
      await invoke("image_generate", { conversationId: id, prompt, size: imageSize });
      void refreshConversations();
    } catch (err) {
      if (conversationId !== null) {
        const id = conversationId;
        setImageGeneratingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
      setInlineError(`image:${String(err)}`);
      void refreshConversations();
    }
  }, [composer, imageGeneratingActive, ensureConversation, imageSize, refreshConversations]);

  // Auto-scroll to the newest content.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeDraft, activeActivity, streamingActive, imageGeneratingActive, approvals, nudges.active]);

  const confirmComputerWide = useCallback(async (): Promise<void> => {
    setAskComputerWide(false);
    await workspace.enableComputerWide();
  }, [workspace]);

  // Settings' Back returns to where it was opened from: the Studio (its
  // grant refusal's "Open Settings") or the chat. `null` asks for the first
  // section (Account), which is what the menu's own "Settings" entry means.
  const [settingsReturn, setSettingsReturn] = useState<"chat" | "studio">("chat");
  const openSettings = useCallback((target: SettingsSection): void => {
    if (viewRef.current !== "settings") setSettingsReturn(viewRef.current === "studio" ? "studio" : "chat");
    // Never a Back loop (Studio -> Settings -> Studio -> Settings...).
    if (viewRef.current === "studio" && studioReturnRef.current === "settings") studioReturnRef.current = "chat";
    setSettingsSection(target ?? "account");
    setView("settings");
  }, []);
  const openFolderSettings = useCallback((): void => openSettings("folders"), [openSettings]);

  // Leaving Settings returns to where it was opened from. The chat pane is
  // unmounted while Settings is open (its state lives here, so the open
  // conversation and the composer survive), hence the focus comes back in an
  // effect once it is mounted again: the entry point is the composer, the
  // same as when the Skills view returned to the chat.
  const focusChatOnReturn = useRef(false);
  const settingsNavRef = useRef<HTMLElement | null>(null);
  const leaveSettings = useCallback((): void => {
    focusChatOnReturn.current = settingsReturn === "chat";
    setView(settingsReturn);
  }, [settingsReturn]);
  useEffect(() => {
    if (view !== "chat" || !focusChatOnReturn.current) return;
    focusChatOnReturn.current = false;
    composerRef.current?.focus();
  }, [view]);

  // Entering Settings puts the keyboard in the section list: the menu item
  // that opened it is gone with the chat sidebar.
  useEffect(() => {
    if (view !== "settings") return;
    settingsNavRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
  }, [view]);

  // Round 14 (C2): Escape leaves Settings from ANY section (Account, Folders,
  // Memory, Language, Skills alike). Inner surfaces register their own Escape
  // handler in the capture phase and call preventDefault (B1/B2), so only the
  // innermost thing closes and this handler never fires for them.
  useEffect(() => {
    if (view !== "settings") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key !== "Escape") return;
      leaveSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, leaveSettings]);

  const submit = (): void => {
    void (imageMode ? sendImage() : send());
  };

  // ---- skills -------------------------------------------------------------
  const slash = imageMode || slashDismissed ? null : slashQuery(composer);
  const pickerVisible = view === "chat" && (skillPickerOpen || slash !== null);
  const pickerItems = pickerVisible ? filterSkills(pickerSkills, slash ?? "") : [];
  const pickerActive = Math.min(pickerIndex, Math.max(pickerItems.length - 1, 0));

  const closeSkillPicker = useCallback((): void => {
    setSkillPickerOpen(false);
    setPickerIndex(0);
  }, []);

  /// Turn a skill on for the open conversation (picker, "/" or the list).
  const activateSkill = useCallback(
    (skill: Skill): void => {
      setActiveSkills((prev) => withActiveSkill(prev, activeConvRef.current ?? NEW_CHAT_KEY, skill.id));
      setSkillPickerOpen(false);
      setPickerIndex(0);
      // A "/query" typed to find it is not part of the message.
      setComposer((prev) => (slashQuery(prev) !== null ? "" : prev));
      setView("chat");
      composerRef.current?.focus();
    },
    [],
  );

  const deactivateSkill = useCallback((): void => {
    setActiveSkills((prev) => withActiveSkill(prev, activeConvRef.current ?? NEW_CHAT_KEY, null));
  }, []);

  const openSkills = useCallback(
    (form: SkillDraft | null): void => {
      setSkillPickerOpen(false);
      setSkillForm(form);
      openSettings("skills");
    },
    [openSettings],
  );

  const onSkillSaved = useCallback((saved: Skill): void => {
    setSkills((prev) => upsertSkill(prev, saved));
    setSkillsLoadError(false);
    setSkillForm(null);
  }, []);

  const onSkillDeleted = useCallback(
    (id: string): void => {
      setSkills((prev) => prev.filter((skill) => skill.id !== id));
      setActiveSkills((prev) => withoutSkill(prev, id));
      // The local copy is gone: forget its share link (the shared row, if
      // any, stays in the team library; an admin manages it there).
      if (teamProfile && teamState.view.links[id]) {
        setLink(teamProfile, id, null)
          .then((view) => setTeamState((prev) => ({ ...prev, view: { ...prev.view, links: view.links } })))
          .catch(() => {});
      }
    },
    [teamProfile, teamState.view.links],
  );

  /// "Use" on a team skill (its bundle is already cached by the view).
  const activateTeamSkill = useCallback((meta: TeamMeta): void => activateSkill(teamAsSkill(meta)), [activateSkill]);

  // Opening the Skills section refreshes the team library (a 304 when quiet).
  useEffect(() => {
    if (view === "settings" && settingsSection === "skills") void syncTeamLibrary();
  }, [view, settingsSection, syncTeamLibrary]);

  /// Composer keys while the skill picker is open: arrows move, Enter picks,
  /// Escape closes. Returns true when the key was handled.
  const pickerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!pickerVisible) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      if (slash !== null) setSlashDismissed(true);
      closeSkillPicker();
      return true;
    }
    if (pickerItems.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setPickerIndex((pickerActive + step + pickerItems.length) % pickerItems.length);
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      activateSkill(pickerItems[pickerActive]);
      return true;
    }
    return false;
  };

  // Errors are stored as kinds and localized here, so a language switch
  // re-renders them in the new language.
  const errorText = (code: string): string => {
    if (!code) return "";
    if (code === "send") return t.chat.sendFailed;
    if (code === "skill") return t.skills.errors.send;
    if (code.startsWith("image:")) return imageErrorLabel(t, code.slice("image:".length));
    if (code.startsWith("edit:")) return editErrorLabel(t, code.slice("edit:".length));
    if (code.startsWith("cmd:")) return commandErrorLabel(t, code.slice("cmd:".length));
    if (code.startsWith("chat:")) return chatErrorLabel(t, code.slice("chat:".length));
    return chatErrorLabel(t, code);
  };

  const profileLabel = activeProfile ? profileTitle(t, activeProfile.id, activeProfile.name) : t.sidebar.noAccount;
  const accountName = (activeProfile && userEmail[activeProfile.id]) || profileLabel;
  const placed = placeCards(approvals, activeConvId, messages.length);
  // The open conversation's allow-mode suggestion, anchored like the cards.
  const activeNudge = nudges.active.find((nudge) => nudge.conversationId === activeConvId);
  const nudgeSlot = activeNudge ? Math.min(activeNudge.anchorIndex, messages.length) : -1;
  const nudgeCard = activeNudge ? (
    <AllowNudgeCard
      nudge={activeNudge}
      folderName={activeNudge.target.kind === "folder" ? folderName(activeNudge.target.path) : ""}
      onAllow={() => void allowFromNudge(activeNudge)}
      onOpenSettings={() => openSettings("folders")}
      onDismiss={() => dispatchNudge({ type: "dismiss", conversationId: activeNudge.conversationId })}
    />
  ) : null;
  const workspaceError = grantErrorLabel(t, workspace.error);

  // The lineage link of an edited image: bring its original into view.
  const scrollToMessage = (messageId: number): void => {
    const target = document.getElementById(`msg-${messageId}`);
    target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };

  const renderMessage = (m: ChatMessageRow): ReactNode => {
    if (m.role !== "assistant") {
      return (
        <article className="msg msg-user">
          <p className="msg-user-text">{m.content}</p>
        </article>
      );
    }
    if (m.media_path) {
      const mediaPath = m.media_path;
      const parentId = m.parent_message_id ?? null;
      const parentShown = parentId !== null && messages.some((row) => row.id === parentId);
      return (
        <article className="msg msg-assistant" id={`msg-${m.id}`}>
          <ChatImage
            path={mediaPath}
            alt={m.content}
            onResult={onImageSaved}
            onEdit={() => startEdit(m.id, mediaPath, m.content)}
          />
          {parentId !== null && (
            <p className="edit-lineage">
              <span className="edit-badge">{t.chat.editedBadge}</span>
              {parentShown && (
                <button type="button" className="edit-parent-link" onClick={() => scrollToMessage(parentId)}>
                  {t.chat.viewOriginal}
                </button>
              )}
            </p>
          )}
          <p className="image-caption">{m.content}</p>
          <div className="msg-actions">
            <SaveImageButton path={m.media_path} onResult={onImageSaved} />
          </div>
        </article>
      );
    }
    const visible = stripToolMarkup(m.content);
    const files = messageFiles(visible, fileRoots, m.artifacts);
    // A row that was only tool markup has nothing to show (S16).
    if (
      visible.trim().length === 0 &&
      !m.partial &&
      (m.sources ?? []).length === 0 &&
      files.chips.length === 0 &&
      files.images.length === 0
    )
      return null;
    return (
      <article id={`msg-${m.id}`} className={`msg msg-assistant${speakingMsgId === m.id ? " speaking" : ""}`}>
        <Markdown text={visible} onOpenLink={openWebPreview} />
        {files.images.map((path) => (
          <figure key={path} className="msg-figure">
            <ChatImage
              path={path}
              alt={t.chat.generatedImage}
              onResult={onImageSaved}
              onEdit={() => startEdit(m.id, path, t.chat.generatedImage)}
            />
            <div className="msg-actions">
              <SaveImageButton path={path} onResult={onImageSaved} />
            </div>
          </figure>
        ))}
        {m.partial && (
          <p className="partial-note" role="note">
            {t.chat.interrupted}
          </p>
        )}
        <SourceChips sources={m.sources ?? []} onOpen={openWebPreview} />
        <FileChips paths={files.chips} onOpen={openFilePreview} />
        {VOICE_UI && visible.trim().length > 0 && (
          <div className="msg-actions">
            <button
              type="button"
              className={`msg-action${speakingMsgId === m.id ? " active" : ""}`}
              onClick={() => void toggleSpeak(m)}
            >
              {speakingMsgId === m.id ? <IconStop size={14} /> : <IconSpeaker size={14} />}
              {speakingMsgId === m.id ? t.chat.stop : t.chat.listen}
            </button>
          </div>
        )}
      </article>
    );
  };

  return (
    <main className="shell">
      {/* Round 14 (S2): inside Settings the same sidebar lists the sections
          instead of the chats, so the whole window becomes Settings. */}
      <aside className="sidebar" aria-label={view === "settings" ? t.settings.sections : t.sidebar.conversations}>
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <BrandMark size="sm" />
            <span className="sidebar-name">{t.app.name}</span>
          </div>
          {view !== "settings" && (
            <>
              <button
                type="button"
                className="btn btn-primary new-chat-btn"
                onClick={newChat}
                aria-disabled={studioBusy ? "true" : undefined}
                title={studioBusy ? t.sidebar.switchBlocked : undefined}
              >
                <IconPlus size={16} />
                {t.sidebar.newChat}
              </button>
              <button
                type="button"
                className={`sidebar-link${view === "studio" ? " active" : ""}`}
                aria-current={view === "studio" ? "page" : undefined}
                onClick={() => openStudio(null)}
              >
                <IconImage size={16} />
                {t.sidebar.studio}
              </button>
            </>
          )}
        </div>
        {view === "settings" ? (
          <nav className="settings-nav" aria-label={t.settings.sections} ref={settingsNavRef}>
            {SETTINGS_SECTIONS.map((section) => (
              <button
                key={section}
                type="button"
                className={`sidebar-link${settingsSection === section ? " active" : ""}`}
                aria-current={settingsSection === section ? "page" : undefined}
                onClick={() => setSettingsSection(section)}
              >
                <SettingsSectionIcon section={section} />
                {settingsSectionLabel(t, section)}
              </button>
            ))}
          </nav>
        ) : (
          <nav className="conv-list" aria-label={t.sidebar.history}>
            {conversations.length === 0 && <p className="conv-empty">{t.sidebar.empty}</p>}
            {conversations.map((c) => {
              const armed = pendingDeleteId === c.id;
              const live = streamingIds.has(c.id) || imageGeneratingIds.has(c.id);
              // A Studio edit writing to this conversation also locks its delete.
              const editLocked = studioBusy && studioJobsRef.current.has(c.id);
              return (
                <div
                  key={c.id}
                  className={`conv-item${c.id === activeConvId && view === "chat" ? " active" : ""}${live ? " streaming" : ""}`}
                >
                  <button
                    type="button"
                    className="conv-main"
                    onClick={() => selectConversation(c.id)}
                    aria-disabled={studioBusy ? "true" : undefined}
                    title={studioBusy ? t.sidebar.switchBlocked : c.title}
                    aria-current={c.id === activeConvId ? "page" : undefined}
                  >
                    <span className="conv-title">{c.title}</span>
                    {live && (
                      <>
                        <span className="pulse-dot" aria-hidden="true" />
                        {/* Inline spans concatenate in the accessible name:
                            the space keeps it "Fox Replying", not "FoxReplying". */}{" "}
                        <span className="visually-hidden">{t.sidebar.replying}</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`conv-delete${armed ? " armed" : ""}`}
                    aria-label={armed ? t.sidebar.deleteArmedLabel(c.title) : t.sidebar.deleteLabel(c.title)}
                    aria-disabled={editLocked ? "true" : undefined}
                    title={editLocked ? t.sidebar.switchBlocked : armed ? t.sidebar.deleteArmedTitle : t.sidebar.deleteTitle}
                    onClick={() => confirmDeleteConversation(c.id)}
                  >
                    {armed ? t.sidebar.deleteArmed : <IconTrash size={15} />}
                  </button>
                </div>
              );
            })}
          </nav>
        )}
        <div className="sidebar-bottom">
          <UserMenu
            accountName={accountName}
            accountDetail={activeProfile ? profileDescription(t, activeProfile.id) : ""}
            update={
              availableUpdate
                ? { version: availableUpdate.version, onUpdate: startInstall, busy: installing }
                : null
            }
            onOpenSettings={openSettings}
            onSignOut={onSignOut}
            signingOut={busy}
          />
        </div>
      </aside>

      {studio && overview.active_profile && (
        <ErrorBoundary
          resetKey={studio.key}
          fallback={
            view === "studio" ? (
              <section className="studio">
                <p className="inline-error" role="alert">
                  {t.studio.crashed}
                </p>
              </section>
            ) : null
          }
        >
          <Suspense fallback={view === "studio" ? <section className="studio" aria-busy="true" /> : null}>
            <ImageStudio
              key={studio.key}
              seed={studio.seed}
              profileId={overview.active_profile}
              active={view === "studio"}
              onClose={closeStudio}
              onCreateConversation={createStudioConversation}
              onJob={onStudioJob}
              onSaveResult={onImageSaved}
              onOpenSettings={openFolderSettings}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {view === "studio" ? null : view === "settings" ? (
        // The surface shows one section at a time; the section list in the
        // sidebar picks it. `data-section` is what App.css keys the visible
        // section off (see .settings-surface there).
        <div className="settings-surface" data-section={settingsSection}>
          {settingsSection === "skills" ? (
            <SkillsView
              skills={skills}
              loadError={skillsLoadError}
              form={skillForm}
              onFormChange={setSkillForm}
              onSaved={onSkillSaved}
              onDeleted={onSkillDeleted}
              onUse={activateSkill}
              onBack={leaveSettings}
              backLabel={settingsReturn === "studio" ? t.settings.backToStudio : t.settings.back}
              team={
                teamProfile
                  ? {
                      profileId: teamProfile,
                      sharing: skillsSharing,
                      state: teamState,
                      onState: setTeamState,
                      onRetry: () => void syncTeamLibrary(),
                      onUse: activateTeamSkill,
                      onSignIn: onSignOut,
                    }
                  : null
              }
            />
          ) : (
            <Settings
              profile={activeProfile}
              workspace={workspace}
              voice={voice}
              onVoiceChange={setVoice}
              onAskComputerWide={() => setAskComputerWide(true)}
              onBack={leaveSettings}
              backLabel={settingsReturn === "studio" ? t.settings.backToStudio : t.settings.back}
              onSignOut={onSignOut}
              signingOut={busy}
              focusSection={settingsSection}
              update={
                availableUpdate
                  ? { version: availableUpdate.version, onUpdate: startInstall, busy: installing }
                  : null
              }
            />
          )}
        </div>
      ) : (
        <ErrorBoundary
          resetKey={previewKey}
          fallback={
            <div className="chat-area">
              <section className="chat-main">
                <p className="inline-error" role="alert">
                  {t.preview.shellCrashed}
                </p>
              </section>
            </div>
          }
        >
        <div className={`chat-area${preview?.open ? " with-preview" : ""}`}>
          <section className="chat-main">
            {sessionExpired && (
              <div className="banner" role="alert">
                <span>{t.chat.sessionExpired}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut}>
                  {t.chat.signInAgain}
                </button>
              </div>
            )}
            <header className="chat-header">
              <label className="model-picker">
                <span className="visually-hidden">{t.chat.model}</span>
                <select value={model} onChange={(e) => setModel(e.currentTarget.value)} aria-label={t.chat.modelLabel}>
                  {(models.length > 0 ? models : [model]).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <IconChevronDown size={14} />
              </label>
              {messages.some((m) => (m.role === "user" || m.role === "system") && m.content.trim().length > 0) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm save-skill-btn"
                  onClick={() => openSkills(draftFromConversation(messages))}
                >
                  <IconBolt size={14} />
                  {t.skills.saveFromChat}
                </button>
              )}
              {preview && (
                <button
                  type="button"
                  className={`icon-btn${preview.open ? " active" : ""}`}
                  aria-pressed={preview.open}
                  aria-label={preview.open ? t.preview.close : t.preview.open}
                  title={preview.open ? t.preview.close : t.preview.open}
                  onClick={() => setPreviewOpen(!preview.open)}
                >
                  <IconPanel size={18} />
                </button>
              )}
            </header>
            <UpdateBanner check={runUpdateCheck} install={startInstall} externalBusy={installing} />

            <div className="messages" ref={messagesRef}>
              <div className="messages-inner">
                {messages.length === 0 && activeDraft === undefined && placed.tail.length === 0 && (
                  <div className="empty-state">
                    <BrandMark size="xl" />
                    <p className="empty-title">{t.chat.emptyTitle}</p>
                    <p className="empty-hint">{t.chat.emptyHint}</p>
                  </div>
                )}
                <ApprovalCards cards={placed.after.get(0)} onRespond={(id, g) => void respondApproval(id, g)} />
                {nudgeSlot === 0 && messages.length > 0 && nudgeCard}
                {messages.map((m, index) => (
                  <Fragment key={m.id}>
                    <ErrorBoundary
                      resetKey={m.id}
                      fallback={
                        <p className="inline-error" role="alert">
                          {t.preview.messageCrashed}
                        </p>
                      }
                    >
                      {renderMessage(m)}
                    </ErrorBoundary>
                    <ApprovalCards
                      cards={placed.after.get(index + 1)}
                      onRespond={(id, g) => void respondApproval(id, g)}
                    />
                    {nudgeSlot === index + 1 && index + 1 < messages.length && nudgeCard}
                  </Fragment>
                ))}
                <ApprovalCards cards={placed.tail} onRespond={(id, g) => void respondApproval(id, g)} />
                {nudgeSlot === messages.length && nudgeCard}
                {streamingActive && visibleDraft !== undefined && (
                  <article className="msg msg-assistant streaming" aria-live="polite">
                    {visibleDraft.length > 0 && <Markdown text={visibleDraft} onOpenLink={openWebPreview} />}
                    {activeActivity ? (
                      <p className="activity" role="status">
                        {activeActivity === "searching" ? (
                          <IconGlobe size={15} />
                        ) : activeActivity === "generating_image" ? (
                          <span className="pulse-dot" aria-hidden="true" />
                        ) : (
                          <IconFolder size={15} />
                        )}
                        {activeActivity === "searching"
                          ? t.chat.searching
                          : activeActivity === "generating_image"
                            ? t.chat.generatingImage
                            : t.chat.working}
                      </p>
                    ) : visibleDraft.length === 0 ? (
                      <p className="activity" role="status">
                        <span className="pulse-dot" aria-hidden="true" />
                        {t.chat.thinking}
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
                      {activeConvId !== null && editingIds.has(activeConvId) ? t.chat.editingImage : t.chat.generatingImage}
                    </p>
                  </article>
                )}
                {ttsHint && (
                  <p className="inline-error" role="status">
                    {errorText(ttsHint)}
                  </p>
                )}
                {inlineError && (
                  <p className="inline-error" role="alert">
                    {errorText(inlineError)}
                  </p>
                )}
              </div>
            </div>

            <footer className="composer">
              {activeSkill && (
                <div className="skill-pill-row">
                  <span className="skill-pill" role="status">
                    <IconBolt size={13} />
                    <span className="skill-pill-text">{t.skills.using(activeSkill.title)}</span>
                    <button
                      type="button"
                      className="skill-pill-x"
                      aria-label={t.skills.stopUsing(activeSkill.title)}
                      title={t.skills.stopUsing(activeSkill.title)}
                      onClick={deactivateSkill}
                    >
                      <IconX size={13} />
                    </button>
                  </span>
                </div>
              )}
              {pickerVisible && (
                <div className="skill-picker-anchor">
                  <SkillPicker
                    items={pickerItems}
                    hasSkills={pickerSkills.length > 0}
                    activeIndex={pickerActive}
                    onPick={activateSkill}
                    onCreate={() => openSkills(emptyDraft())}
                  />
                </div>
              )}
              <div className={`composer-box${imageMode ? " image-mode" : ""}`}>
                <textarea
                  ref={composerRef}
                  className="composer-input"
                  value={composer}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setComposer(value);
                    setPickerIndex(0);
                    if (!value.startsWith("/")) setSlashDismissed(false);
                  }}
                  onKeyDown={(e) => {
                    if (pickerKey(e)) return;
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={
                    sttBusy ? t.chat.placeholderTranscribing : imageMode ? t.chat.placeholderImage : t.chat.placeholder
                  }
                  aria-label={imageMode ? t.chat.imagePromptLabel : t.chat.messageLabel}
                  rows={2}
                  disabled={composerBusy}
                />
                <div className="composer-bar">
                  <FolderPicker
                    workspace={workspace}
                    selected={selectedFolders}
                    onChange={changeSelection}
                    onAskComputerWide={() => setAskComputerWide(true)}
                    onOpenSettings={() => openSettings("folders")}
                  />
                  <div className="composer-tools">
                    {imageMode && (
                      <label className="size-picker">
                        <span className="visually-hidden">{t.chat.imageSizeLabel}</span>
                        <select
                          value={imageSize}
                          onChange={(e) => setImageSize(e.currentTarget.value)}
                          aria-label={t.chat.imageSizeLabel}
                        >
                          {IMAGE_SIZES.map((size) => (
                            <option key={size} value={size}>
                              {t.imageSizes[size] ?? size}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {!imageMode && (
                      <button
                        type="button"
                        className={`icon-btn skill-toggle${pickerVisible ? " active" : ""}`}
                        aria-expanded={pickerVisible}
                        aria-label={t.skills.useSkill}
                        title={t.skills.useSkill}
                        onClick={() => {
                          if (!pickerVisible) {
                            setSkillPickerOpen(true);
                            return;
                          }
                          if (slash !== null) setSlashDismissed(true);
                          closeSkillPicker();
                        }}
                        disabled={composerBusy}
                      >
                        <IconBolt size={18} />
                      </button>
                    )}
                    <button
                      type="button"
                      className={`icon-btn image-toggle${imageMode ? " active" : ""}`}
                      aria-pressed={imageMode}
                      aria-label={imageMode ? t.chat.imageModeOff : t.chat.imageModeOn}
                      title={imageMode ? t.chat.imageModeOff : t.chat.imageModeOn}
                      onClick={toggleImageMode}
                      disabled={composerBusy}
                    >
                      <IconSparkles size={18} />
                    </button>
                    {VOICE_UI && (
                      <button
                        type="button"
                        className={`icon-btn${recording ? " recording" : ""}`}
                        aria-label={recording ? t.chat.stopDictation : t.chat.dictate}
                        title={recording ? t.chat.stopDictation : t.chat.dictate}
                        onClick={() => void toggleRecording()}
                        disabled={sttBusy || composerBusy}
                      >
                        {recording ? <IconStop size={18} /> : <IconMic size={18} />}
                      </button>
                    )}
                    {imageGeneratingActive ? (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancelImage()}>
                        <IconStop size={14} />
                        {t.chat.cancel}
                      </button>
                    ) : streamingActive ? (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void stopGenerating()}>
                        <IconStop size={14} />
                        {t.chat.stop}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="send-btn"
                        onClick={submit}
                        disabled={composer.trim().length === 0}
                        aria-label={imageMode ? t.chat.createImage : t.chat.send}
                        title={imageMode ? t.chat.createImage : t.chat.send}
                      >
                        <IconArrowUp size={18} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {(sttHint || workspaceError) && (
                <p className="composer-hint" role="status">
                  {sttHint || workspaceError}
                </p>
              )}
            </footer>
          </section>

          {/* Always mounted, so a failure while the pane renders OR while it
              unmounts (switching conversations) is caught here instead of
              blanking the whole window (round 4 post-PDF freeze). */}
          <ErrorBoundary
            resetKey={`${previewKey}|${preview?.open ? targetKey(preview.target) : "closed"}`}
            fallback={
              preview?.open ? (
                <aside className="preview-pane" aria-label={t.preview.title}>
                  <header className="preview-header">
                    <span className="preview-title">{t.preview.title}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={t.preview.close}
                      title={t.preview.close}
                      onClick={closePreview}
                    >
                      <IconX size={16} />
                    </button>
                  </header>
                  <p className="preview-note" role="alert">
                    {t.preview.crashed}
                  </p>
                </aside>
              ) : null
            }
          >
            {preview?.open && overview.active_profile && (
              <Suspense fallback={<aside className="preview-pane" aria-busy="true" />}>
                <PreviewPane
                  key={previewKey}
                  target={preview.target}
                  profileId={overview.active_profile}
                  onClose={closePreview}
                  onOpenLink={openWebPreview}
                  onEditImage={editFromPreview}
                  onRemove={removeFromPreview}
                />
              </Suspense>
            )}
          </ErrorBoundary>
        </div>
        </ErrorBoundary>
      )}

      {askComputerWide && (
        <ComputerWideDialog onCancel={() => setAskComputerWide(false)} onContinue={() => void confirmComputerWide()} />
      )}
      <Toast notice={notice} onDismiss={dismissNotice} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// App state machine
// ---------------------------------------------------------------------------

function App() {
  const { t, firstRun } = useI18n();
  const [screen, setScreen] = useState<Screen>("loading");
  const [overview, setOverview] = useState<ProfileOverview | null>(null);
  const [pickerError, setPickerError] = useState(false);
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

  const refreshOverview = useCallback(async (): Promise<ProfileOverview> => invoke<ProfileOverview>("profiles_load"), []);

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

  // Rust -> frontend sign-in events. Registered once; cleanup on unmount.
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
    setPickerError(false);
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
      setPickerError(true);
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

  // S19: the language comes first, before any tenant choice.
  if (firstRun) {
    return <LanguageScreen />;
  }

  if (screen === "loading") {
    return (
      <CenterScreen>
        <BrandHero />
        <p className="status-line" role="status">
          <span className="pulse-dot" aria-hidden="true" />
          {t.app.loading}
        </p>
      </CenterScreen>
    );
  }

  if (screen === "error") {
    return (
      <CenterScreen>
        <BrandHero />
        <h1>{t.app.errorTitle}</h1>
        <p className="lede">{t.app.errorBody}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => void boot()}>
            {t.app.tryAgain}
          </button>
        </div>
      </CenterScreen>
    );
  }

  if (screen === "authorizing" && authProfileId) {
    const profile = overview?.profiles.find((p) => p.id === authProfileId);
    return (
      <Authorizing
        profileName={profileTitle(t, authProfileId, profile?.name ?? authProfileId)}
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
        error={pickerError ? t.login.startError : ""}
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
