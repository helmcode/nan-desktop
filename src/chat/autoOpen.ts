// Round 4: the preview pane opens what the assistant (or the composer's
// image mode) just produced, so the user never has to guess among chips.
//
// Rules:
// - only the reply that JUST finished counts (the newest assistant row);
//   switching conversations never re-opens anything by itself;
// - within that reply the LAST produced artifact wins (later artifacts
//   replace earlier ones);
// - a generated image (composer image row `media_path`, or an `image`
//   artifact from the generate_image tool) opens as a `media` target ,
//   it lives under app_data/images and is shown through the asset
//   protocol; a produced file opens as a `file` target (grant-checked read);
// - the user can still close the pane: a reply that produced nothing new
//   leaves the pane as the user left it.

import type { ChatMessageRow } from "../types";
import type { PreviewTarget } from "../preview/kind";

export function lastProducedTarget(rows: ChatMessageRow[]): PreviewTarget | null {
  const last = [...rows].reverse().find((row) => row.role === "assistant");
  if (!last) return null;
  if (last.media_path) return { kind: "media", ref: last.media_path };
  const artifacts = last.artifacts ?? [];
  const artifact = artifacts[artifacts.length - 1];
  if (!artifact || typeof artifact.path !== "string" || artifact.path.length === 0) return null;
  return { kind: artifact.kind === "image" ? "media" : "file", ref: artifact.path };
}
