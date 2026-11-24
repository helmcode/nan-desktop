// R-V1: the official HyperFrames lint (@hyperframes/lint, pinned) on a
// project's sources, in the renderer. The core already enforces the hard
// rules (no network, no GSAP, determinism) when anything is written; this
// adds the format checks the render service applies, so problems show up
// (and can be sent to the assistant) BEFORE an export is paid for.
// Loaded on demand: it pulls its parser dependencies into a lazy chunk.

import type { VideoProject } from "./api";

export interface LintProblem {
  file: string;
  severity: "error" | "warning";
  code: string;
  message: string;
}

export async function lintProject(project: Pick<VideoProject, "sources">): Promise<LintProblem[]> {
  const { lintHyperframeHtml } = await import("@hyperframes/lint/browser");
  const problems: LintProblem[] = [];
  const add = (file: string, result: Awaited<ReturnType<typeof lintHyperframeHtml>>) => {
    for (const finding of result.findings) {
      if (finding.severity === "info") continue;
      problems.push({ file, severity: finding.severity, code: finding.code, message: finding.message });
    }
  };
  add("index.html", await lintHyperframeHtml(project.sources.index, { filePath: "index.html", distributed: true }));
  for (const scene of project.sources.scenes) {
    const file = `compositions/${scene.id}.html`;
    add(file, await lintHyperframeHtml(scene.html, { filePath: file, isSubComposition: true, distributed: true }));
  }
  return problems;
}

/// The problems as lines for the assistant (errors first, capped).
export function problemsForAssistant(problems: LintProblem[], max = 12): string {
  return [...problems]
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
    .slice(0, max)
    .map((p) => `- ${p.file}: ${p.code}: ${p.message.slice(0, 240)}`)
    .join("\n");
}
