// Safe HTML preview (S21): HTML files, and the HTML that mammoth produces
// from .docx, are parsed with the inert DOMParser (scripts never run in a
// parsed document) and rebuilt as React elements from a strict whitelist.
// No attributes survive except a link target, which goes through SafeLink.
// Images, iframes, forms, styles and scripts are dropped entirely.

import { createElement } from "react";
import type { ReactNode } from "react";
import { SafeLink } from "../Markdown";

const ALLOWED = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
  "pre", "code", "strong", "b", "em", "i", "u", "s", "del", "sub", "sup",
  "br", "hr", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "span", "div", "section", "article", "header", "footer", "main", "nav", "aside",
  "figure", "figcaption", "dl", "dt", "dd", "small", "mark", "abbr", "time",
]);

/// Elements whose whole subtree is dropped (content never shown).
const DROPPED = new Set([
  "script", "style", "noscript", "template", "iframe", "frame", "frameset",
  "object", "embed", "img", "picture", "source", "video", "audio", "svg",
  "math", "canvas", "form", "input", "button", "select", "textarea", "link",
  "meta", "head", "title", "base",
]);

const VOID = new Set(["br", "hr"]);

const MAX_NODES = 20000;

export function htmlToReact(html: string, onOpenLink?: (url: string) => void): ReactNode[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let budget = MAX_NODES;

  const walk = (node: Node, key: string): ReactNode => {
    if (budget-- <= 0) return null;
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1) return null;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (DROPPED.has(tag)) return null;
    const children = Array.from(el.childNodes).map((child, i) => walk(child, `${key}.${i}`));
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      return /^https?:\/\//i.test(href) ? (
        <SafeLink key={key} href={href} onOpen={onOpenLink}>
          {children}
        </SafeLink>
      ) : (
        <span key={key}>{children}</span>
      );
    }
    if (!ALLOWED.has(tag)) return <span key={key}>{children}</span>;
    if (VOID.has(tag)) return createElement(tag, { key });
    return createElement(tag, { key }, ...children);
  };

  return Array.from(doc.body.childNodes).map((child, i) => walk(child, String(i)));
}

export function SafeHtml({ html, onOpenLink }: { html: string; onOpenLink?: (url: string) => void }) {
  return <div className="md safe-html">{htmlToReact(html, onOpenLink)}</div>;
}
