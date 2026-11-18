// The composer's attachments: paperclip (native picker opened by the core),
// files dropped on the window (staged by the core from the native drop
// event), pasted images, and the chips' lifecycle (document text
// extraction, removal, hand-off to `chat_send`).
//
// The tray is PER CONVERSATION (like the composer queue): files attached in
// one chat stay with it when the user switches to another and back. A new,
// not yet created chat uses the caller's NEW_CHAT key.

import { listen } from "@tauri-apps/api/event";
import type { ClipboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  discardAttachment,
  onAttachmentsDropped,
  pickAttachments,
  readAttachment,
  stageAttachmentBytes,
  type AttachmentInput,
  type StageResult,
} from "../core";
import type { MessageAttachment } from "../types";
import {
  EXTRACTION_TIMEOUT_MS,
  MAX_ATTACHMENTS,
  MAX_TOTAL_BYTES,
  attachmentPayload,
  clipboardImages,
  pendingAsMessageAttachments,
  extractText,
  withTimeout,
  fileToBase64,
  pastedName,
  type PendingAttachment,
} from "./attachments";

/// Why the last attach attempt failed (the core's reason, or `no_text` /
/// `read_failed` from the local extraction), for one file when known.
export interface AttachProblem {
  reason: string;
  name: string;
}

/// Tauri's native drag events (the HTML5 drop gives no paths in Tauri).
const DRAG_ENTER = "tauri://drag-enter";
const DRAG_LEAVE = "tauri://drag-leave";
const DRAG_DROP = "tauri://drag-drop";

export interface ComposerAttachments {
  /// The chips of the conversation on screen.
  items: PendingAttachment[];
  problem: AttachProblem | null;
  /// A file is being dragged over the window.
  dragging: boolean;
  /// A document's text is still being read: sending waits.
  reading: boolean;
  pick: () => Promise<void>;
  paste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  remove: (id: string) => void;
  /// The `chat_send` payload of the current chips.
  payload: () => AttachmentInput[];
  /// The chips as message attachments (optimistic bubble).
  asMessageAttachments: () => MessageAttachment[];
  /// Whether the current chips can go out (count and total size, the same
  /// caps the core enforces); flags the problem when not.
  validate: () => boolean;
  /// Clear after a send and return what was there, so a refused send can
  /// `restore` it.
  takeAll: () => PendingAttachment[];
  /// Put files back on conversation `key` (explicit: the conversation may
  /// have been created, and the screen changed, while the send ran).
  restore: (items: PendingAttachment[], reason: string | undefined, key: number) => void;
  /// Put files back (Edit on a queued message), capped at MAX_ATTACHMENTS:
  /// the extra ones are discarded with the "too many" notice.
  append: (items: readonly PendingAttachment[]) => void;
  /// Discard every pending file of a conversation (it was deleted).
  discardFor: (conversationKey: number) => void;
  dismissProblem: () => void;
}

type Trays = ReadonlyMap<number, PendingAttachment[]>;

