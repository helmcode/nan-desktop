// R-V1: the Videos surface: "My videos" (the library), "Templates" (the
// gallery of examples to start from) and the editor. Lazy-loaded by the
// app shell; the side panel opens the editor here with "Edit video".

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { releaseSitePreview } from "../core";
import { IconArrowLeft, IconFilm, IconPlus, IconTrash } from "../icons";
import {
  formatTime,
  templatePoster,
  videoCreateFromTemplate,
  videoDelete,
  videoList,
  videoTemplatePreview,
  videoTemplates,
  type Aspect,
  type VideoPreviewInfo,
  type VideoSummary,
  type VideoTemplate,
} from "./api";
import { VideoEditor } from "./VideoEditor";
import { VideoPlayer } from "./VideoPlayer";
import "./video.css";

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

type Tab = "mine" | "templates";

/// A template's live preview (hover thumbnail and detail view): requested
/// on mount, token released on unmount or when the aspect changes.
function TemplatePreview({ id, aspect, compact }: { id: string; aspect: Aspect | null; compact: boolean }) {
  const { locale } = useI18n();
  const [info, setInfo] = useState<VideoPreviewInfo | null>(null);
  useEffect(() => {
    let alive = true;
    let loaded: VideoPreviewInfo | null = null;
    setInfo(null);
    videoTemplatePreview(id, aspect, locale)
      .then((value) => {
        if (!alive) return releaseSitePreview(value.url);
        loaded = value;
        setInfo(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (loaded) releaseSitePreview(loaded.url);
    };
  }, [id, aspect, locale]);
  return info ? <VideoPlayer key={info.url} info={info} compact={compact} /> : null;
}

function TemplateCard({ template, onOpen }: { template: VideoTemplate; onOpen: () => void }) {
  const { t } = useI18n();
  const [live, setLive] = useState(false);
  return (
    <li className="video-card video-template-card">
      <button
        type="button"
        className="video-card-main"
        onClick={onOpen}
        onMouseEnter={() => setLive(true)}
        onMouseLeave={() => setLive(false)}
        onFocus={() => setLive(true)}
        onBlur={() => setLive(false)}
        aria-label={t.video.previewTemplate(template.title)}
      >
        <span className={`video-thumb aspect-${template.aspect.replace(":", "x")}`}>
          <img src={templatePoster(template.id)} alt="" loading="lazy" />
          {live && (
            <span className="video-thumb-live">
              <TemplatePreview id={template.id} aspect={null} compact />
            </span>
          )}
        </span>
        <span className="video-card-text">
          <span className="video-card-title">{template.title}</span>
          <span className="video-card-meta">
            <span className="video-aspect">{template.aspect}</span>
            {formatTime(template.duration)}
          </span>
          <span className="video-card-desc">{template.description}</span>
        </span>
      </button>
    </li>
  );
}

function TemplateDetail({
  template,
  creating,
  failed,
  onBack,
  onUse,
}: {
  template: VideoTemplate;
  creating: boolean;
  failed: boolean;
  onBack: () => void;
  onUse: (aspect: Aspect) => void;
}) {
  const { t } = useI18n();
  const [aspect, setAspect] = useState<Aspect>(template.aspect);
  return (
    <div className="video-template-detail">
      <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
        <IconArrowLeft size={14} />
        {t.video.back}
      </button>
      <div className="video-template-detail-body">
        <div className="video-template-detail-player">
          <TemplatePreview id={template.id} aspect={aspect} compact={false} />
        </div>
        <div className="video-template-detail-info">
          <h2 className="video-detail-title">{template.title}</h2>
          <p className="video-hint">{template.description}</p>
          <p className="video-field-label" id="video-template-format">
            {t.video.formatLabel}
          </p>
          <div className="video-segmented" role="radiogroup" aria-labelledby="video-template-format">
            {ASPECTS.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={aspect === a}
                className={`video-seg${aspect === a ? " active" : ""}`}
                onClick={() => setAspect(a)}
              >
                {t.video.aspectNames[a]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={creating}
            aria-label={t.video.useTemplateLabel(template.title)}
            onClick={() => onUse(aspect)}
          >
            {creating ? t.video.creating : t.video.useTemplate}
          </button>
          {failed && (
            <p className="inline-error" role="alert">
              {t.video.createFailed}
            </p>
          )}
          {template.attribution && <p className="video-credit">{t.video.credit(template.attribution)}</p>}
        </div>
      </div>
    </div>
  );
}

function relativeDate(ms: number, locale: string): string {
  if (!ms) return "";
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "es-ES", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

export function VideosSurface({
  profileId,
  active,
  projectId,
  onOpenProject,
  onClose,
  onAskAssistant,
}: {
  profileId: string;
  active: boolean;
  /// The project open in the editor (null: the lists).
  projectId: string | null;
  onOpenProject: (projectId: string | null) => void;
  onClose: () => void;
  onAskAssistant: (text: string) => void;
}) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>("mine");
  const [projects, setProjects] = useState<VideoSummary[] | null | "failed">(null);
  const [templates, setTemplates] = useState<VideoTemplate[] | null | "failed">(null);
  const [detail, setDetail] = useState<VideoTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const loadProjects = useCallback(() => {
    videoList(profileId)
      .then((list) => {
        setProjects(list);
        if (list.length === 0) setTab((prev) => (prev === "mine" ? "templates" : prev));
      })
      .catch(() => setProjects("failed"));
  }, [profileId]);

  useEffect(() => {
    if (active && projectId === null) loadProjects();
  }, [active, projectId, loadProjects]);

  useEffect(() => {
    videoTemplates(locale)
      .then(setTemplates)
      .catch(() => setTemplates("failed"));
  }, [locale]);

  const startFromTemplate = (template: VideoTemplate, aspect: Aspect) => {
    setCreating(true);
    setCreateFailed(false);
    videoCreateFromTemplate(profileId, template.id, aspect, locale)
      .then((id) => {
        setDetail(null);
        onOpenProject(id);
      })
      .catch(() => setCreateFailed(true))
      .finally(() => setCreating(false));
  };

  const remove = (project: VideoSummary) => {
    if (!window.confirm(t.video.deleteConfirm(project.title))) return;
    setDeleteFailed(false);
    videoDelete(profileId, project.id)
      .then(loadProjects)
      .catch(() => setDeleteFailed(true));
  };

  if (!active) return null;

  if (projectId !== null) {
    return (
      <section className="videos editing">
        <VideoEditor
          key={projectId}
          profileId={profileId}
          projectId={projectId}
          onClose={() => onOpenProject(null)}
          onAskAssistant={onAskAssistant}
        />
      </section>
    );
  }

  return (
    <section className="videos" aria-labelledby="videos-title">
      <header className="studio-header">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          <IconArrowLeft size={16} />
          {t.video.back}
        </button>
        <h1 id="videos-title" className="studio-title">
          {t.video.surfaceTitle}
        </h1>
        <div className="video-tabs" role="tablist" aria-label={t.video.tabsLabel}>
          {(["mine", "templates"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`videos-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`videos-panel-${id}`}
              className={`video-tab${tab === id ? " active" : ""}`}
              onClick={() => {
                setTab(id);
                setDetail(null);
              }}
            >
              {id === "mine" ? t.video.tabMine : t.video.tabTemplates}
            </button>
          ))}
        </div>
      </header>

      <div className="videos-body">
        {tab === "mine" ? (
          <div id="videos-panel-mine" role="tabpanel" aria-labelledby="videos-tab-mine">
            {projects === null && <p className="video-note">{t.video.loadingList}</p>}
            {projects === "failed" && (
              <p className="inline-error" role="alert">
                {t.video.listFailed}
              </p>
            )}
            {deleteFailed && (
              <p className="inline-error" role="alert">
                {t.video.deleteFailed}
              </p>
            )}
            {Array.isArray(projects) && projects.length === 0 && (
              <div className="video-empty">
                <IconFilm size={28} />
                <h2>{t.video.emptyTitle}</h2>
                <p className="video-hint">{t.video.emptyHint}</p>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setTab("templates")}>
                  <IconPlus size={14} />
                  {t.video.browseTemplates}
                </button>
              </div>
            )}
            {Array.isArray(projects) && projects.length > 0 && (
              <ul className="video-grid">
                {projects.map((project) => (
                  <li key={project.id} className="video-card">
                    <button
                      type="button"
                      className="video-card-main"
                      aria-label={t.video.openLabel(project.title)}
                      onClick={() => onOpenProject(project.id)}
                    >
                      <span className={`video-thumb aspect-${project.aspect.replace(":", "x")}`}>
                        {project.template ? (
                          <img src={templatePoster(project.template)} alt="" loading="lazy" />
                        ) : (
                          <IconFilm size={28} />
                        )}
                      </span>
                      <span className="video-card-text">
                        <span className="video-card-title">{project.title}</span>
                        <span className="video-card-meta">
                          <span className="video-aspect">{project.aspect}</span>
                          {formatTime(project.duration)} · {t.video.scenesCount(project.scenes)}
                        </span>
                        <span className="video-card-desc">{t.video.updated(relativeDate(project.updated_ms, locale))}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn video-card-delete"
                      aria-label={t.video.deleteLabel(project.title)}
                      title={t.video.delete}
                      onClick={() => remove(project)}
                    >
                      <IconTrash size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div id="videos-panel-templates" role="tabpanel" aria-labelledby="videos-tab-templates">
            {detail ? (
              <TemplateDetail
                template={detail}
                creating={creating}
                failed={createFailed}
                onBack={() => setDetail(null)}
                onUse={(aspect) => startFromTemplate(detail, aspect)}
              />
            ) : (
              <>
                <p className="video-hint video-lede">{t.video.templatesLede}</p>
                {templates === "failed" && (
                  <p className="inline-error" role="alert">
                    {t.video.templatesFailed}
                  </p>
                )}
                {Array.isArray(templates) && (
                  <ul className="video-grid">
                    {templates.map((template) => (
                      <TemplateCard
                        key={template.id}
                        template={template}
                        onOpen={() => {
                          setCreateFailed(false);
                          setDetail(template);
                        }}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
