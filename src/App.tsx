import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";

// Must match `KEYRING_SERVICE` in src-tauri/src/profile.rs. API keys live in
// the OS keychain under this service, with account = profile id (S4).
const KEYRING_SERVICE = "com.helmcode.nan.desktop";

const DEFAULT_SSE_URL = "http://127.0.0.1:14321/events";

interface ProfileView {
  id: string;
  name: string;
  base_url: string;
  has_key: boolean;
  key_mask: string | null;
}

interface ProfileOverview {
  profiles: ProfileView[];
  active_profile: string | null;
}

interface ConnectionTestResult {
  ok: boolean;
  status_code: number | null;
  model_count: number | null;
  latency_ms: number | null;
  error: string | null;
}

interface SseChunkPayload {
  seq: number;
  text: string;
}

interface Message {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

type Screen = "loading" | "error" | "onboarding" | "chat";

// Security posture: a key value is never rendered. Real profile masks come
// from the Rust core (`ProfileView.key_mask`); this helper only ever masks
// the demo value typed into the T1 spike panel, also last-4 only.
function maskValue(value: string): string {
  return `••••${value.slice(-4)}`;
}

function testResultLabel(result: ConnectionTestResult): string {
  if (result.ok) {
    return `connected — ${result.model_count} model(s) available, ${result.latency_ms} ms`;
  }
  let label = result.error ?? "connection failed";
  if (result.status_code !== null && !label.includes(String(result.status_code))) {
    label += ` (HTTP ${result.status_code})`;
  }
  return label;
}

// Onboarding (S2): pick a profile, enter its API key, test the connection,
// then store the key in the OS keychain and activate the profile.
//
// `lockToId` re-runs key entry for one profile ("Replace key" from the chat
// shell); `null` shows the full profile-card picker ("Switch profile").
function Onboarding({
  overview,
  lockToId,
  onOverview,
  onSaved,
  onCancel,
}: {
  overview: ProfileOverview;
  lockToId: string | null;
  onOverview: (next: ProfileOverview) => void;
  onSaved: (next: ProfileOverview) => void;
  onCancel?: () => void;
}) {
  const [selectedId, setSelectedId] = useState(
    lockToId ?? overview.active_profile ?? overview.profiles[0]?.id ?? "",
  );
  const [customMode, setCustomMode] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = overview.profiles.find((p) => p.id === selectedId) ?? null;
  const replaceMode = lockToId !== null;
  // A key must be entered when there is none stored yet, or when replacing
  // an existing one. When the profile already has a key, continuing keeps it.
  const needKey = selected !== null && (replaceMode || !selected.has_key);
  const keyReady = keyValue.trim() !== "";

  function selectProfile(id: string): void {
    setCustomMode(false);
    setSelectedId(id);
    setKeyValue("");
    setTestResult(null);
    setStatus("");
  }

  async function addCustom(): Promise<void> {
    setBusy(true);
    setStatus("");
    try {
      const next = await invoke<ProfileOverview>("profile_add", {
        name: customName,
        baseUrl: customBaseUrl,
      });
      onOverview(next);
      const added = next.profiles[next.profiles.length - 1];
      setSelectedId(added.id);
      setCustomMode(false);
      setCustomName("");
      setCustomBaseUrl("");
      setKeyValue("");
      setTestResult(null);
      setStatus(`profile "${added.name}" added`);
    } catch (err) {
      setStatus(`error: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setStatus("");
    try {
      const result = await invoke<ConnectionTestResult>("connection_test", {
        profileId: selected.id,
        // Pre-save test uses the typed key; empty field tests the stored one.
        key: keyReady ? keyValue : null,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        status_code: null,
        model_count: null,
        latency_ms: null,
        error: String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function saveAndContinue(): Promise<void> {
    if (!selected) return;
    if (needKey && !keyReady) {
      setStatus("enter an API key first");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      if (needKey) {
        await invoke("keyring_set", {
          service: KEYRING_SERVICE,
          account: selected.id,
          value: keyValue,
        });
      }
      const next = await invoke<ProfileOverview>("profile_set_active", {
        profileId: selected.id,
      });
      setKeyValue(""); // clear the secret from component state immediately
      setTestResult(null);
      onSaved(next);
    } catch (err) {
      setStatus(`error: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>{replaceMode ? "Replace API key" : "Welcome — set up your connection"}</h2>
      {!replaceMode && (
        <>
          <p className="hint">
            Choose the inference API to use (S2). The API key is stored in the
            OS keychain (S4) — never in a file, never rendered in full.
          </p>
          <div className="cards">
            {overview.profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`card${p.id === selectedId ? " selected" : ""}`}
                onClick={() => selectProfile(p.id)}
              >
                <strong>{p.name}</strong>
                <span className="hint">{p.base_url}</span>
                <span className="hint">
                  {p.has_key ? `key stored ${p.key_mask}` : "no key yet"}
                </span>
              </button>
            ))}
            <button
              type="button"
              className={`card${customMode ? " selected" : ""}`}
              onClick={() => {
                setSelectedId("");
                setKeyValue("");
                setTestResult(null);
                setStatus("");
                setCustomMode(true);
              }}
            >
              <strong>Custom…</strong>
              <span className="hint">any OpenAI-compatible base URL</span>
              <span className="hint">http only for 127.0.0.1/localhost</span>
            </button>
          </div>
        </>
      )}

      {customMode && (
        <>
          <div className="row-h">
            <input
              value={customName}
              onChange={(e) => setCustomName(e.currentTarget.value)}
              placeholder="Profile name (e.g. My proxy)"
            />
          </div>
          <div className="row-h">
            <input
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.currentTarget.value)}
              placeholder="https://host/v1"
            />
          </div>
          <button
            type="button"
            onClick={addCustom}
            disabled={busy || customName.trim() === "" || customBaseUrl.trim() === ""}
          >
            Add profile
          </button>
        </>
      )}

      {selected && (
        <>
          <p className="status">
            {selected.name} — <code>{selected.base_url}</code>
            {selected.has_key && !replaceMode ? ` — key stored ${selected.key_mask}` : ""}
          </p>
          {needKey && (
            <div className="row-h">
              <input
                type="password"
                value={keyValue}
                onChange={(e) => setKeyValue(e.currentTarget.value)}
                placeholder={selected.has_key ? "new API key" : "API key"}
                autoComplete="off"
              />
            </div>
          )}
          <div className="row-h">
            <button
              type="button"
              onClick={testConnection}
              disabled={busy || !(keyReady || selected.has_key)}
            >
              Test connection
            </button>
            <button
              type="button"
              onClick={saveAndContinue}
              disabled={busy || (needKey && !keyReady)}
            >
              Save and continue
            </button>
            {onCancel && (
              <button type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
          {testResult && (
            <p className={testResult.ok ? "status ok" : "status err"}>
              {testResult.ok ? "✓ " : "✗ "}
              {testResultLabel(testResult)}
            </p>
          )}
        </>
      )}
      {status && <p className="status">{status}</p>}
    </section>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [loadError, setLoadError] = useState("");
  const [overview, setOverview] = useState<ProfileOverview | null>(null);
  const [replaceKey, setReplaceKey] = useState(false);

  // (a) SSE demo (T1 spike panel)
  const [sseUrl, setSseUrl] = useState(DEFAULT_SSE_URL);
  const [chunks, setChunks] = useState<string[]>([]);
  const [sseStatus, setSseStatus] = useState<
    "idle" | "streaming" | "done" | "error"
  >("idle");
  const [sseError, setSseError] = useState("");

  // (b) Keychain demo (T1 spike panel)
  const [krService, setKrService] = useState("nan-desktop-spike");
  const [krAccount, setKrAccount] = useState("demo-api-key");
  const [krValue, setKrValue] = useState("");
  const [krStatus, setKrStatus] = useState("");

  // (c) SQLite demo (T1 spike panel)
  const [messages, setMessages] = useState<Message[]>([]);
  const [dbStatus, setDbStatus] = useState("");

  const loadOverview = useCallback(
    async (): Promise<ProfileOverview> => invoke<ProfileOverview>("profiles_load"),
    [],
  );

  // After a profile is activated (onboarding finished), enter the chat shell
  // — unless the active profile has no key, which keeps onboarding up.
  const enterApp = useCallback((next: ProfileOverview): void => {
    setOverview(next);
    setReplaceKey(false);
    const active = next.profiles.find((p) => p.id === next.active_profile);
    setScreen(active && active.has_key ? "chat" : "onboarding");
  }, []);

  const retryLoad = useCallback((): void => {
    setScreen("loading");
    loadOverview()
      .then(enterApp)
      .catch((err) => {
        setLoadError(String(err));
        setScreen("error");
      });
  }, [loadOverview, enterApp]);

  useEffect(() => {
    let cancelled = false;
    loadOverview()
      .then((next) => {
        if (!cancelled) enterApp(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(String(err));
        setScreen("error");
      });
    return () => {
      cancelled = true;
    };
  }, [loadOverview, enterApp]);

  // Rust → frontend event transport for the spike panel (S4). Registered
  // once; cleanup on unmount.
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [
      listen<SseChunkPayload>("sse://chunk", (event) => {
        setChunks((prev) => [...prev, event.payload.text]);
        setSseStatus("streaming");
      }),
      listen<number>("sse://done", () => setSseStatus("done")),
      listen<string>("sse://error", (event) => {
        setSseError(event.payload);
        setSseStatus("error");
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        promise.then((unlisten) => unlisten());
      });
    };
  }, []);

  async function startSse(): Promise<void> {
    setChunks([]);
    setSseError("");
    setSseStatus("streaming");
    try {
      await invoke("sse_demo_start", { url: sseUrl });
    } catch (err) {
      setSseError(String(err));
      setSseStatus("error");
    }
  }

  async function keyringSet(): Promise<void> {
    try {
      await invoke("keyring_set", {
        service: krService,
        account: krAccount,
        value: krValue,
      });
      setKrStatus("stored in the OS keychain");
      setKrValue(""); // do not keep the secret in the DOM
    } catch (err) {
      setKrStatus(`error: ${String(err)}`);
    }
  }

  async function keyringGet(): Promise<void> {
    try {
      const value = await invoke<string | null>("keyring_get", {
        service: krService,
        account: krAccount,
      });
      setKrStatus(
        value === null ? "no entry found" : `retrieved: ${maskValue(value)}`,
      );
    } catch (err) {
      setKrStatus(`error: ${String(err)}`);
    }
  }

  async function runDbDemo(): Promise<void> {
    try {
      const rows = await invoke<Message[]>("db_demo");
      setMessages(rows);
      setDbStatus(`${rows.length} row(s) returned (last 10 by id)`);
    } catch (err) {
      setDbStatus(`error: ${String(err)}`);
    }
  }

  if (screen === "loading") {
    return (
      <main className="container">
        <h1>nan-desktop</h1>
        <p className="status">Loading profiles…</p>
      </main>
    );
  }

  if (screen === "error") {
    return (
      <main className="container">
        <h1>nan-desktop</h1>
        <p className="status err">Failed to load profiles: {loadError}</p>
        <button type="button" onClick={retryLoad}>
          Retry
        </button>
      </main>
    );
  }

  if (!overview) {
    return null; // unreachable: chat/onboarding imply a loaded overview
  }

  const activeProfile =
    overview.profiles.find((p) => p.id === overview.active_profile) ?? null;

  if (screen === "onboarding" || replaceKey) {
    return (
      <main className="container">
        <h1>nan-desktop</h1>
        <Onboarding
          overview={overview}
          lockToId={replaceKey && activeProfile ? activeProfile.id : null}
          onOverview={setOverview}
          onSaved={enterApp}
          onCancel={replaceKey ? () => setReplaceKey(false) : undefined}
        />
      </main>
    );
  }

  return (
    <main className="container">
      <h1>nan-desktop</h1>

      <section className="panel">
        <h2>Chat</h2>
        <p>
          Active profile: <strong>{activeProfile?.name}</strong> —{" "}
          <code>{activeProfile?.base_url}</code>
        </p>
        <p>
          API key stored {activeProfile?.key_mask ?? ""}{" "}
          <button type="button" onClick={() => setReplaceKey(true)}>
            Replace key
          </button>
        </p>
        <p className="hint">
          Chat streaming (SSE), markdown rendering and local history arrive in
          T4 — this screen is a placeholder proving onboarding finished.
        </p>
        <button type="button" onClick={() => setScreen("onboarding")}>
          Switch profile
        </button>
      </section>

      {/* T1 spike diagnostics, kept working and collapsed below the app. */}
      <details className="panel">
        <summary>T1 spike diagnostics (SSE / keychain / SQLite)</summary>

        <section className="panel">
          <h2>SSE demo (Rust → UI)</h2>
          <p className="hint">
            Requires the mock server: <code>node test/mock-sse.mjs</code>
          </p>
          <div className="row-h">
            <input
              value={sseUrl}
              onChange={(e) => setSseUrl(e.currentTarget.value)}
              placeholder="SSE URL"
            />
            <button type="button" onClick={startSse}>
              Start
            </button>
          </div>
          <p className="status">
            status: {sseStatus}
            {sseError ? ` — ${sseError}` : ""}
          </p>
          <ul className="chunk-list">
            {chunks.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>Keychain (OS credential store)</h2>
          <div className="row-h">
            <input
              value={krService}
              onChange={(e) => setKrService(e.currentTarget.value)}
              placeholder="service"
            />
            <input
              value={krAccount}
              onChange={(e) => setKrAccount(e.currentTarget.value)}
              placeholder="account"
            />
          </div>
          <div className="row-h">
            <input
              type="password"
              value={krValue}
              onChange={(e) => setKrValue(e.currentTarget.value)}
              placeholder="value to store"
            />
            <button type="button" onClick={keyringSet}>
              Set
            </button>
            <button type="button" onClick={keyringGet}>
              Get
            </button>
          </div>
          <p className="status">{krStatus}</p>
        </section>

        <section className="panel">
          <h2>SQLite (local history foundation)</h2>
          <div className="row-h">
            <button type="button" onClick={runDbDemo}>
              Insert demo row + list last 10
            </button>
          </div>
          <p className="status">{dbStatus}</p>
          <ul className="chunk-list">
            {messages.map((m) => (
              <li key={m.id}>
                #{m.id} [{m.role}] {m.content} — {m.created_at}
              </li>
            ))}
          </ul>
        </section>
      </details>
    </main>
  );
}

export default App;
