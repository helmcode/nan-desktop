// Round 25: does every format of a video show it whole? An export in a
// format other than the project's own only resizes the canvas
// (`render::with_aspect`), so a layout written for one shape can come out
// cut off in another. This runs the shared layout probe
// (src-tauri/src/video/layout_probe.js, the same check CI runs on every
// template) on the project assembled at each aspect, in a hidden frame
// sized to the canvas, and collects what it reports.
//
// Isolation: the frame is the same sandboxed, opaque-origin, no-network
// document a preview is (`nan-site` scheme, `sandbox="allow-scripts"`);
// it can only post a message, accepted from that exact frame and
// re-validated here (shape, sizes, counts). Its text comes from the
// composition (possibly hostile): it is only shown escaped and sent to the
// assistant as untrusted data (src-tauri/src/video/context.rs).
//
// Cost: one aspect at a time, ONE check in the whole app at a time; the
// probe samples at most 48 moments within an 8 s budget, a frame that does
// not answer within FRAME_TIMEOUT_MS counts as "could not check" (null),
// which never blocks anything, and a whole check never takes more than
// CHECK_BUDGET_MS (counted from the call): formats it did not reach in
// time are null too. A check can be aborted (AbortSignal): the frame goes
// right away and the remaining formats are null.

import { releaseSitePreview } from "../core";
import { videoLayoutProbe, type Aspect } from "./api";

export type LayoutIssueKind = "clipped" | "offframe";

export interface LayoutIssue {
  scene: string;
  /// Film seconds.
  time: number;
  /// `clipped`: partly in frame and touching the edge (cut off);
  /// `offframe`: entirely outside when the scene settles.
  kind: LayoutIssueKind;
  /// `#id "start of its text"`.
  element: string;
}

/// Per checked aspect: the issues (empty = OK) or null (could not check).
export type LayoutReport = Partial<Record<Aspect, LayoutIssue[] | null>>;

/// The message type the probe posts.
export const PROBE_MESSAGE = "nan-layout-probe";
/// How long one aspect may take before it counts as "could not check".
export const FRAME_TIMEOUT_MS = 15000;
/// How long a whole check (every aspect, any wait for another check
/// included) may take.
export const CHECK_BUDGET_MS = 20000;
/// Most issues kept per aspect.
export const MAX_ISSUES = 40;
const MAX_TEXT = 120;

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  // Control and bidi/format characters out, whitespace collapsed.
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, max) : null;
}

/// The issues a probe message carries, validated; null when it is not a
/// usable report (an error, a cut-short check that found nothing, junk).
export function parseProbeMessage(data: unknown): LayoutIssue[] | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { type?: unknown; issues?: unknown; complete?: unknown; error?: unknown };
  if (message.type !== PROBE_MESSAGE || message.error !== undefined || !Array.isArray(message.issues)) return null;
  const issues: LayoutIssue[] = [];
  for (const raw of message.issues.slice(0, MAX_ISSUES)) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const scene = text(item.scene, 64);
    const element = text(item.element);
    const kind = item.kind === "clipped" || item.kind === "offframe" ? item.kind : null;
    const time = typeof item.time === "number" && Number.isFinite(item.time) && item.time >= 0 ? item.time : null;
    if (scene && element && kind && time !== null) issues.push({ scene, time, kind, element });
  }
  // Cut short by its budget with nothing found: not a pass, just unknown.
  if (message.complete !== true && issues.length === 0) return null;
  return issues;
}

/// Where the hidden frames live: a viewport-sized, clipped, invisible box
/// (in the viewport, so the webview keeps laying the frame out; clipped, so
/// a 1920 px frame never scrolls the app).
function host(): HTMLElement {
  const box = document.createElement("div");
  box.className = "video-layout-probe";
  box.setAttribute("aria-hidden", "true");
  // Never focusable and never the target of a key or a click.
  box.setAttribute("inert", "");
  box.style.cssText = "position:fixed;inset:0;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;contain:strict";
  document.body.appendChild(box);
  return box;
}

