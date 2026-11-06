// Image Studio: a dedicated view for instruction-based image editing.
//
// Layout: a header (back, title, open another image, download), a tools bar
// over the canvas (zoom toggle, the brush and rectangle region tools and
// "Clear marks"), the canvas with the current base image and the marks
// overlay, a side panel (the image tray with the base locked first, the
// instruction and the one primary action) and the lineage history strip
// underneath. The X on the base closes the session (empty canvas, tray and
// history; the chat keeps every earlier result). A folder-grant refusal
// offers "Open Settings" on the working folders.
//
// Region tools (see `annotate.ts`): the marks stay on an overlay canvas
// above the image. An edit with marks composites them onto a COPY of the
// base (`image_edit_stage_annotation`), sends it as the second image
// (`annotationPath`) and appends a fixed pointer to the magenta area to the
// instruction. The marked copy is only an instruction vehicle: it never
// joins the history and the core deletes it when the edit ends.
//
// The Studio is UI over the existing edit core: `edit_images` runs the edit
// and persists the result as a chat message (so it also shows in the
// conversation), `image_edit_pick` / `image_edit_stage` stage user files
// through the folder grants, and every image is shown through the asset
// protocol (bytes never cross IPC).

import { useCallback, useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { GrantErrorCard } from "../components/GrantErrorCard";
import { useSaveImage, type SaveImageResult } from "../components/SaveImageButton";
import { editErrorLabel } from "../copy";
import { useT } from "../i18n";
import {
  IconArrowLeft,
  IconBrush,
  IconDownload,
  IconFit,
  IconImage,
  IconLock,
  IconPlus,
  IconSelection,
  IconTrash,
  IconX,
} from "../icons";
import type { ChatMessageRow, StagedEditSource } from "../types";
import {
  INITIAL_TOOL_STATE,
  annotatedInstruction,
  hasMarks,
  paintMarks,
  renderAnnotatedPng,
  reservedForSuffix,
  toImagePoint,
  toolReducer,
  type Tool,
} from "./annotate";
import {
  MAX_EDIT_INSTRUCTION,
  addReference,
  afterEdit,
  canSubmit,
  clearedSession,
  editModelFor,
  editSources,
  instructionLength,
  maxReferences,
  needsFolderGrant,
  regionToolsAvailable,
  removeReference,
  sendableReferences,
  type HistoryNode,
  type StudioImage,
  type StudioSeed,
  type StudioSession,
} from "./studio";

type Session = StudioSession;

interface Job {
  conversationId: number;
  instruction: string;
}

type Stage = "starting" | "uploading" | "saving";
type Zoom = "fit" | "actual";

function sessionFrom(seed: StudioSeed): Session {
  return {
    conversationId: seed.conversationId,
    base: seed.base,
    refs: [],
    history: seed.base ? [{ image: seed.base }] : [],
  };
}

function stagedImage(staged: StagedEditSource): StudioImage {
  return { path: staged.path, label: staged.name, messageId: null, staged: true };
}

function DownloadButton({ path, onResult }: { path: string; onResult: (result: SaveImageResult) => void }) {
  const t = useT();
  const { busy, save } = useSaveImage(path, onResult);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      title={t.studio.downloadLabel}
      aria-label={t.studio.downloadLabel}
      disabled={busy}
      aria-busy={busy}
      onClick={() => void save()}
    >
      <IconDownload size={15} />
      {t.studio.download}
    </button>
  );
}

