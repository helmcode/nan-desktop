// R-V1: the simple editor, for people who never touch code: the player,
// the fill-in fields (texts, colors, images/logo), the scenes (order,
// length, "Ask for a change in this scene"), music and voice with their
// volume, the format, and the export. Every change goes through the core
// (`video_update`, `video_pick_asset`): the renderer never writes a file or
// names a path. What a scene SHOWS is changed by the assistant.

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { releaseSitePreview } from "../core";
import { IconArrowLeft, IconChevronDown, IconImage, IconSparkles, IconTrash, IconX } from "../icons";
import {
  formatTime,
  videoGet,
  videoPickAsset,
  videoPreview,
  videoUpdate,
  type Aspect,
  type EditorPatch,
  type VideoPreviewInfo,
  type VideoProject,
  type VideoVariable,
} from "./api";
import { ExportPanel } from "./ExportPanel";
import { lintProject, problemsForAssistant, type LintProblem } from "./lint";
import { changeRequest, moveScene, parseDuration, sceneAt, sceneWindows } from "./logic";
import { VideoPlayer, type PlayerHandle } from "./VideoPlayer";

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];
/// How long a typed text waits before it is saved (and the preview reloads).
export const TEXT_SAVE_MS = 700;

type Save = "idle" | "saving" | "saved" | "failed";

