import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";

// The renderer never sees profile URLs (S4/S12): profiles arrive as
// {id, name, has_key, key_mask} from the Rust core, and all HTTP — including
// the device-flow calls — happens in Rust.

interface ProfileView {
  id: string;
  name: string;
  has_key: boolean;
  key_mask: string | null;
}

interface ProfileOverview {
  profiles: ProfileView[];
  active_profile: string | null;
}

// Device-flow payloads (Rust core → renderer). Only non-secret fields cross
// the IPC boundary: the user_code, the status, the key alias (S4).
interface DeviceStarted {
  user_code: string;
}
interface DeviceStatus {
  status: string;
}
interface DeviceApproved {
  key_alias: string;
  profile_id: string;
}
interface DeviceError {
  kind: string;
}

// One-line description per locked profile (S2: exactly two, no URLs).
const PROFILE_DESCRIPTIONS: Record<string, string> = {
  nan: "Inference for the NaN builders community.",
  helmcode: "Self-service inference for your team.",
};

const ERROR_KIND_LABELS: Record<string, string> = {
  network: "Could not reach the sign-in service. Check your connection and try again.",
  timeout: "The sign-in service took too long to answer. Try again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  server: "The sign-in service reported an error. Try again.",
  protocol: "Something went wrong on this device. Try again.",
};

type Screen = "loading" | "error" | "picker" | "authorizing" | "chat";
type AuthPhase = "waiting" | "denied" | "expired" | "error";

interface SseChunkPayload {
  seq: number;
  text: string;
}

interface Message {
  id: number;
  content: string;
  created_at: string;
  role: string;
}

// Security posture: a key value is never rendered. This helper only ever
// masks the demo value typed into the T1 spike panel, last-4 only.
function maskValue(value: string): string {
  return `••••${value.slice(-4)}`;
}

function errorLabel(kind: string): string {
  return ERROR_KIND_LABELS[kind] ?? "Something went wrong. Try again.";
}