/// Where the image sits inside the canvas box (for the overlay) and its own
/// pixel size (the overlay's resolution).
interface Layout {
  left: number;
  top: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

function layoutOf(img: HTMLImageElement): Layout {
  return {
    left: img.offsetLeft,
    top: img.offsetTop,
    width: img.offsetWidth,
    height: img.offsetHeight,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  };
}

function sameLayout(a: Layout | null, b: Layout): boolean {
  return (
    a !== null &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height &&
    a.naturalWidth === b.naturalWidth &&
    a.naturalHeight === b.naturalHeight
  );
}

export function ImageStudio({
  seed,
  profileId,
  active,
  onClose,
  onCreateConversation,
  onJob,
  onSaveResult,
  onOpenSettings,
}: {
  seed: StudioSeed;
  profileId: string;
  /// The Studio is the visible view. It stays mounted while hidden so an
  /// edit in flight still lands in its history.
  active: boolean;
  onClose: () => void;
  /// Creates the conversation the results land in (first edit of a Studio
  /// opened without one). Null when it could not be created.
  onCreateConversation: (title: string) => Promise<number | null>;
  /// An edit started (true) or ended (false) in `conversationId`.
  onJob: (conversationId: number, running: boolean) => void;
  onSaveResult: (result: SaveImageResult) => void;
  /// Opens Settings on the working folders (the grant refusal's action).
  onOpenSettings: () => void;
}) {
  const t = useT();
  const [session, setSession] = useState<Session>(() => sessionFrom(seed));
  const [instruction, setInstruction] = useState("");
  const [stage, setStage] = useState<Stage | null>(null);
  const [preparing, setPreparing] = useState(seed.base === null && seed.stagePath !== null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const instructionRef = useRef<HTMLTextAreaElement | null>(null);
  const chooseRef = useRef<HTMLButtonElement | null>(null);
  // Focus follows a removed base to the empty state's file picker.
  const focusChooseRef = useRef(false);
  const jobRef = useRef<Job | null>(null);
  const running = stage !== null;
  const { base, refs, history } = session;
  // The tray offers exactly what the tenant's edit model accepts: qwen
  // takes the base plus 2 references, FLUX the base alone.
  const model = editModelFor(profileId);
  const maxRefs = maxReferences(model);
  // Region tools: one active tool, the marks, the image's place on screen.
  const toolsAvailable = regionToolsAvailable(model);
  const [tools, dispatch] = useReducer(toolReducer, INITIAL_TOOL_STATE);
  const [layout, setLayout] = useState<Layout | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const annotated = toolsAvailable && hasMarks(tools.marks);
  const suffix = t.studio.annotationSuffix;
  const reserved = annotated ? reservedForSuffix(suffix) : 0;
  // The marked copy takes one of the model's image slots.
  const refsSent = sendableReferences(maxRefs, annotated);
  const basePath = base?.path ?? null;

  // A new base (history node, result, another file) starts unmarked.
  useEffect(() => {
    dispatch({ type: "reset" });
  }, [basePath]);

  const measure = useCallback((): void => {
    const img = imageRef.current;
    if (!img) return;
    const next = layoutOf(img);
    setLayout((prev) => (sameLayout(prev, next) ? prev : next));
  }, []);

  // The overlay follows the image: zoom, view switches and resizes.
  useEffect(() => {
    measure();
  }, [zoom, active, measure]);
  useEffect(() => {
    const img = imageRef.current;
    if (!img || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(img);
    if (img.parentElement) observer.observe(img.parentElement);
    return () => observer.disconnect();
  }, [basePath, measure]);

  // Paint the marks on the overlay (never on the image itself).
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !layout) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paintMarks(ctx, tools.marks);
  }, [tools.marks, layout]);

