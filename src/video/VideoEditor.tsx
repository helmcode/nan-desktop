// R-V1: the simple editor, for people who never touch code: the player
// with its own timeline, the fill-in fields grouped by scene (texts,
// numbers, colors, images/logo), the scenes (order, length, "Ask for a
// change in this scene"), music and voice with their volume, the format,
// and the export. Every change goes through the core (`video_update`,
// `video_pick_asset`): the renderer never writes a file or names a path.
// What a scene SHOWS is changed by the assistant.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import { releaseSitePreview } from "../core";
import { IconArrowLeft, IconChevronDown, IconImage, IconSparkles, IconTrash, IconX } from "../icons";
import {
  ASPECTS,
  formatDuration,
  formatTime,
  videoGet,
  videoPickAsset,
  videoPreview,
  videoUpdate,
  type EditorPatch,
  type VideoAskContext,
  type VideoPreviewInfo,
  type VideoProject,
  type VideoVariable,
} from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExportPanel } from "./ExportPanel";
import { lintProject, problemsForAssistant, type LintProblem } from "./lint";
import { changeRequest, groupVariables, moveScene, normalizeHex, parseDuration, sceneAt, sceneWindows } from "./logic";
import { useVideoRevision } from "./useVideoRevision";
import { VideoPlayer, type PlayerHandle } from "./VideoPlayer";

/// How long typing, a color drag or a volume drag waits before it is saved.
export const TEXT_SAVE_MS = 700;

type Save = "idle" | "saving" | "saved" | "failed";

/// A value field that saves once the user pauses (or leaves it). The draft
/// is exactly what the user typed (empty included); only a `valid` value is
/// saved, and leaving the field with an invalid one restores the saved
/// value. Whatever the core answers (possibly normalized: "6,5" -> "6.5")
/// re-syncs the draft unless the user is in the field.
function useDebouncedField(value: string, onCommit: (value: string) => void, valid: (draft: string) => boolean = () => true) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const commit = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (valid(next) && next !== value) onCommit(next);
  };
  return {
    draft,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      if (valid(draft)) {
        if (timer.current) commit(draft);
      } else {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        setDraft(value);
      }
    },
    onChange: (next: string) => {
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = valid(next) ? setTimeout(() => commit(next), TEXT_SAVE_MS) : null;
    },
    /// Save `next` right away (Enter in a field next to this one).
    commitNow: (next: string) => {
      setDraft(next);
      commit(next);
    },
  };
}

/// Texts longer than this get a multi-line box.
const LONG_TEXT = 48;

function TextField({ variable, onCommit }: { variable: VideoVariable; onCommit: (value: string) => void }) {
  const field = useDebouncedField(variable.value, onCommit);
  // One line for short texts ("Nova", "-30%"); it grows for long ones
  // (the same element, so typing never loses focus).
  const long = field.draft.length > LONG_TEXT || field.draft.includes("\n");
  return (
    <textarea
      id={`video-var-${variable.id}`}
      className={long ? "video-text long" : "video-text"}
      rows={long ? 3 : 1}
      maxLength={400}
      value={field.draft}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
      onChange={(e) => field.onChange(e.currentTarget.value)}
    />
  );
}

