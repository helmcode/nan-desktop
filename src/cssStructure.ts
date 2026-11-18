// Stylesheet structure check (used by cssStructure.test.ts): braces must
// balance and only at-rules may contain blocks (the app uses no native CSS
// nesting). A merge once left a rule unclosed and every later rule silently
// stopped applying.
/// Problems found in one stylesheet (empty when well formed).
export function cssStructureProblems(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const stack: string[] = [];
  const problems: string[] = [];
  let prelude = "";
  for (const ch of text) {
    if (ch === "{") {
      const head = prelude.trim();
      const parent = stack[stack.length - 1];
      if (parent !== undefined && !parent.startsWith("@")) {
        problems.push(`nested rule "${head.slice(0, 60)}" inside "${parent.slice(0, 60)}"`);
      }
      // Keyframe selectors (from/to/50%) live inside @keyframes: mark them
      // as at-level so their (empty) children are not flagged.
      stack.push(parent?.startsWith("@keyframes") || parent?.startsWith("@-webkit-keyframes") ? `@frame ${head}` : head);
      prelude = "";
    } else if (ch === "}") {
      if (stack.length === 0) problems.push("unbalanced closing brace");
      else stack.pop();
      prelude = "";
    } else if (ch === ";") {
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  if (stack.length > 0) problems.push(`unclosed block "${stack[stack.length - 1].slice(0, 60)}"`);
  return problems;
}