  // A user file shown in the preview pane: stage it first.
  useEffect(() => {
    if (seed.base !== null || seed.stagePath === null) return;
    let cancelled = false;
    invoke<StagedEditSource>("image_edit_stage", { profileId, path: seed.stagePath })
      .then((staged) => {
        if (cancelled) return;
        const image = stagedImage(staged);
        setSession((prev) => ({ ...prev, base: image, history: [{ image }] }));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setPreparing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seed, profileId]);

  // Focus the instruction whenever the Studio is shown.
  useEffect(() => {
    if (active) instructionRef.current?.focus();
  }, [active]);

  // Esc goes back to where the user came from.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);

  // The job's events end it in the chat shell too; only a failure before the
  // job started (no event will follow) is reported back through `onJob`.
  const endJob = useCallback((): void => {
    jobRef.current = null;
    setStage(null);
  }, []);

  // Image event transport, filtered to this Studio's own edit.
  useEffect(() => {
    const mine = (conversationId: number): Job | null =>
      jobRef.current?.conversationId === conversationId ? jobRef.current : null;
    const unlistens: Promise<UnlistenFn>[] = [
      listen<{ conversation_id: number; stage: string }>("images://progress", (event) => {
        if (!mine(event.payload.conversation_id)) return;
        const next = event.payload.stage;
        if (next === "uploading" || next === "saving") setStage(next);
      }),
      listen<{ conversation_id: number; media_path: string }>("images://done", (event) => {
        const { conversation_id: conversationId, media_path: mediaPath } = event.payload;
        const job = mine(conversationId);
        if (!job) return;
        endJob();
        // The core persisted the row before `done`: find it for the lineage.
        void invoke<ChatMessageRow[]>("messages_list", { conversationId })
          .then((rows) => rows.find((row) => row.media_path === mediaPath)?.id ?? null)
          .catch(() => null)
          .then((messageId) => {
            const result: StudioImage = { path: mediaPath, label: job.instruction, messageId, staged: false };
            setSession((prev) => ({ ...prev, ...afterEdit(prev.history, prev.refs, result) }));
            setInstruction((current) => (current.trim() === job.instruction ? "" : current));
          });
      }),
      listen<{ conversation_id: number; kind: string }>("images://error", (event) => {
        if (!mine(event.payload.conversation_id)) return;
        endJob();
        setError(event.payload.kind);
      }),
      listen<{ conversation_id: number }>("images://stopped", (event) => {
        if (!mine(event.payload.conversation_id)) return;
        endJob();
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        void promise.then((unlisten) => unlisten());
      });
    };
  }, [endJob]);

  const submit = useCallback(async (): Promise<void> => {
    const text = instruction.trim();
    if (!base || !canSubmit(base, text, running || preparing, reserved)) return;
    // Snapshot the marks: the edit sends what was on screen at Apply.
    const marks = annotated ? tools.marks : null;
    const size = layout ? { width: layout.naturalWidth, height: layout.naturalHeight } : null;
    setError("");
    setStage("starting");
    let conversationId = session.conversationId;
    try {
      if (marks && (!size || size.width <= 0 || size.height <= 0)) throw new Error("protocol");
      if (conversationId === null) {
        conversationId = await onCreateConversation(text);
        if (conversationId === null) throw new Error("protocol");
        const created = conversationId;
        setSession((prev) => ({ ...prev, conversationId: created }));
      }
      const sent = editSources(base, refs, refsSent);
      // The marked copy: the base with the marks on top, staged as a PNG.
      let annotationPath: string | null = null;
      if (marks && size) {
        const png = await renderAnnotatedPng(convertFileSrc(base.path), size, marks).catch(() => {
          throw new Error("protocol");
        });
        const staged = await invoke<StagedEditSource>("image_edit_stage_annotation", { profileId, pngBase64: png });
        annotationPath = staged.path;
      }
      jobRef.current = { conversationId, instruction: text };
      onJob(conversationId, true);
      await invoke("edit_images", {
        conversationId,
        parentMessageId: base.messageId,
        instruction: annotationPath ? annotatedInstruction(text, suffix) : text,
        sourcePaths: sent,
        ...(annotationPath ? { annotationPath } : {}),
      });
    } catch (err) {
      // Refused before the job started: no event will follow.
      if (conversationId !== null && jobRef.current) onJob(conversationId, false);
      endJob();
      // Keep the instruction and the tray so the user can fix and retry.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [
    instruction,
    base,
    refs,
    refsSent,
    reserved,
    annotated,
    tools.marks,
    layout,
    suffix,
    profileId,
    running,
    preparing,
    session.conversationId,
    onCreateConversation,
    onJob,
    endJob,
  ]);

  const pointAt = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!layout) return null;
    return toImagePoint(
      { x: e.clientX, y: e.clientY },
      e.currentTarget.getBoundingClientRect(),
      { width: layout.naturalWidth, height: layout.naturalHeight },
    );
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!tools.tool || running || e.button !== 0) return;
    const at = pointAt(e);
    if (!at) return;
    e.preventDefault();
    // Keep the drag even when the pointer leaves the image.
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // No capture (synthetic pointer): the drag still works over the image.
    }
    dispatch({ type: "down", point: at.point, scale: at.scale });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!tools.drag) return;
    const at = pointAt(e);
    if (at) dispatch({ type: "move", point: at.point });
  };
  const onPointerUp = (): void => dispatch({ type: "up" });
  const selectTool = (tool: Tool): void => {
    if (!toolsAvailable || running) return;
    dispatch({ type: "select", tool });
  };

  // The core answers with `images://stopped` (handled above).
  const cancel = useCallback(async (): Promise<void> => {
    const job = jobRef.current;
    if (!job) return;
    try {
      await invoke("image_cancel", { conversationId: job.conversationId });
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // The core's native picker, validated against the folder grants.
  const pick = useCallback(async (): Promise<StudioImage | null> => {
    setPicking(true);
    setError("");
    try {
      const staged = await invoke<StagedEditSource | null>("image_edit_pick", { profileId });
      return staged ? stagedImage(staged) : null;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setPicking(false);
    }
  }, [profileId]);

  /// A new base from a file: a fresh session (new conversation on the
  /// first edit, empty history and tray).
  const startFromFile = useCallback(async (): Promise<void> => {
    const image = await pick();
    if (!image) return;
    setSession({ conversationId: null, base: image, refs: [], history: [{ image }] });
    instructionRef.current?.focus();
  }, [pick]);

  const addRef = useCallback(async (): Promise<void> => {
    const image = await pick();
    if (image) setSession((prev) => ({ ...prev, refs: addReference(prev.refs, prev.base, image, maxRefs) }));
  }, [pick, maxRefs]);

  const removeRef = (path: string): void => {
    setSession((prev) => ({ ...prev, refs: removeReference(prev.refs, path) }));
  };

  /// The X on the base: closes this session and starts a fresh, empty one
  /// (empty canvas, tray and history; the next edit creates its own
  /// conversation). The earlier conversation stays in the chat as it was.
  const removeBase = (): void => {
    if (running) return;
    setSession(clearedSession());
    setError("");
    setLayout(null);
    dispatch({ type: "reset" });
    focusChooseRef.current = true;
  };

  useEffect(() => {
    if (base || !focusChooseRef.current) return;
    focusChooseRef.current = false;
    chooseRef.current?.focus();
  }, [base]);

  const selectNode = (node: HistoryNode): void => {
    if (running) return;
    setSession((prev) => ({ ...prev, base: node.image, refs: removeReference(prev.refs, node.image.path) }));
    instructionRef.current?.focus();
  };

  const busy = running || preparing || picking;
  const length = instructionLength(instruction);
  const errorText = !error
    ? ""
    : error === "unauthorized"
      ? t.chat.sessionExpired
      : editErrorLabel(t, error);
  const stageText =
    stage === "uploading" ? t.studio.stageUploading : stage === "saving" ? t.studio.stageSaving : t.studio.running;

  return (
    <section className="studio" aria-labelledby="studio-title" hidden={!active}>
      <header className="studio-header">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          <IconArrowLeft size={16} />
          {t.studio.back}
        </button>
        <h1 id="studio-title" className="studio-title">
          {t.studio.title}
        </h1>
        <div className="studio-header-actions">
          {base && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={t.studio.openImageLabel}
              onClick={() => void startFromFile()}
              disabled={busy}
            >
              <IconImage size={15} />
              {t.studio.openImage}
            </button>
          )}
          {base && !base.staged && <DownloadButton path={base.path} onResult={onSaveResult} />}
        </div>
      </header>

      <div className="studio-body">
        <div className="studio-stage">
          <div className="studio-toolbar" role="toolbar" aria-label={t.studio.toolsLabel}>
            <div className="studio-segmented" role="group" aria-label={t.studio.viewLabel}>
              <button
                type="button"
                className={`studio-seg${zoom === "fit" ? " active" : ""}`}
                aria-pressed={zoom === "fit"}
                onClick={() => setZoom("fit")}
                title={t.studio.fit}
              >
                <IconFit size={14} />
                {t.studio.fit}
              </button>
              <button
                type="button"
                className={`studio-seg${zoom === "actual" ? " active" : ""}`}
                aria-pressed={zoom === "actual"}
                onClick={() => setZoom("actual")}
                aria-label={t.studio.actualSize}
                title={t.studio.actualSize}
              >
                1:1
              </button>
            </div>
            <span className="studio-toolbar-sep" aria-hidden="true" />
            {(
              [
                ["brush", t.studio.toolBrush, t.studio.toolBrushHint, <IconBrush key="i" size={16} />],
                ["rect", t.studio.toolRegion, t.studio.toolRegionHint, <IconSelection key="i" size={16} />],
              ] as const
            ).map(([tool, name, hint, icon]) => {
              const pressed = tools.tool === tool;
              const label = toolsAvailable ? name : t.studio.toolUnavailable(name);
              return (
                <button
                  key={tool}
                  type="button"
                  className={`icon-btn studio-tool${pressed ? " active" : ""}`}
                  aria-pressed={toolsAvailable ? pressed : undefined}
                  aria-label={label}
                  title={toolsAvailable ? `${name}: ${hint}` : label}
                  disabled={!base || running || !toolsAvailable}
                  onClick={() => selectTool(tool)}
                >
                  {icon}
                </button>
              );
            })}
            {annotated && (
              <button
                type="button"
                className="btn btn-ghost btn-sm studio-clear"
                onClick={() => dispatch({ type: "clear" })}
                disabled={running}
              >
                <IconTrash size={14} />
                {t.studio.clearMarks}
              </button>
            )}
            {tools.tool && (
              <span className="studio-tool-hint" aria-live="polite">
                {tools.tool === "brush" ? t.studio.toolBrushHint : t.studio.toolRegionHint}
              </span>
            )}
          </div>

          <div
            className={`studio-canvas${zoom === "actual" ? " actual" : ""}${running ? " running" : ""}`}
            role="region"
            aria-label={t.studio.canvasLabel}
            aria-busy={running || preparing}
          >
            {base ? (
              <>
                <img
                  ref={imageRef}
                  className="studio-image"
                  src={convertFileSrc(base.path)}
                  alt={t.studio.canvasAlt(base.label)}
                  onLoad={measure}
                />
                {/* The marks layer: same box as the image, the image's own
                    resolution. Decorative for assistive tech (the tool
                    buttons and "Clear marks" carry the state). */}
                {layout && layout.naturalWidth > 0 && (
                  <canvas
                    ref={overlayRef}
                    className={`studio-overlay${tools.tool ? " drawing" : ""}`}
                    data-testid="studio-overlay"
                    aria-hidden="true"
                    width={layout.naturalWidth}
                    height={layout.naturalHeight}
                    style={{ left: layout.left, top: layout.top, width: layout.width, height: layout.height }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                  />
                )}
              </>
            ) : preparing ? (
              <p className="studio-note" role="status">
                {t.studio.preparing}
              </p>
            ) : (
              <div className="studio-empty">
                <IconImage size={28} />
                <h2>{t.studio.emptyTitle}</h2>
                <p className="studio-note">{t.studio.emptyHint}</p>
                <button
                  ref={chooseRef}
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void startFromFile()}
                  disabled={picking}
                  aria-busy={picking}
                >
                  {t.studio.chooseImage}
                </button>
              </div>
            )}
            {running && (
              <div className="studio-progress" role="status">
                <span className="pulse-dot" aria-hidden="true" />
                <span>
                  <strong>{stageText}</strong>
                  <span className="studio-progress-hint">{t.studio.runningHint}</span>
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="studio-panel">
          <section className="studio-refs" aria-labelledby="studio-refs-title">
            <div className="studio-panel-head">
              <h2 id="studio-refs-title">{t.studio.referencesTitle}</h2>
              {maxRefs > 0 && <span className="studio-count">{t.studio.referenceCount(refs.length, maxRefs)}</span>}
            </div>
            <p className="studio-hint">{maxRefs > 0 ? t.studio.referencesHint(maxRefs) : t.studio.baseOnlyHint}</p>
            <ul className="studio-tray">
              {base && (
                <li className="studio-thumb base" title={t.studio.baseLocked(base.label)}>
                  <img src={convertFileSrc(base.path)} alt={t.studio.baseLocked(base.label)} />
                  <span className="studio-thumb-badge">
                    <IconLock size={11} />
                    {t.studio.baseBadge}
                  </span>
                  <button
                    type="button"
                    className="studio-thumb-remove"
                    aria-label={t.studio.removeBase(base.label)}
                    title={t.studio.removeBase(base.label)}
                    onClick={removeBase}
                    disabled={running}
                  >
                    <IconX size={12} />
                  </button>
                </li>
              )}
              {refs.slice(0, maxRefs).map((ref, index) => (
                <li key={ref.path} className={`studio-thumb${index >= refsSent ? " unused" : ""}`}>
                  <img
                    src={convertFileSrc(ref.path)}
                    alt={ref.label}
                    title={index >= refsSent ? t.studio.referenceNotSent(ref.label) : ref.label}
                  />
                  <button
                    type="button"
                    className="studio-thumb-remove"
                    aria-label={t.studio.removeReference(ref.label)}
                    title={t.studio.removeReference(ref.label)}
                    onClick={() => removeRef(ref.path)}
                    disabled={running}
                  >
                    <IconX size={12} />
                  </button>
                </li>
              ))}
              {refs.length < maxRefs && (
                <li>
                  <button
                    type="button"
                    className="studio-thumb-add"
                    onClick={() => void addRef()}
                    disabled={!base || busy}
                    aria-busy={picking}
                    aria-label={t.studio.addReference}
                    title={t.studio.addReference}
                  >
                    <IconPlus size={16} />
                  </button>
                </li>
              )}
            </ul>
          </section>

          <section className="studio-instruction">
            <label htmlFor="studio-instruction-input" className="studio-label">
              {t.studio.instructionLabel}
            </label>
            <textarea
              id="studio-instruction-input"
              ref={instructionRef}
              className="studio-textarea"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder={t.studio.instructionPlaceholder}
              maxLength={MAX_EDIT_INSTRUCTION - reserved}
              aria-describedby="studio-instruction-meta"
              rows={5}
              readOnly={running}
            />
            <div id="studio-instruction-meta" className="studio-meta">
              <span>{t.studio.submitHint}</span>
              <span className="studio-counter">{t.studio.counter(length, MAX_EDIT_INSTRUCTION - reserved)}</span>
            </div>
            {annotated && (
              <p className="studio-hint studio-marked" role="status">
                {t.studio.marksActive}
              </p>
            )}
            {/* The error state survives hiding the Studio; the alert is only
                rendered while visible so it never leaks into the chat view. */}
            {active &&
              errorText &&
              (needsFolderGrant(error) ? (
                <GrantErrorCard message={errorText} onOpenSettings={onOpenSettings} />
              ) : (
                <p className="inline-error" role="alert">
                  {errorText}
                </p>
              ))}
            <div className="studio-actions">
              <button
                type="button"
                className="btn btn-primary studio-apply"
                onClick={() => void submit()}
                disabled={!canSubmit(base, instruction, busy, reserved)}
                aria-busy={running}
              >
                {running ? stageText : t.studio.apply}
              </button>
              {running && (
                <button type="button" className="btn btn-ghost" onClick={() => void cancel()}>
                  {t.studio.cancel}
                </button>
              )}
            </div>
          </section>
        </div>
      </div>

      {history.length > 0 && (
        <nav className="studio-history" aria-label={t.studio.historyLabel}>
          <ol>
            {history.map((node, index) => {
              const name = index === 0 ? t.studio.historyOriginal : t.studio.historyEdit(index);
              const current = base?.path === node.image.path;
              const label = t.studio.historyNode(name, node.image.label);
              return (
                <li key={`${index}:${node.image.path}`}>
                  {index > 0 && <span className="studio-history-link" aria-hidden="true" />}
                  <button
                    type="button"
                    className={`studio-node${current ? " current" : ""}`}
                    aria-current={current ? "true" : undefined}
                    aria-label={label}
                    title={label}
                    disabled={running}
                    onClick={() => selectNode(node)}
                  >
                    <img src={convertFileSrc(node.image.path)} alt="" />
                    <span className="studio-node-name">{name}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
    </section>
  );
}
