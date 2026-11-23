// R-V1 test fixtures shared by the video component tests.
import type { VideoPreviewInfo, VideoProject } from "./api";

export const PROJECT_ID = "0123456789abcdef0123456789abcdef";
export const TOKEN = "fedcba9876543210fedcba9876543210";

export function project(overrides: Partial<VideoProject> = {}): VideoProject {
  return {
    id: PROJECT_ID,
    duration: 7.5,
    width: 1920,
    height: 1080,
    size: 1234,
    assets: [],
    exports: [],
    sources: { index: "<!doctype html>", scenes: [] },
    meta: {
      format: 1,
      hyperframes: "0.9.86",
      title: "Promo",
      aspect: "16:9",
      fps: 30,
      scenes: [
        { id: "intro", title: "Inicio", duration: 3 },
        { id: "cta", title: "Cierre", duration: 4.5 },
      ],
      variables: [
        { id: "headline", type: "text", label: "Titular", value: "Hola" },
        { id: "accent", type: "color", label: "Color de acento", value: "#7c6cff" },
        { id: "logo", type: "image", label: "Logo", value: "assets/logo.svg" },
      ],
      audio: { music: { file: "assets/song.mp3", volume: 0.6 } },
    },
    ...overrides,
  };
}

export const PREVIEW: VideoPreviewInfo = {
  url: `nan-site://localhost/${TOKEN}`,
  title: "Promo",
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 7.5,
  aspect: "16:9",
};
