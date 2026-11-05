// Image Studio: a dedicated view for instruction-based image editing.
//
// Layout: a header (back, title, open another image, download), a tools bar
// over the canvas (real zoom toggle plus disabled "coming soon" slots), the
// canvas with the current base image, a side panel (the image tray with the
// base locked first, the instruction and the one primary action) and the
// lineage history strip underneath.
//
// The Studio is UI over the existing edit core: `edit_images` runs the edit
// and persists the result as a chat message (so it also shows in the
// conversation), `image_edit_pick` / `image_edit_stage` stage user files
// through the folder grants, and every image is shown through the asset
// protocol (bytes never cross IPC).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  IconX,
} from "../icons";
import type { ChatMessageRow, StagedEditSource } from "../types";
import {
  MAX_EDIT_INSTRUCTION,
  MAX_REFERENCES,
  addReference,
  afterEdit,
  canSubmit,
  editSources,
  instructionLength,
  removeReference,
  type HistoryNode,
  type StudioImage,
  type StudioSeed,
} from "./studio";

interface Session {
  conversationId: number | null;
  base: StudioImage | null;
  refs: StudioImage[];
  history: HistoryNode[];
}

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

/// A tool that does not exist yet: visible, focusable (so the tooltip and
/// the name reach everyone) and inert. No handler on purpose (S9).
function SoonTool({ name, children }: { name: string; children: ReactNode }) {
  const t = useT();
  const label = t.studio.soon(name);
  return (
    <button type="button" className="icon-btn studio-tool soon" aria-disabled="true" aria-label={label} title={label}>
      {children}
    </button>
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
  const jobRef = useRef<Job | null>(null);
  const running = stage !== null;
  const { base, refs, history } = session;

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
    if (!base || !canSubmit(base, text, running || preparing)) return;
    setError("");
    setStage("starting");
    let conversationId = session.conversationId;
    try {
      if (conversationId === null) {
        conversationId = await onCreateConversation(text);
        if (conversationId === null) throw new Error("protocol");
        const created = conversationId;
        setSession((prev) => ({ ...prev, conversationId: created }));
      }
      const sent = editSources(base, refs);
      jobRef.current = { conversationId, instruction: text };
      onJob(conversationId, true);
      await invoke("edit_images", {
        conversationId,
        parentMessageId: base.messageId,
        instruction: text,
        sourcePaths: sent,
      });
    } catch (err) {
      // Refused before the job started: no event will follow.
      if (conversationId !== null && jobRef.current) onJob(conversationId, false);
      endJob();
      // Keep the instruction and the tray so the user can fix and retry.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [instruction, base, refs, running, preparing, session.conversationId, onCreateConversation, onJob, endJob]);

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
    if (image) setSession((prev) => ({ ...prev, refs: addReference(prev.refs, prev.base, image) }));
  }, [pick]);

  const removeRef = (path: string): void => {
    setSession((prev) => ({ ...prev, refs: removeReference(prev.refs, path) }));
  };

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
            <SoonTool name={t.studio.toolBrush}>
              <IconBrush size={16} />
            </SoonTool>
            <SoonTool name={t.studio.toolRegion}>
              <IconSelection size={16} />
            </SoonTool>
            {/* Visible, so the inert state reads without hovering. Hidden
                from assistive tech: each tool's name already says it. */}
            <span className="studio-soon-chip" aria-hidden="true">
              {t.studio.soonChip}
            </span>
          </div>

          <div
            className={`studio-canvas${zoom === "actual" ? " actual" : ""}${running ? " running" : ""}`}
            role="region"
            aria-label={t.studio.canvasLabel}
            aria-busy={running || preparing}
          >
            {base ? (
              <img className="studio-image" src={convertFileSrc(base.path)} alt={t.studio.canvasAlt(base.label)} />
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
              <span className="studio-count">{t.studio.referenceCount(refs.length, MAX_REFERENCES)}</span>
            </div>
            <p className="studio-hint">{t.studio.referencesHint(MAX_REFERENCES)}</p>
            <ul className="studio-tray">
              {base && (
                <li className="studio-thumb base" title={t.studio.baseLocked(base.label)}>
                  <img src={convertFileSrc(base.path)} alt={t.studio.baseLocked(base.label)} />
                  <span className="studio-thumb-badge">
                    <IconLock size={11} />
                    {t.studio.baseBadge}
                  </span>
                </li>
              )}
              {refs.map((ref) => (
                <li key={ref.path} className="studio-thumb">
                  <img src={convertFileSrc(ref.path)} alt={ref.label} title={ref.label} />
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
              {refs.length < MAX_REFERENCES && (
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
              maxLength={MAX_EDIT_INSTRUCTION}
              aria-describedby="studio-instruction-meta"
              rows={5}
              readOnly={running}
            />
            <div id="studio-instruction-meta" className="studio-meta">
              <span>{t.studio.submitHint}</span>
              <span className="studio-counter">{t.studio.counter(length, MAX_EDIT_INSTRUCTION)}</span>
            </div>
            {/* The error state survives hiding the Studio; the alert is only
                rendered while visible so it never leaks into the chat view. */}
            {active && errorText && (
              <p className="inline-error" role="alert">
                {errorText}
              </p>
            )}
            <div className="studio-actions">
              <button
                type="button"
                className="btn btn-primary studio-apply"
                onClick={() => void submit()}
                disabled={!canSubmit(base, instruction, busy)}
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