/// A color: the swatch (system picker) plus its code typed by hand
/// (`#0a0a0a`, `#FFF`, `fff`). The code applies on Enter or on leaving the
/// box when it is valid (normalized to lowercase `#rrggbb`); an invalid one
/// says so and changes nothing. The box follows the swatch.
function ColorField({ variable, onCommit }: { variable: VideoVariable; onCommit: (value: string) => void }) {
  const { t } = useI18n();
  const field = useDebouncedField(variable.value, onCommit);
  const [hex, setHex] = useState(field.draft);
  const [invalid, setInvalid] = useState(false);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) {
      setHex(field.draft);
      setInvalid(false);
    }
  }, [field.draft]);
  const applyHex = () => {
    // Emptied by the user: back to the saved color, nothing to complain about.
    if (hex.trim() === "") {
      setHex(field.draft);
      setInvalid(false);
      return;
    }
    const normalized = normalizeHex(hex);
    if (normalized === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setHex(normalized);
    // Saved only when it differs from the saved value.
    field.commitNow(normalized);
  };
  const errorId = `video-var-${variable.id}-hex-error`;
  return (
    <div className="video-color-field">
      <input
        id={`video-var-${variable.id}`}
        type="color"
        value={field.draft.length === 7 ? field.draft : "#000000"}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        onChange={(e) => field.onChange(e.currentTarget.value)}
      />
      <input
        type="text"
        className="video-hex"
        aria-label={t.video.hexLabel(variable.label)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        maxLength={7}
        value={hex}
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={invalid ? errorId : undefined}
        onFocus={() => {
          typing.current = true;
        }}
        onBlur={() => {
          typing.current = false;
          applyHex();
        }}
        onChange={(e) => {
          setHex(e.currentTarget.value);
          if (invalid) setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            applyHex();
          }
        }}
      />
      {invalid && (
        <p id={errorId} className="inline-error video-hex-error" role="alert">
          {t.video.hexInvalid}
        </p>
      )}
    </div>
  );
}

/// A number the core accepts (decimal comma or dot).
export function validNumber(draft: string): boolean {
  return /^-?\d+([.,]\d+)?$/.test(draft.trim());
}

function NumberField({ variable, onCommit }: { variable: VideoVariable; onCommit: (value: string) => void }) {
  const field = useDebouncedField(variable.value, (value) => onCommit(value.trim().replace(",", ".")), validNumber);
  return (
    <input
      id={`video-var-${variable.id}`}
      type="text"
      inputMode="decimal"
      className="video-number"
      value={field.draft}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
      onChange={(e) => field.onChange(e.currentTarget.value)}
    />
  );
}

function VolumeField({ label, volume, onCommit }: { label: string; volume: number; onCommit: (value: number) => void }) {
  const { t } = useI18n();
  const field = useDebouncedField(String(volume), (value) => onCommit(Number(value)));
  const pct = Math.round(Number(field.draft) * 100);
  return (
    <label className="video-volume">
      <span>{t.video.volume(label)}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={field.draft}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        onChange={(e) => field.onChange(e.currentTarget.value)}
      />
      <output>{t.video.volumePct(pct)}</output>
    </label>
  );
}

/// Arrow keys move the choice in a radio group (roving tabindex).
export function rovingKeys<T>(options: readonly T[], current: T, choose: (value: T) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = options[(options.indexOf(current) + step + options.length) % options.length];
    choose(next);
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role=radio],[role=tab]"));
    buttons[options.indexOf(next)]?.focus();
  };
}

/// Where a freshly opened editor starts: a moment into the first scene
/// (scenes animate in from nothing, so 0:00 is often an empty frame).
export function firstFrame(scenes: { duration: number }[]): number {
  return scenes.length > 0 ? Math.min(1, scenes[0].duration / 2) : 0;
}

