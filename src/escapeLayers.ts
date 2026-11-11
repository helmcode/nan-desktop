// Round 14 review (F2): the stack of open inner surfaces.
//
// Every inner surface (the account menu, the whole-computer confirmation, the
// skills form, the team skill detail, the share dialog) listens for Escape on
// `window` in the capture phase. Window listeners run in REGISTRATION order,
// not innermost-first, so with two surfaces open (the skills form, then the
// account menu) Escape used to close both. A surface now registers a layer
// while it is open and its handler acts only when its own layer is the top of
// the stack, which makes "only the innermost thing closes" explicit instead of
// incidental.

import { useEffect, useRef } from "react";

let counter = 0;
const stack: number[] = [];

/** Hands out ids without touching the stack, so it is safe during render. */
function allocate(): number {
  counter += 1;
  return counter;
}

function remove(id: number): void {
  const at = stack.lastIndexOf(id);
  if (at !== -1) stack.splice(at, 1);
}

function push(id: number): void {
  // A surface re-registering without a cleanup must not end up twice.
  remove(id);
  stack.push(id);
}

/**
 * True when `id` is the innermost open surface: Escape belongs to it. A
 * handler for any other layer returns without consuming the key, and the top
 * layer's own handler consumes it.
 */
export function isTopLayer(id: number): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** How many surfaces are open right now (the tests assert the stack drains). */
export function layerCount(): number {
  return stack.length;
}

/**
 * Registers one layer while `active` is true and removes it on close or
 * unmount. The id is stable for the component's lifetime, so the surface's
 * Escape handler can capture it.
 */
export function useEscapeLayer(active: boolean): number {
  const idRef = useRef<number | null>(null);
  if (idRef.current === null) idRef.current = allocate();
  const id = idRef.current;
  useEffect(() => {
    if (!active) return;
    push(id);
    return () => remove(id);
  }, [active, id]);
  return id;
}

/** Test-only: forget every registered layer, whatever is still mounted. */
export function resetForTests(): void {
  stack.length = 0;
}
