// "Show in folder" for a previewed local file: the core re-checks the path
// against the profile's grants (the same checks as the preview read) and
// asks the OS file manager to show it selected in its folder. The file is
// never opened, and the renderer holds no opener permission of its own.

import { invoke } from "@tauri-apps/api/core";

export function revealInFolder(profileId: string, path: string): Promise<void> {
  return invoke<void>("preview_reveal_location", { profileId, path });
}