export function VideoEditor({
  profileId,
  projectId,
  onClose,
  onAskAssistant,
  onSendToAssistant,
  onSignIn,
}: {
  profileId: string;
  projectId: string;
  onClose: () => void;
  /// Go to the chat with a short request in the composer and the technical
  /// context attached for the model only.
  onAskAssistant: (text: string, context: VideoAskContext) => void;
  /// Go to the chat and SEND a complete request right away (the automatic
  /// check's "fix it": nothing for the user to add). Falls back to
  /// `onAskAssistant` when absent.
  onSendToAssistant?: (text: string, context: VideoAskContext) => void;
  /// The session expired: sign in again.
  onSignIn?: () => void;
}) {
  const { t } = useI18n();
  const [project, setProject] = useState<VideoProject | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [preview, setPreview] = useState<VideoPreviewInfo | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [save, setSave] = useState<Save>("idle");
  const [pickFailed, setPickFailed] = useState(false);
  const [problems, setProblems] = useState<LintProblem[] | null>(null);
  const [time, setTime] = useState(0);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const player = useRef<PlayerHandle | null>(null);
  const titleFocused = useRef(false);
  // Editor saves in flight, and an assistant change that arrived meanwhile
  // (applied once they are done, so a save's answer is never lost).
  const inflight = useRef(0);
  const refreshQueued = useRef(false);
  const previewRef = useRef<VideoPreviewInfo | null>(null);
  const revision = useRef(0);
  const request = useRef(0);
  // Where the next preview starts: the playhead before the change (or the
  // start of the scene that was edited).
  const resumeAt = useRef(0);
  const timeRef = useRef(0);
  const onTime = useCallback((seconds: number) => {
    timeRef.current = seconds;
    setTime(seconds);
  }, []);

  // Each project version gets a fresh sandboxed preview; the old token goes back.
  const showProject = useCallback(
    (next: VideoProject) => {
      setProject(next);
      // Never under the user's fingers: the title box keeps what is typed.
      if (!titleFocused.current) setTitleDraft(next.meta.title);
      const mine = ++revision.current;
      setProblems(null);
      videoPreview(profileId, next.id)
        .then((info) => {
          if (mine !== revision.current) return releaseSitePreview(info.url);
          if (previewRef.current) releaseSitePreview(previewRef.current.url);
          previewRef.current = info;
          setPreview(info);
          setPreviewFailed(false);
        })
        .catch(() => mine === revision.current && setPreviewFailed(true));
      lintProject(next)
        .then((found) => mine === revision.current && setProblems(found))
        .catch(() => mine === revision.current && setProblems([]));
    },
    [profileId],
  );

  useEffect(() => {
    let alive = true;
    videoGet(profileId, projectId)
      .then((p) => alive && showProject(p))
      .catch(() => alive && setLoadFailed(true));
    return () => {
      alive = false;
      revision.current += 1;
      if (previewRef.current) releaseSitePreview(previewRef.current.url);
      previewRef.current = null;
    };
  }, [profileId, projectId, showProject]);

  /// Save a change. `at` is where the playhead should be afterwards
  /// (default: where it is now). Only the latest response is applied.
  const apply = useCallback(
    (patch: EditorPatch, at?: number) => {
      const mine = ++request.current;
      resumeAt.current = at ?? timeRef.current;
      setSave("saving");
      inflight.current += 1;
      videoUpdate(profileId, projectId, patch)
        .then((next) => {
          if (mine !== request.current) return;
          setSave("saved");
          showProject(next);
        })
        .catch(() => mine === request.current && setSave("failed"))
        .finally(() => {
          inflight.current -= 1;
          if (inflight.current === 0 && refreshQueued.current) {
            refreshQueued.current = false;
            reloadRef.current();
          }
        });
    },
    [profileId, projectId, showProject],
  );

  // R-V1 (round 24): the assistant changed this video while it is open:
  // reload it at the same playhead. The fields keep whatever the user is
  // typing (they never re-sync while focused); a save in flight finishes
  // first.
  const reloadRef = useRef<() => void>(() => undefined);
  reloadRef.current = () => {
    if (inflight.current > 0) {
      refreshQueued.current = true;
      return;
    }
    const mine = request.current;
    videoGet(profileId, projectId)
      .then((next) => {
        if (inflight.current > 0 || mine !== request.current) {
          refreshQueued.current = true;
          return;
        }
        resumeAt.current = timeRef.current;
        showProject(next);
      })
      .catch(() => undefined);
  };
  const changes = useVideoRevision(projectId);
  useEffect(() => {
    if (changes > 0) reloadRef.current();
  }, [changes]);

  const pick = (slot: Parameters<typeof videoPickAsset>[2]) => {
    setPickFailed(false);
    resumeAt.current = timeRef.current;
    videoPickAsset(profileId, projectId, slot)
      .then((next) => next && showProject(next))
      .catch(() => setPickFailed(true));
  };

  const refresh = useCallback(() => {
    videoGet(profileId, projectId)
      .then((p) => setProject(p))
      .catch(() => undefined);
  }, [profileId, projectId]);

  if (loadFailed) {
    return (
      <section className="video-editor">
        <p className="inline-error" role="alert">
          {t.video.editorFailed}
        </p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
          <IconArrowLeft size={14} />
          {t.video.back}
        </button>
      </section>
    );
  }
  if (!project) return <p className="video-note">{t.video.editorLoading}</p>;

  const { meta } = project;
  const scenes = meta.scenes;
  const windows = sceneWindows(scenes);
  const current = sceneAt(scenes, time);
  const errors = (problems ?? []).filter((p) => p.severity === "error");
  const warnings = (problems ?? []).filter((p) => p.severity === "warning");
  const sceneTitle = (index: number) => scenes[index]?.title || t.video.sceneUntitled(index + 1);
  const list = scenes.map((s) => ({ id: s.id, duration: s.duration }));
  /// The start of a scene in a new scene list (where the playhead goes).
  const startIn = (next: { id: string; duration: number }[], id: string) => {
    let at = 0;
    for (const s of next) {
      if (s.id === id) return at;
      at += s.duration;
    }
    return 0;
  };
  const setScenes = (next: { id: string; duration: number }[], focus: string | null) =>
    apply({ scenes: next }, focus ? startIn(next, focus) : 0);
  const groups = groupVariables(meta.variables, scenes, project.sources.scenes);
  const removing = confirmRemove ? scenes.findIndex((s) => s.id === confirmRemove) : -1;

  const field = (variable: VideoVariable) => {
    const commit = (value: string) => apply({ values: { [variable.id]: value } });
    switch (variable.type) {
      case "text":
        return <TextField variable={variable} onCommit={commit} />;
      case "number":
        return <NumberField variable={variable} onCommit={commit} />;
      case "color":
        return <ColorField variable={variable} onCommit={commit} />;
      case "image":
        return (
          <div className="video-image-field" id={`video-var-${variable.id}`}>
            <span className="video-image-name">{variable.value ? variable.value.replace(/^assets\//, "") : t.video.noImage}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => pick({ kind: "image", variable: variable.id })}>
              <IconImage size={13} />
              {variable.value ? t.video.replaceImage : t.video.pickImage}
            </button>
            {variable.value && (
              <button
                type="button"
                className="icon-btn"
                aria-label={`${t.video.removeImage}: ${variable.label}`}
                title={t.video.removeImage}
                onClick={() => commit("")}
              >
                <IconX size={14} />
              </button>
            )}
          </div>
        );
    }
  };

  return (
    <section className="video-editor" aria-labelledby="video-editor-title">
      <header className="video-editor-head">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          <IconArrowLeft size={16} />
          {t.video.back}
        </button>
        <label className="video-title-field">
          <span className="visually-hidden" id="video-editor-title">
            {t.video.titleLabel}
          </span>
          <input
            type="text"
            value={titleDraft}
            maxLength={120}
            aria-labelledby="video-editor-title"
            onChange={(e) => setTitleDraft(e.currentTarget.value)}
            onFocus={() => {
              titleFocused.current = true;
            }}
            onBlur={() => {
              titleFocused.current = false;
              if (titleDraft.trim() && titleDraft !== meta.title) apply({ title: titleDraft });
              else setTitleDraft(meta.title);
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </label>
        <span className={`video-save video-save-${save}`} role="status" aria-live="polite">
          {save === "saving" ? t.video.saving : save === "saved" ? t.video.saved : save === "failed" ? t.video.saveFailed : ""}
        </span>
      </header>

      <div className="video-editor-body">
        <div className="video-editor-stage">
          {previewFailed ? (
            <p className="inline-error" role="alert">
              {t.video.previewFailed}
            </p>
          ) : preview ? (
            <VideoPlayer
              key={preview.url}
              info={preview}
              handle={player}
              onTime={onTime}
              startAt={resumeAt.current > 0 ? resumeAt.current : firstFrame(scenes)}
            />
          ) : (
            <p className="video-note">{t.video.loading}</p>
          )}
          {preview && preview.height > preview.width && (
            <div className="video-timeline">
              <input
                type="range"
                min={0}
                max={project.duration}
                step={0.05}
                value={Math.min(time, project.duration)}
                aria-label={t.video.timelineLabel}
                aria-valuetext={formatTime(time)}
                onChange={(e) => player.current?.seek(Number(e.currentTarget.value))}
              />
              <span className="video-timeline-time">
                {formatTime(time)} / {formatTime(project.duration)}
              </span>
            </div>
          )}

          <section className="video-section" aria-labelledby="video-scenes-title">
            <div className="video-section-head">
              <h2 id="video-scenes-title" className="video-section-title">
                {t.video.sectionScenes}
              </h2>
              <span className="video-hint">{t.video.totalDuration(formatDuration(project.duration))}</span>
            </div>
            <p className="video-hint">{t.video.scenesHint}</p>
            <ol className="video-scenes">
              {windows.map((w, index) => {
                const title = sceneTitle(index);
                return (
                  <li key={w.scene.id} className={`video-scene${index === current ? " current" : ""}`}>
                    <button
                      type="button"
                      className="video-scene-main"
                      aria-label={t.video.jumpTo(title, formatTime(w.start))}
                      onClick={() => player.current?.seek(w.start + 0.05)}
                    >
                      <span className="video-scene-index">{index + 1}</span>
                      <span className="video-scene-title">{title}</span>
                      <span className="video-scene-time">{formatTime(w.start)}</span>
                    </button>
                    <label className="video-scene-duration">
                      <input
                        aria-label={t.video.sceneDurationLabel(title)}
                        type="number"
                        min={0.5}
                        max={120}
                        step={0.5}
                        defaultValue={w.scene.duration}
                        key={`${w.scene.id}:${w.scene.duration}`}
                        onBlur={(e) => {
                          const value = parseDuration(e.currentTarget.value);
                          if (value !== null && value !== w.scene.duration) {
                            setScenes(
                              list.map((s) => (s.id === w.scene.id ? { ...s, duration: value } : s)),
                              w.scene.id,
                            );
                          }
                        }}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      />
                      <span aria-hidden="true">s</span>
                    </label>
                    <span className="video-scene-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t.video.moveUp(title)}
                        title={t.video.moveUp(title)}
                        disabled={index === 0}
                        onClick={() =>
                          setScenes(moveScene(scenes, index, -1).map((s) => ({ id: s.id, duration: s.duration })), w.scene.id)
                        }
                      >
                        <IconChevronDown size={14} style={{ transform: "rotate(180deg)" }} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t.video.moveDown(title)}
                        title={t.video.moveDown(title)}
                        disabled={index === scenes.length - 1}
                        onClick={() =>
                          setScenes(moveScene(scenes, index, 1).map((s) => ({ id: s.id, duration: s.duration })), w.scene.id)
                        }
                      >
                        <IconChevronDown size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t.video.removeScene(title)}
                        title={t.video.removeScene(title)}
                        disabled={scenes.length === 1}
                        onClick={() => setConfirmRemove(w.scene.id)}
                      >
                        <IconTrash size={14} />
                      </button>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm video-ask"
                      aria-label={t.video.askChangeLabel(title)}
                      onClick={() => {
                        const ask = changeRequest(t, { id: project.id, title: meta.title }, scenes, index, timeRef.current);
                        if (ask) onAskAssistant(ask.text, ask.context);
                      }}
                    >
                      <IconSparkles size={13} />
                      {t.video.askChange}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        <aside className="video-editor-panel">
          <section className="video-section" aria-labelledby="video-fields-title">
            <h2 id="video-fields-title" className="video-section-title">
              {t.video.sectionFields}
            </h2>
            {meta.variables.length === 0 && <p className="video-hint">{t.video.noFields}</p>}
            {groups.map((group) => (
              <fieldset key={group.sceneId ?? "general"} className="video-field-group">
                <legend>{group.title ? t.video.sceneFields(group.title) : t.video.generalFields}</legend>
                {group.variables.map((variable) => (
                  <div key={variable.id} className="video-field">
                    <label htmlFor={`video-var-${variable.id}`}>{variable.label}</label>
                    {field(variable)}
                  </div>
                ))}
              </fieldset>
            ))}
            {pickFailed && (
              <p className="inline-error" role="alert">
                {t.video.pickFailed}
              </p>
            )}
          </section>

          <section className="video-section" aria-labelledby="video-audio-title">
            <h2 id="video-audio-title" className="video-section-title">
              {t.video.sectionAudio}
            </h2>
            {(["music", "voice"] as const).map((slot) => {
              const track = slot === "music" ? meta.audio.music : meta.audio.voice;
              const label = slot === "music" ? t.video.music : t.video.voice;
              return (
                <div key={slot} className="video-field">
                  <span className="video-field-label">{label}</span>
                  <div className="video-image-field">
                    <span className="video-image-name">{track ? track.file.replace(/^assets\//, "") : t.video.noAudio}</span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => pick({ kind: slot })}>
                      {track ? t.video.replaceAudio : slot === "music" ? t.video.addMusic : t.video.addVoice}
                    </button>
                    {track && (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`${t.video.removeAudio}: ${label}`}
                        title={t.video.removeAudio}
                        onClick={() => apply(slot === "music" ? { remove_music: true } : { remove_voice: true })}
                      >
                        <IconX size={14} />
                      </button>
                    )}
                  </div>
                  {track && (
                    <VolumeField
                      key={track.file}
                      label={label}
                      volume={track.volume}
                      onCommit={(volume) => apply(slot === "music" ? { music_volume: volume } : { voice_volume: volume })}
                    />
                  )}
                </div>
              );
            })}
            <p className="video-hint">{t.video.voiceHint}</p>
          </section>

          <section className="video-section" aria-labelledby="video-format-title">
            <h2 id="video-format-title" className="video-section-title">
              {t.video.sectionFormat}
            </h2>
            <div
              className="video-segmented video-formats"
              role="radiogroup"
              aria-labelledby="video-format-title"
              onKeyDown={rovingKeys(ASPECTS, meta.aspect, (aspect) => apply({ aspect }))}
            >
              {ASPECTS.map((aspect) => (
                <button
                  key={aspect}
                  type="button"
                  role="radio"
                  aria-checked={meta.aspect === aspect}
                  aria-label={t.video.aspectNames[aspect]}
                  title={t.video.aspectNames[aspect]}
                  tabIndex={meta.aspect === aspect ? 0 : -1}
                  className={`video-seg${meta.aspect === aspect ? " active" : ""}`}
                  onClick={() => meta.aspect !== aspect && apply({ aspect })}
                >
                  <span className={`video-format-icon aspect-${aspect.replace(":", "x")}`} aria-hidden="true" />
                  <span className="video-format-text">
                    <span>{t.video.aspectShort[aspect]}</span>
                    <small>{aspect}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="video-section video-check" aria-live="polite">
            {problems === null ? (
              <p className="video-hint">{t.video.checking}</p>
            ) : errors.length > 0 ? (
              <>
                <p className="inline-error">{t.video.checkProblems(errors.length)}</p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    (onSendToAssistant ?? onAskAssistant)(t.video.askFixText, {
                      project_id: project.id,
                      title: meta.title,
                      problems: problemsForAssistant(problems)
                        .split("\n")
                        .map((line) => line.replace(/^- /, ""))
                        .filter(Boolean),
                    })
                  }
                >
                  <IconSparkles size={13} />
                  {t.video.askFix}
                </button>
              </>
            ) : (
              <p className="video-ok">
                {t.video.checkOk} {warnings.length > 0 && <span className="video-hint">{t.video.checkWarnings(warnings.length)}</span>}
              </p>
            )}
          </section>

          <ExportPanel
            profileId={profileId}
            project={project}
            blocked={problems === null || errors.length > 0}
            onExported={refresh}
            onSignIn={onSignIn}
            onFixLayout={onSendToAssistant ?? onAskAssistant}
          />
        </aside>
      </div>
      {removing >= 0 && (
        <ConfirmDialog
          title={t.video.removeSceneTitle}
          body={t.video.removeSceneConfirm(sceneTitle(removing))}
          confirmLabel={t.video.removeSceneButton}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const id = scenes[removing].id;
            setConfirmRemove(null);
            const next = list.filter((s) => s.id !== id);
            setScenes(next, next[Math.min(removing, next.length - 1)]?.id ?? null);
          }}
        />
      )}
    </section>
  );
}
