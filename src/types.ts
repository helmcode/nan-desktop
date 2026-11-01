// IPC payload shapes shared by the screens. The renderer never sees profile
// URLs, API keys or session tokens (S4/S12): only ids, names, classified
// error kinds and the user's own content cross the boundary.

export interface ProfileView {
  id: string;
  name: string;
  has_key: boolean;
  key_mask: string | null;
}

export interface ProfileOverview {
  profiles: ProfileView[];
  active_profile: string | null;
}

export interface WebSource {
  title: string;
  url: string;
}

export interface ConversationView {
  id: number;
  title: string;
  updated_at: string;
  last_message: string | null;
}

export interface ChatMessageRow {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  model: string | null;
  created_at: string;
  // Crash leftovers of a mid-stream kill — the reply never finished.
  partial: boolean;
  // Absolute path of a generated image (assistant image rows only).
  media_path: string | null;
  // Web pages the reply cited (built-in web search).
  sources: WebSource[];
}

export type GrantScope = "folder" | "computer_wide";

export interface GrantView {
  id: string;
  canonical_path: string;
  granted_at: string;
  profile_id: string;
  scope: GrantScope;
}

export interface ToolsSettingsView {
  tools_allow_run_command: boolean;
}

export type MemoryMode = "remote" | "local";

export interface MemorySettingsView {
  mode: MemoryMode;
}

export interface AppInfo {
  version: string;
}
