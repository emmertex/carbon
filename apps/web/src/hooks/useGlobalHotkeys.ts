import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';

/** `g`-leader "go to" destinations. */
const GO_ROUTES: Record<string, string> = {
  t: '/today',
  i: '/inbox',
  f: '/flagged',
  a: '/all',
  p: '/plan',
  o: '/forecast',
  r: '/review',
};

const SCROLL_KEYS = new Set(['Home', 'End', 'PageUp', 'PageDown']);

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  );
}

function scrollMain(key: string): void {
  const main = document.querySelector('main');
  if (!main) return;
  const page = Math.round(main.clientHeight * 0.9);
  switch (key) {
    case 'Home':
      main.scrollTo({ top: 0 });
      break;
    case 'End':
      main.scrollTo({ top: main.scrollHeight });
      break;
    case 'PageUp':
      main.scrollBy({ top: -page });
      break;
    case 'PageDown':
      main.scrollBy({ top: page });
      break;
  }
}

/**
 * Global, app-wide keyboard shortcuts that make Carbon fully keyboard-drivable
 * (and let the perf benchmark run without a mouse):
 *
 *   g then t/i/f/a/p/o/r  → go to Today/Inbox/Flagged/All/Plan/Forecast/Review
 *   c  or  /              → focus the quick-add bar
 *   Home/End/PageUp/PageDown → scroll the main content area
 *
 * Letter shortcuts are ignored while an input/textarea/contenteditable is focused
 * (so typing a task title is never hijacked), and any key a focused list/outliner
 * already handled (defaultPrevented) is skipped so scrolling isn't doubled.
 */
export function useGlobalHotkeys(opts: {
  navigate: NavigateFunction;
  focusQuickAdd: () => void;
}): void {
  const { navigate, focusQuickAdd } = opts;
  // Latest callbacks without re-binding the window listener every render.
  const ref = useRef(opts);
  ref.current = { navigate, focusQuickAdd };

  useEffect(() => {
    let leader = false;
    let leaderTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLeader = () => {
      leader = false;
      if (leaderTimer) {
        clearTimeout(leaderTimer);
        leaderTimer = null;
      }
    };

    function onKeyDown(e: KeyboardEvent) {
      // A focused list/outliner may have already acted on this key.
      if (e.defaultPrevented) return;

      // Scroll keys work even from a focusable container, but not while editing
      // text (where they mean caret navigation).
      if (SCROLL_KEYS.has(e.key) && !isEditable(e.target)) {
        e.preventDefault();
        scrollMain(e.key);
        return;
      }

      // The rest are plain single-letter shortcuts: never with modifiers, never
      // while typing into a field.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable(e.target)) return;

      if (leader) {
        const route = GO_ROUTES[e.key.toLowerCase()];
        clearLeader();
        if (route) {
          e.preventDefault();
          ref.current.navigate(route);
        }
        return;
      }

      if (e.key === 'g') {
        leader = true;
        leaderTimer = setTimeout(clearLeader, 800);
        return;
      }

      if (e.key === 'c' || e.key === '/') {
        e.preventDefault();
        ref.current.focusQuickAdd();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearLeader();
    };
  }, []);
}