function Authorizing({
  profileName,
  userCode,
  phase,
  errorKind,
  pollCount,
  onTryAgain,
  onPickAnother,
  onCancel,
}: {
  profileName: string;
  userCode: string;
  phase: AuthPhase;
  errorKind: string;
  pollCount: number;
  onTryAgain: () => void;
  onPickAnother: () => void;
  onCancel: () => void;
}) {
  const waiting = phase === "waiting";
  const headline =
    phase === "denied"
      ? "Sign-in denied"
      : phase === "expired"
        ? "Sign-in request expired"
        : phase === "error"
          ? "Sign-in failed"
          : `Authorizing ${profileName}`;

  return (
    <main className="screen">
      <p className="brand">{"// nan-desktop"}</p>
      <h1>{headline}</h1>
      {waiting ? (
        <>
          <p className="lede">Approve this device in your browser to sign in.</p>
          <div className="user-code" aria-label="device code">
            {userCode || "····-····"}
          </div>
          <p className="status-line">
            <span className="pulse-dot" />
            A browser window has opened — approve the device there.
          </p>
          <p className="status-line muted">
            <span className="dot" />
            Waiting for approval — checking every few seconds ({pollCount} check
            {pollCount === 1 ? "" : "s"}).
          </p>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="lede">
            {phase === "denied" &&
              "The request was denied in the browser. Nothing was stored on this device."}
            {phase === "expired" &&
              "The sign-in request expired. Start again to get a new code."}
            {phase === "error" && errorLabel(errorKind)}
          </p>
          <div className="user-code dimmed" aria-hidden="true">
            {userCode || "····-····"}
          </div>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={onTryAgain}>
              Try again
            </button>
            <button type="button" className="btn btn-ghost" onClick={onPickAnother}>
              Use a different profile
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function ProfilePicker({
  overview,
  busy,
  error,
  onPick,
}: {
  overview: ProfileOverview;
  busy: boolean;
  error: string;
  onPick: (id: string) => void;
}) {
  return (
    <main className="screen">
      <p className="brand">{"// nan-desktop"}</p>
      <h1>Sign in</h1>
      <p className="lede">
        Choose your workspace. Sign-in happens in your browser — no keys to paste.
      </p>
      <div className="cards">
        {overview.profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            className="card"
            onClick={() => onPick(p.id)}
            disabled={busy}
          >
            <strong>{p.name}</strong>
            <span>{PROFILE_DESCRIPTIONS[p.id] ?? ""}</span>
            {p.has_key && (
              <span className="card-meta">
                signed in before — key stored {p.key_mask}
              </span>
            )}
          </button>
        ))}
      </div>
      {error && <p className="status err">{error}</p>}
    </main>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [loadError, setLoadError] = useState("");
  const [overview, setOverview] = useState<ProfileOverview | null>(null);
  const [pickerError, setPickerError] = useState("");
  const [busy, setBusy] = useState(false);

  // Device-flow login state.
  const [authProfileId, setAuthProfileId] = useState<string | null>(null);
  const [authPhase, setAuthPhase] = useState<AuthPhase>("waiting");
  const [userCode, setUserCode] = useState("");
  const [pollCount, setPollCount] = useState(0);
  const [errorKind, setErrorKind] = useState("");
  const authProfileRef = useRef<string | null>(null);
  useEffect(() => {
    authProfileRef.current = authProfileId;
  }, [authProfileId]);

  // (a) SSE demo (T1 spike panel)
  const [sseUrl, setSseUrl] = useState("http://127.0.0.1:14321/events");
  const [chunks, setChunks] = useState<string[]>([]);
  const [sseStatus, setSseStatus] = useState<"idle" | "streaming" | "done" | "error">("idle");
  const [sseError, setSseError] = useState("");

  // (b) Keychain demo (T1 spike panel)
  const [krService, setKrService] = useState("nan-desktop-spike");
  const [krAccount, setKrAccount] = useState("demo-api-key");
  const [krValue, setKrValue] = useState("");
  const [krStatus, setKrStatus] = useState("");

  // (c) SQLite demo (T1 spike panel)
  const [messages, setMessages] = useState<Message[]>([]);
  const [dbStatus, setDbStatus] = useState("");

  const refreshOverview = useCallback(
    async (): Promise<ProfileOverview> => invoke<ProfileOverview>("profiles_load"),
    [],
  );

  const boot = useCallback(async (): Promise<void> => {
    setScreen("loading");
    try {
      const next = await refreshOverview();
      setOverview(next);
      const active = next.profiles.find((p) => p.id === next.active_profile);
      setScreen(active && active.has_key ? "chat" : "picker");
    } catch (err) {
      setLoadError(String(err));
      setScreen("error");
    }
  }, [refreshOverview]);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Rust → frontend event transport. Registered once; cleanup on unmount.
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [
      listen<DeviceStarted>("device://started", (event) => {
        setUserCode(event.payload.user_code);
      }),
      listen<DeviceStatus>("device://status", (event) => {
        if (event.payload.status === "pending") {
          setPollCount((count) => count + 1);
        }
      }),
      listen<DeviceApproved>("device://approved", (event) => {
        // Ignore stale approvals from an earlier, cancelled flow.
        if (authProfileRef.current !== event.payload.profile_id) return;
        refreshOverview()
          .then((next) => {
            setOverview(next);
            setAuthProfileId(null);
            setScreen("chat");
          })
          .catch((err) => {
            setLoadError(String(err));
            setScreen("error");
          });
      }),
      listen<DeviceStatus>("device://denied", () => setAuthPhase("denied")),
      listen<DeviceStatus>("device://expired", () => setAuthPhase("expired")),
      listen<DeviceError>("device://error", (event) => {
        setErrorKind(event.payload.kind);
        setAuthPhase("error");
      }),
    ];
    return () => {
      unlistens.forEach((promise) => {
        promise.then((unlisten) => unlisten());
      });
    };
  }, [refreshOverview]);

  // Spike-panel event transport (T1).
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

  const startLogin = useCallback(
    async (profileId: string): Promise<void> => {
      setBusy(true);
      setPickerError("");
      // Track the flow from before the request so no early event is missed.
      setAuthProfileId(profileId);
      setAuthPhase("waiting");
      setUserCode("");
      setPollCount(0);
      setErrorKind("");
      try {
        await invoke("device_login_start", { profileId });
        setScreen("authorizing");
      } catch (err) {
        setAuthProfileId(null);
        setPickerError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const cancelLogin = useCallback(async (): Promise<void> => {
    try {
      await invoke("device_login_cancel");
    } catch {
      // The loop may already have finished; nothing to undo.
    }
    setAuthProfileId(null);
    setScreen("picker");
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    const profileId = overview?.active_profile;
    if (!profileId) return;
    setBusy(true);
    try {
      await invoke("device_logout", { profileId });
      const next = await refreshOverview();
      setOverview(next);
      setScreen("picker");
    } catch (err) {
      setLoadError(String(err));
      setScreen("error");
    } finally {
      setBusy(false);
    }
  }, [overview, refreshOverview]);

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
      <main className="screen">
        <p className="brand">{"// nan-desktop"}</p>
        <p className="status-line muted">
          <span className="pulse-dot" /> Loading…
        </p>
      </main>
    );
  }

  if (screen === "error") {
    return (
      <main className="screen">
        <p className="brand">{"// nan-desktop"}</p>
        <h1>Something went wrong</h1>
        <p className="status err">{loadError}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => void boot()}>
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (screen === "authorizing" && authProfileId) {
    const profile = overview?.profiles.find((p) => p.id === authProfileId);
    return (
      <Authorizing
        profileName={profile?.name ?? authProfileId}
        userCode={userCode}
        phase={authPhase}
        errorKind={errorKind}
        pollCount={pollCount}
        onTryAgain={() => void startLogin(authProfileId)}
        onPickAnother={() => void cancelLogin()}
        onCancel={() => void cancelLogin()}
      />
    );
  }

  if (screen === "picker" && overview) {
    return (
      <ProfilePicker
        overview={overview}
        busy={busy}
        error={pickerError}
        onPick={(id) => void startLogin(id)}
      />
    );
  }

  if (screen !== "chat" || !overview) {
    return null; // unreachable with a consistent state machine
  }

  const activeProfile = overview.profiles.find(
    (p) => p.id === overview.active_profile,
  );

  return (
    <main className="screen">
      <p className="brand">{"// nan-desktop"}</p>
      <h1>Chat</h1>
      <section className="panel signin-panel">
        <p className="signin-row">
          Signed in to <strong>{activeProfile?.name ?? "unknown profile"}</strong>
          {activeProfile?.has_key && (
            <span className="key-note"> — inference key stored {activeProfile.key_mask}</span>
          )}
        </p>
        <p className="hint">
          Chat streaming (SSE), markdown rendering and local history arrive in
          T4 — this screen is a placeholder proving sign-in finished and the
          credential lives in the OS keychain.
        </p>
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={() => void signOut()} disabled={busy}>
            Sign out
          </button>
        </div>
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
            <button type="button" className="btn btn-ghost" onClick={() => void startSse()}>
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
              autoComplete="off"
            />
            <button type="button" className="btn btn-ghost" onClick={() => void keyringSet()}>
              Set
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void keyringGet()}>
              Get
            </button>
          </div>
          <p className="status">{krStatus}</p>
        </section>

        <section className="panel">
          <h2>SQLite (local history foundation)</h2>
          <div className="row-h">
            <button type="button" className="btn btn-ghost" onClick={() => void runDbDemo()}>
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