function TextField({ variable, onCommit }: { variable: VideoVariable; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(variable.value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setDraft(variable.value), [variable.value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const commit = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (value !== variable.value) onCommit(value);
  };
  const multiline = variable.value.length > 60;
  const props = {
    id: `video-var-${variable.id}`,
    value: draft,
    maxLength: 400,
    onBlur: () => commit(draft),
    onChange: (e: { currentTarget: { value: string } }) => {
      const value = e.currentTarget.value;
      setDraft(value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => commit(value), TEXT_SAVE_MS);
    },
  };
  return multiline ? <textarea rows={3} {...props} /> : <input type="text" {...props} />;
}

export function VideoEditor({
  profileId,
  projectId,
  onClose,
  onAskAssistant,
}: {
  profileId: string;
  projectId: string;
  onClose: () => void;
  /// Prefill the chat composer (and go there) with a request about this video.
  onAskAssistant: (text: string) => void;
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
  const player = useRef<PlayerHandle | null>(null);
  const previewRef = useRef<VideoPreviewInfo | null>(null);
  const revision = useRef(0);

  // Each project version gets a fresh sandboxed preview; the old token goes back.
  const showProject = useCallback(
    (next: VideoProject) => {
      setProject(next);
      setTitleDraft(next.meta.title);
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

  const apply = useCallback(
    (patch: EditorPatch) => {
      setSave("saving");
      videoUpdate(profileId, projectId, patch)
        .then((next) => {
          setSave("saved");
          showProject(next);
        })
        .catch(() => setSave("failed"));
    },
    [profileId, projectId, showProject],
  );

  const pick = (slot: Parameters<typeof videoPickAsset>[2]) => {
    setPickFailed(false);
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
  const setScenes = (next: { id: string; duration: number }[]) => apply({ scenes: next });

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
            onBlur={() => titleDraft.trim() && titleDraft !== meta.title && apply({ title: titleDraft })}
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
            <VideoPlayer key={preview.url} info={preview} handle={player} onTime={setTime} />
          ) : (
            <p className="video-note">{t.video.loading}</p>
          )}

          <section className="video-section" aria-labelledby="video-scenes-title">
            <div className="video-section-head">
              <h2 id="video-scenes-title" className="video-section-title">
                {t.video.sectionScenes}
              </h2>
              <span className="video-hint">{t.video.totalDuration(formatTime(project.duration))}</span>
            </div>
            <p className="video-hint">{t.video.scenesHint}</p>
            <ol className="video-scenes">
              {windows.map((w, index) => {
                const title = sceneTitle(index);
                const list = scenes.map((s) => ({ id: s.id, duration: s.duration }));
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
                            setScenes(list.map((s) => (s.id === w.scene.id ? { ...s, duration: value } : s)));
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
                        onClick={() => setScenes(moveScene(scenes, index, -1).map((s) => ({ id: s.id, duration: s.duration })))}
                      >
                        <IconChevronDown size={14} style={{ transform: "rotate(180deg)" }} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t.video.moveDown(title)}
                        title={t.video.moveDown(title)}
                        disabled={index === scenes.length - 1}
                        onClick={() => setScenes(moveScene(scenes, index, 1).map((s) => ({ id: s.id, duration: s.duration })))}
                      >
                        <IconChevronDown size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t.video.removeScene(title)}
                        title={t.video.removeScene(title)}
                        disabled={scenes.length === 1}
                        onClick={() => {
                          if (window.confirm(t.video.removeSceneConfirm(title))) {
                            setScenes(list.filter((s) => s.id !== w.scene.id));
                          }
                        }}
                      >
                        <IconTrash size={14} />
                      </button>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm video-ask"
                      aria-label={t.video.askChangeLabel(title)}
                      onClick={() =>
                        onAskAssistant(
                          changeRequest(t, { id: project.id, title: meta.title }, scenes, index, player.current?.currentTime() ?? null),
                        )
                      }
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
            {meta.variables.map((variable) => (
              <div key={variable.id} className="video-field">
                <label htmlFor={`video-var-${variable.id}`}>{variable.label}</label>
                {variable.type === "text" && (
                  <TextField variable={variable} onCommit={(value) => apply({ values: { [variable.id]: value } })} />
                )}
                {variable.type === "color" && (
                  <input
                    id={`video-var-${variable.id}`}
                    type="color"
                    defaultValue={variable.value.length === 7 ? variable.value : "#000000"}
                    key={variable.value}
                    onBlur={(e) => e.currentTarget.value !== variable.value && apply({ values: { [variable.id]: e.currentTarget.value } })}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      // Native pickers fire many changes while dragging: save once it settles.
                      window.clearTimeout(Number(e.currentTarget.dataset.timer));
                      e.currentTarget.dataset.timer = String(
                        window.setTimeout(() => value !== variable.value && apply({ values: { [variable.id]: value } }), TEXT_SAVE_MS),
                      );
                    }}
                  />
                )}
                {variable.type === "image" && (
                  <div className="video-image-field" id={`video-var-${variable.id}`}>
                    <span className="video-image-name">{variable.value ? variable.value.replace(/^assets\//, "") : t.video.noImage}</span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => pick({ kind: "image", variable: variable.id })}
                    >
                      <IconImage size={13} />
                      {variable.value ? t.video.replaceImage : t.video.pickImage}
                    </button>
                    {variable.value && (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`${t.video.removeImage}: ${variable.label}`}
                        title={t.video.removeImage}
                        onClick={() => apply({ values: { [variable.id]: "" } })}
                      >
                        <IconX size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
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
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      defaultValue={track.volume}
                      key={`${track.file}:${track.volume}`}
                      aria-label={t.video.volume(label)}
                      onPointerUp={(e) =>
                        apply(slot === "music" ? { music_volume: Number(e.currentTarget.value) } : { voice_volume: Number(e.currentTarget.value) })
                      }
                      onKeyUp={(e) =>
                        apply(slot === "music" ? { music_volume: Number(e.currentTarget.value) } : { voice_volume: Number(e.currentTarget.value) })
                      }
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
            <div className="video-segmented" role="radiogroup" aria-labelledby="video-format-title">
              {ASPECTS.map((aspect) => (
                <button
                  key={aspect}
                  type="button"
                  role="radio"
                  aria-checked={meta.aspect === aspect}
                  className={`video-seg${meta.aspect === aspect ? " active" : ""}`}
                  onClick={() => meta.aspect !== aspect && apply({ aspect })}
                >
                  {t.video.aspectNames[aspect]}
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
                  onClick={() => onAskAssistant(t.video.askFixText(meta.title, project.id, problemsForAssistant(problems)))}
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

          <ExportPanel profileId={profileId} project={project} blocked={problems === null || errors.length > 0} onExported={refresh} />
        </aside>
      </div>
    </section>
  );
}
