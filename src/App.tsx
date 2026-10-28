import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";

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

const DEFAULT_SSE_URL = "http://127.0.0.1:14321/events";

// Security posture spike: a retrieved keychain value is never rendered in
// full — at most its last 4 characters, masked.
function maskValue(value: string): string {
  return `••••${value.slice(-4)}`;
}

function App() {
  // (a) SSE demo
  const [sseUrl, setSseUrl] = useState(DEFAULT_SSE_URL);
  const [chunks, setChunks] = useState<string[]>([]);
  const [sseStatus, setSseStatus] = useState<
    "idle" | "streaming" | "done" | "error"
  >("idle");
  const [sseError, setSseError] = useState("");

  // (b) Keychain
  const [krService, setKrService] = useState("nan-desktop-spike");
  const [krAccount, setKrAccount] = useState("demo-api-key");
  const [krValue, setKrValue] = useState("");
  const [krStatus, setKrStatus] = useState("");

  // (c) SQLite
  const [messages, setMessages] = useState<Message[]>([]);
  const [dbStatus, setDbStatus] = useState("");

  // Rust → frontend event transport (S4). Registered once; cleanup on unmount.
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
      setKrStatus(value === null ? "no entry found" : `retrieved: ${maskValue(value)}`);
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

  return (
    <main className="container">
      <h1>nan-desktop · T1 spike</h1>

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
    </main>
  );
}

export default App;
