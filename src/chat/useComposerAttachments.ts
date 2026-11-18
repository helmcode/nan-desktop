// The composer's attachments: paperclip (native picker opened by the core),
// files dropped on the window (staged by the core from the native drop
// event), pasted images, and the chips' lifecycle (document text
// extraction, removal, hand-off to `chat_send`).

import { listen } from "@tauri-apps/api/event";
import type { ClipboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
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
  MAX_ATTACHMENTS,
  clipboardImages,
  extractText,
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
  /// Clear after a send (the core consumed the files) and return what was
  /// there, so a refused send can `restore` it.
  takeAll: () => PendingAttachment[];
  restore: (items: PendingAttachment[], reason?: string) => void;
  dismissProblem: () => void;
}

export function useComposerAttachments({
  enabled,
  pastedImageName,
  onAdded,
}: {
  /// The chat composer is on screen: drops elsewhere are discarded.
  enabled: boolean;
  /// Base name of a pasted image without a file name.
  pastedImageName: string;
  /// Something was attached (the composer leaves image mode).
  onAdded?: () => void;
}): ComposerAttachments {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [problem, setProblem] = useState<AttachProblem | null>(null);
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;

  const readDocument = useCallback(async (id: string, kind: PendingAttachment["kind"], name: string) => {
    try {
      const text = await extractText(kind, await readAttachment(id));
      if (!itemsRef.current.some((item) => item.id === id)) return;
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status: "ready", text } : item)));
      if (text.trim().length === 0) setProblem({ reason: "no_text", name });
    } catch {
      setItems((prev) => prev.filter((item) => item.id !== id));
      void discardAttachment(id).catch(() => {});
      setProblem({ reason: "read_failed", name });
    }
  }, []);

  const add = useCallback(
    (result: StageResult) => {
      const room = MAX_ATTACHMENTS - itemsRef.current.length;
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
      itemsRef.current = [...itemsRef.current, ...fresh];
      setItems(itemsRef.current);
      onAddedRef.current?.();
      for (const item of fresh) {
        if (item.status === "reading") void readDocument(item.id, item.kind, item.name);
      }
    },
    [readDocument],
  );

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
        if (enabledRef.current && (event.payload?.paths?.length ?? 0) > 0) setDragging(true);
      }),
      listen(DRAG_LEAVE, () => setDragging(false)),
      listen(DRAG_DROP, () => setDragging(false)),
    ];
    return () => {
      for (const promise of unlisten) void promise.then((fn) => fn()).catch(() => {});
    };
  }, [add]);

  const pick = useCallback(async () => {
    if (itemsRef.current.length >= MAX_ATTACHMENTS) {
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
    setItems((prev) => prev.filter((item) => item.id !== id));
    void discardAttachment(id).catch(() => {});
  }, []);

  const payload = useCallback(
    (): AttachmentInput[] =>
      itemsRef.current.map((item) => (item.kind === "image" ? { id: item.id } : { id: item.id, text: item.text ?? "" })),
    [],
  );

  const asMessageAttachments = useCallback(
    (): MessageAttachment[] =>
      itemsRef.current.map((item) => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        size: item.size,
        path: item.previewPath,
        truncated: false,
      })),
    [],
  );

  const takeAll = useCallback((): PendingAttachment[] => {
    const taken = itemsRef.current;
    itemsRef.current = [];
    setItems([]);
    setProblem(null);
    return taken;
  }, []);

  const restore = useCallback((previous: PendingAttachment[], reason?: string) => {
    itemsRef.current = previous;
    setItems(previous);
    if (reason) setProblem({ reason, name: "" });
  }, []);

  return {
    items,
    problem,
    dragging,
    reading: items.some((item) => item.status === "reading"),
    pick,
    paste,
    remove,
    payload,
    asMessageAttachments,
    takeAll,
    restore,
    dismissProblem: useCallback(() => setProblem(null), []),
  };
}