export function useComposerAttachments({
  enabled,
  conversationKey,
  pastedImageName,
  onAdded,
}: {
  /// The chat composer is on screen: drops elsewhere are discarded.
  enabled: boolean;
  /// The conversation on screen (or the caller's key for a new chat).
  conversationKey: number;
  /// Base name of a pasted image without a file name.
  pastedImageName: string;
  /// Something was attached (the composer leaves image mode).
  onAdded?: () => void;
}): ComposerAttachments {
  const [trays, setTrays] = useState<Trays>(() => new Map());
  // The last notice and the conversation it is about: shown only there (a
  // late extraction notice from chat A never shows up in chat B).
  const [notice, setNotice] = useState<{ key: number; problem: AttachProblem } | null>(null);
  const [dragging, setDragging] = useState(false);
  const traysRef = useRef(trays);
  const keyRef = useRef(conversationKey);
  keyRef.current = conversationKey;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;
  const internalDragRef = useRef(false);

  const items = trays.get(conversationKey) ?? [];
  const current = (): PendingAttachment[] => traysRef.current.get(keyRef.current) ?? [];
  const commit = (next: Trays): void => {
    traysRef.current = next;
    setTrays(next);
  };
  const withTray = (key: number, tray: PendingAttachment[]): Trays => {
    const next = new Map(traysRef.current);
    if (tray.length === 0) next.delete(key);
    else next.set(key, tray);
    return next;
  };
  /// Apply `fn` to the item with `id`, whatever conversation holds it.
  const updateEverywhere = (fn: (tray: PendingAttachment[]) => PendingAttachment[]): void => {
    const next = new Map<number, PendingAttachment[]>();
    for (const [key, tray] of traysRef.current) {
      const updated = fn(tray);
      if (updated.length > 0) next.set(key, updated);
    }
    commit(next);
  };

  /// Show `problem` on conversation `key` (default: the one on screen);
  /// `null` clears the notice.
  const setProblem = (problem: AttachProblem | null, key = keyRef.current): void => {
    setNotice(problem ? { key, problem } : null);
  };
  /// The conversation whose tray holds the item `id`.
  const keyOf = (id: string): number => {
    for (const [key, tray] of traysRef.current) if (tray.some((item) => item.id === id)) return key;
    return keyRef.current;
  };

  const readDocument = useCallback(async (id: string, kind: PendingAttachment["kind"], name: string) => {
    try {
      const text = await withTimeout(
        readAttachment(id).then((bytes) => extractText(kind, bytes)),
        EXTRACTION_TIMEOUT_MS,
      );
      const key = keyOf(id);
      updateEverywhere((tray) => tray.map((item) => (item.id === id ? { ...item, status: "ready", text } : item)));
      if (text.trim().length === 0) setProblem({ reason: "no_text", name }, key);
    } catch {
      const key = keyOf(id);
      updateEverywhere((tray) => tray.filter((item) => item.id !== id));
      void discardAttachment(id).catch(() => {});
      setProblem({ reason: "read_failed", name }, key);
    }
  }, []);

  const add = useCallback(
    (result: StageResult) => {
      const key = keyRef.current;
      const tray = traysRef.current.get(key) ?? [];
      const room = MAX_ATTACHMENTS - tray.length;
      const accepted = result.staged.slice(0, Math.max(room, 0));
      const overflow = result.staged.slice(accepted.length);
      for (const extra of overflow) void discardAttachment(extra.id).catch(() => {});
      const first = result.rejected[0];
      if (overflow.length > 0) setProblem({ reason: "too_many", name: overflow[0].name });
      else if (first) setProblem({ reason: first.reason, name: first.name });
      else if (accepted.length > 0) setProblem(null);
      if (accepted.length === 0) return;
      const fresh: PendingAttachment[] = accepted.map((staged) => ({
        id: staged.id,
        kind: staged.kind,
        name: staged.name,
        size: staged.size,
        previewPath: staged.preview_path,
        status: staged.kind === "image" ? "ready" : "reading",
      }));
      commit(withTray(key, [...tray, ...fresh]));
      onAddedRef.current?.();
      for (const item of fresh) {
        if (item.status === "reading") void readDocument(item.id, item.kind, item.name);
      }
    },
    [readDocument],
  );

  // The core stages native drops only while the composer accepts them, and
  // never while a drag that started inside the page is running (WebKitGTK
  // can report an in-page drag of a file link as a file drop).
  useEffect(() => {
    void invoke("attachments_set_accepting", { accepting: enabled }).catch(() => {});
  }, [enabled]);
  const setInternalDrag = useCallback((active: boolean) => {
    if (internalDragRef.current === active) return;
    internalDragRef.current = active;
    if (active) setDragging(false);
    void invoke("attachments_internal_drag", { active }).catch(() => {});
  }, []);
  useEffect(() => {
    const start = () => setInternalDrag(true);
    const end = () => setInternalDrag(false);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
      void invoke("attachments_set_accepting", { accepting: false }).catch(() => {});
    };
  }, [setInternalDrag]);

  // Drops: the core stages them from the native event and announces them.
  useEffect(() => {
    const unlisten: Array<Promise<() => void>> = [
      onAttachmentsDropped((result) => {
        setDragging(false);
        if (enabledRef.current) {
          add(result);
        } else {
          for (const staged of result.staged) void discardAttachment(staged.id).catch(() => {});
        }
      }),
      listen<{ paths?: string[] }>(DRAG_ENTER, (event) => {
        // No drop hint for a drag that started inside the page.
        if (enabledRef.current && !internalDragRef.current && (event.payload?.paths?.length ?? 0) > 0) {
          setDragging(true);
        }
      }),
      // A native leave or drop ends any drag, including an in-page one.
      listen(DRAG_LEAVE, () => {
        setDragging(false);
        setInternalDrag(false);
      }),
      listen(DRAG_DROP, () => {
        setDragging(false);
        setInternalDrag(false);
      }),
    ];
    return () => {
      for (const promise of unlisten) void promise.then((fn) => fn()).catch(() => {});
    };
  }, [add, setInternalDrag]);

  const pick = useCallback(async () => {
    if (current().length >= MAX_ATTACHMENTS) {
      setProblem({ reason: "too_many", name: "" });
      return;
    }
    try {
      add(await pickAttachments());
    } catch {
      setProblem({ reason: "protocol", name: "" });
    }
  }, [add]);

  const paste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = clipboardImages(event.clipboardData);
      if (files.length === 0) return; // plain text paste: untouched
      event.preventDefault();
      void (async () => {
        const result: StageResult = { staged: [], rejected: [] };
        for (const file of files) {
          const name = pastedName(file, pastedImageName);
          try {
            result.staged.push(await stageAttachmentBytes(name, await fileToBase64(file)));
          } catch (err) {
            result.rejected.push({ name, reason: String(err) });
          }
        }
        add(result);
      })();
    },
    [add, pastedImageName],
  );

  const remove = useCallback((id: string) => {
    updateEverywhere((tray) => tray.filter((item) => item.id !== id));
    void discardAttachment(id).catch(() => {});
  }, []);

  const payload = useCallback((): AttachmentInput[] => attachmentPayload(current()), []);

  const asMessageAttachments = useCallback(
    (): MessageAttachment[] => pendingAsMessageAttachments(current()),
    [],
  );

  const validate = useCallback((): boolean => {
    const tray = current();
    if (tray.length > MAX_ATTACHMENTS) {
      setProblem({ reason: "too_many", name: "" });
      return false;
    }
    if (tray.reduce((sum, item) => sum + item.size, 0) > MAX_TOTAL_BYTES) {
      setProblem({ reason: "total_too_large", name: "" });
      return false;
    }
    return true;
  }, []);

  const append = useCallback((more: readonly PendingAttachment[]) => {
    if (more.length === 0) return;
    const tray = current();
    const room = Math.max(MAX_ATTACHMENTS - tray.length, 0);
    const kept = more.slice(0, room);
    const extra = more.slice(room);
    for (const file of extra) void discardAttachment(file.id).catch(() => {});
    if (extra.length > 0) setProblem({ reason: "too_many", name: extra[0].name });
    commit(withTray(keyRef.current, [...tray, ...kept]));
  }, []);

  const takeAll = useCallback((): PendingAttachment[] => {
    const taken = current();
    commit(withTray(keyRef.current, []));
    setProblem(null);
    return taken;
  }, []);

  const restore = useCallback((previous: PendingAttachment[], reason: string | undefined, key: number) => {
    commit(withTray(key, [...(traysRef.current.get(key) ?? []), ...previous]));
    if (reason) setProblem({ reason, name: "" }, key);
  }, []);

  // The chat shell goes away (sign-out, account switch): every pending
  // file is discarded in the core.
  useEffect(
    () => () => {
      for (const tray of traysRef.current.values()) {
        for (const file of tray) void discardAttachment(file.id).catch(() => {});
      }
    },
    [],
  );

  const discardFor = useCallback((key: number) => {
    const tray = traysRef.current.get(key) ?? [];
    for (const file of tray) void discardAttachment(file.id).catch(() => {});
    if (tray.length > 0) commit(withTray(key, []));
  }, []);

  return {
    items,
    problem: notice && notice.key === conversationKey ? notice.problem : null,
    dragging,
    reading: items.some((item) => item.status === "reading"),
    pick,
    paste,
    remove,
    payload,
    asMessageAttachments,
    validate,
    takeAll,
    restore,
    append,
    discardFor,
    dismissProblem: useCallback(() => setProblem(null), []),
  };
}
