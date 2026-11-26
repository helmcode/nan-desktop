// Vitest setup: Node 25 ships an experimental global localStorage whose
// surface differs from jsdom's; install a complete, isolated stub before
// each file so tests get the Web API semantics (clear included).
const store = new Map<string, string>();
const local: Storage = {
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  removeItem: (k: string) => void store.delete(k),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
};
Object.defineProperty(window, "localStorage", { value: local, configurable: true });
Object.defineProperty(window, "sessionStorage", { value: local, configurable: true });

// CI runners (macOS and Windows above all) are often slower than a laptop: the
// full App tests mount the whole shell, and testing-library's default 1 s for
// findBy*/waitFor made them fail on timing alone. Waits that succeed are not
// slowed down; only a wait that would fail takes longer to report it.
import { configure } from "@testing-library/react";
configure({ asyncUtilTimeout: 5000 });
