// Markdown rendering (S3/S16): GFM (tables included) + highlight + sanitize.
// NEVER raw HTML, and never tool-call markup: content passes through
// stripToolMarkup before parsing.
//
// rehype-highlight keeps the pipeline synchronous (streaming-friendly);
// rehype-sanitize runs AFTER highlighting so its output is the last pass.

import { useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { stripToolMarkup } from "./chat/toolMarkup";
import { useT } from "./i18n";
import { IconCheck, IconCopy } from "./icons";

interface HastNode {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

export const sanitizeSchema = {
  ...defaultSchema,
  // Security review R1 (defense in depth with the app CSP): model markdown
  // may not load remote images; an <img> to an attacker host would be a
  // conversation-content exfiltration channel.
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "img" && t !== "picture" && t !== "source"),
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-./, /^hljs$/]],
    span: [...(defaultSchema.attributes?.span ?? []), ["className", /^hljs-./]],
  },
};

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const codeEl = node?.children?.find((child) => child.tagName === "code");
  const classes = Array.isArray(codeEl?.properties?.className)
    ? (codeEl?.properties?.className as unknown[]).filter((cls): cls is string => typeof cls === "string")
    : [];
  const language = classes.find((cls) => cls.startsWith("language-"))?.slice("language-".length);
  const raw = hastText(codeEl);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (rare in the Tauri secure context): keep silent.
    }
  };

  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="codeblock-lang">{language ?? t.chat.codeFallbackLang}</span>
        <button type="button" className="codeblock-copy" onClick={() => void copy()}>
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          {copied ? t.chat.copied : t.chat.copy}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/// GFM tables scroll horizontally inside the message instead of
/// stretching it.
function Table({ children }: { children?: ReactNode }) {
  return (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  );
}

export function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (typeof node === "object" && "props" in (node as unknown as Record<string, unknown>)) {
    const props = (node as unknown as { props?: { children?: ReactNode } }).props;
    return nodeToText(props?.children);
  }
  return "";
}

/// Ask the Rust core to open a URL in the system browser (https-only
/// validation happens there). Invalid URLs are rejected silently.
export function openExternal(url: string): void {
  if (url) {
    void invoke("open_external", { url }).catch(() => {});
  }
}

/// Model-supplied links never navigate the main window (external review
/// B3): a neutral element with no href. Clicking opens the preview pane when
/// the host offers one (S21), otherwise the system browser via the core.
/// The URL stays visible so the target is never hidden.
export function SafeLink({
  href,
  children,
  onOpen,
}: {
  href?: string;
  children?: ReactNode;
  onOpen?: (url: string) => void;
}) {
  const url = typeof href === "string" ? href : "";
  const label = nodeToText(children);
  const open = (): void => {
    if (!url) return;
    if (onOpen && /^https?:\/\//i.test(url)) onOpen(url);
    else openExternal(url);
  };
  return (
    <span
      className="safe-link"
      role="link"
      tabIndex={0}
      title={url}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      {children}
      {url && !label.includes(url) ? <span className="safe-link-url"> ({url})</span> : null}
    </span>
  );
}

export function Markdown({ text, onOpenLink }: { text: string; onOpenLink?: (url: string) => void }) {
  const clean = stripToolMarkup(text);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, [rehypeSanitize, sanitizeSchema]]}
        components={{
          pre: CodeBlock,
          table: Table,
          a: ({ href, children }) => (
            <SafeLink href={href} onOpen={onOpenLink}>
              {children}
            </SafeLink>
          ),
        }}
      >
        {clean}
      </ReactMarkdown>
    </div>
  );
}