/// Check one aspect in a hidden frame.
export async function checkAspect(
  profileId: string,
  projectId: string,
  aspect: Aspect,
  { timeoutMs = FRAME_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LayoutIssue[] | null> {
  if (signal?.aborted || timeoutMs <= 0) return null;
  let info;
  try {
    info = await videoLayoutProbe(profileId, projectId, aspect);
  } catch {
    return null;
  }
  if (signal?.aborted) {
    releaseSitePreview(info.url);
    return null;
  }
  const box = host();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("title", "layout check");
  frame.style.cssText = `position:absolute;left:0;top:0;border:0;width:${info.width}px;height:${info.height}px`;
  try {
    return await new Promise<LayoutIssue[] | null>((resolve) => {
      const timer = window.setTimeout(() => finish(null), timeoutMs);
      function onMessage(event: MessageEvent) {
        // Only this frame's answer counts (a player's frame posts too).
        if (event.source !== frame.contentWindow || frame.contentWindow === null) return;
        const data = event.data as { type?: unknown } | null;
        if (typeof data !== "object" || data === null || data.type !== PROBE_MESSAGE) return;
        finish(parseProbeMessage(event.data));
      }
      const onAbort = () => finish(null);
      function finish(result: LayoutIssue[] | null) {
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      }
      window.addEventListener("message", onMessage);
      signal?.addEventListener("abort", onAbort);
      frame.src = info.url;
      box.appendChild(frame);
    });
  } finally {
    box.remove();
    releaseSitePreview(info.url);
  }
}

let chain: Promise<unknown> = Promise.resolve();

export interface CheckOptions {
  /// The whole check's budget (ms, from the call).
  budgetMs?: number;
  /// Abort: the remaining formats are null.
  signal?: AbortSignal;
  /// The aspect being checked now (progress for the UI).
  onAspect?: (aspect: Aspect) => void;
}

/// Check these aspects one after another (and after any check already
/// running anywhere in the app). Every requested aspect is in the report.
export function checkLayout(
  profileId: string,
  projectId: string,
  aspects: readonly Aspect[],
  { budgetMs = CHECK_BUDGET_MS, signal, onAspect }: CheckOptions = {},
): Promise<LayoutReport> {
  const deadline = Date.now() + budgetMs;
  const run = async (): Promise<LayoutReport> => {
    const report: LayoutReport = {};
    for (const aspect of aspects) {
      const left = Math.min(FRAME_TIMEOUT_MS, deadline - Date.now());
      if (signal?.aborted || left <= 0) {
        report[aspect] = null;
        continue;
      }
      onAspect?.(aspect);
      report[aspect] = await checkAspect(profileId, projectId, aspect, { timeoutMs: left, signal });
    }
    return report;
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

/// The aspects (in the given order) with at least one issue.
export function brokenAspects(report: LayoutReport, order: readonly Aspect[]): Aspect[] {
  return order.filter((aspect) => (report[aspect]?.length ?? 0) > 0);
}

/// Most lines sent to the assistant (the core accepts 12).
export const MAX_PROBLEM_LINES = 12;

/// The issues as lines for the assistant (English, technical), spread over
/// the broken aspects, capped.
export function layoutProblems(report: LayoutReport, order: readonly Aspect[], max = MAX_PROBLEM_LINES): string[] {
  const per = brokenAspects(report, order).map((aspect) => (report[aspect] ?? []).map((issue) => ({ aspect, issue })));
  const lines: string[] = [];
  // Round-robin so every broken format is named.
  for (let i = 0; lines.length < max && per.some((list) => i < list.length); i++) {
    for (const list of per) {
      if (i >= list.length || lines.length >= max) continue;
      const { aspect, issue } = list[i];
      const what = issue.kind === "clipped" ? "cut off at the edge of the frame" : "outside the frame when the scene settles";
      lines.push(`${aspect} (${CANVAS[aspect]}): scene ${issue.scene} at ${issue.time} s: ${issue.element} is ${what}`);
    }
  }
  return lines;
}

const CANVAS: Record<Aspect, string> = { "16:9": "1920x1080", "9:16": "1080x1920", "1:1": "1080x1080" };
