// S16: the chat never renders tool-call markup as text.
//
// Some models leak their native tool-call syntax into the content stream
// (DeepSeek DSML / tool-call tokens, Qwen/GLM <tool_call> blocks, raw
// function_calls blocks). The core parses and executes those calls; the
// renderer must never show them. This strips complete blocks and stray
// tokens always. Model-native token blocks (DSML / tool-call tokens, which
// never occur in prose) are stripped even when unterminated. Plain-tag
// blocks (<tool_call> etc.) and a half-received trailing token are only cut
// to the end in a streaming draft, so a finished answer that merely talks
// about "<tool_call> tags" keeps its text.

const BAR = "[｜|]";
const SP = "[▁_]";

interface BlockPattern {
  start: RegExp;
  end: RegExp;
  /// Plain tags that may legitimately appear in prose.
  plain: boolean;
}

const BLOCKS: BlockPattern[] = [
  {
    start: new RegExp(`<${BAR}tool${SP}calls${SP}begin${BAR}>`),
    end: new RegExp(`<${BAR}tool${SP}calls${SP}end${BAR}>`),
    plain: false,
  },
  {
    start: new RegExp(`<${BAR}tool${SP}call${SP}begin${BAR}>`),
    end: new RegExp(`<${BAR}tool${SP}call${SP}end${BAR}>`),
    plain: false,
  },
  {
    start: new RegExp(`<${BAR}DSML${BAR}function_calls>`),
    end: new RegExp(`</${BAR}DSML${BAR}function_calls>`),
    plain: false,
  },
  { start: /<tool_calls>/, end: /<\/tool_calls>/, plain: true },
  { start: /<tool_call>/, end: /<\/tool_call>/, plain: true },
  { start: /<function_calls>/, end: /<\/function_calls>/, plain: true },
  { start: /<function_call>/, end: /<\/function_call>/, plain: true },
];

export interface StripOptions {
  /// True for a draft that is still arriving.
  streaming?: boolean;
}

/// Lone tokens left behind by a partially emitted block.
const STRAY_TOKENS = new RegExp(
  `<\\/?${BAR}(?:DSML${BAR}[^>\\n]*|tool${SP}[a-z▁_]+${BAR}|end${SP}of${SP}sentence${BAR})>`,
  "g",
);

/// Tag names whose half-received opening must not flash at the end of a draft.
const OPEN_TAGS = ["<tool_calls>", "<tool_call>", "<function_calls>", "<function_call>"];

function stripTrailingPartialToken(text: string): string {
  // "<｜..." or "<|..." with no closing ">" yet.
  const bar = text.match(new RegExp(`<${BAR}[^>\\n]{0,48}$`));
  if (bar && bar.index !== undefined) return text.slice(0, bar.index);
  const lt = text.lastIndexOf("<");
  if (lt >= 0 && text.length - lt >= 2) {
    const tail = text.slice(lt);
    if (OPEN_TAGS.some((tag) => tag.startsWith(tail) && tail !== tag)) return text.slice(0, lt);
  }
  return text;
}

export function stripToolMarkup(input: string, options: StripOptions = {}): string {
  if (!input) return input;
  const streaming = options.streaming === true;
  let text = input;
  let changed = false;
  // Scan position: unterminated plain blocks in a finished answer are kept,
  // so the search continues after them instead of looping.
  let from = 0;

  for (;;) {
    let earliest: { index: number; length: number; block: BlockPattern } | null = null;
    const haystack = text.slice(from);
    for (const block of BLOCKS) {
      const match = block.start.exec(haystack);
      if (match && (earliest === null || match.index + from < earliest.index)) {
        earliest = { index: match.index + from, length: match[0].length, block };
      }
    }
    if (earliest === null) break;
    const afterStart = earliest.index + earliest.length;
    const endMatch = earliest.block.end.exec(text.slice(afterStart));
    if (!endMatch && earliest.block.plain && !streaming) {
      from = afterStart;
      continue;
    }
    changed = true;
    const cut = endMatch ? afterStart + endMatch.index + endMatch[0].length : text.length;
    text = text.slice(0, earliest.index) + text.slice(cut);
    from = earliest.index;
  }

  const withoutStray = text.replace(STRAY_TOKENS, "");
  if (withoutStray !== text) changed = true;
  text = withoutStray;

  if (streaming) {
    const withoutPartial = stripTrailingPartialToken(text);
    if (withoutPartial !== text) changed = true;
    text = withoutPartial;
  }

  return changed ? text.replace(/\n{3,}/g, "\n\n").trimEnd() : text;
}

/// True when the content is only tool markup (nothing to render).
export function isOnlyToolMarkup(input: string): boolean {
  return input.trim().length > 0 && stripToolMarkup(input).trim().length === 0;
}
