import {
  FocusContext,
  init,
  setFocus,
  useFocusable,
  type UseFocusableConfig,
} from "@noriginmedia/norigin-spatial-navigation";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * TV-remote navigation. Arrow keys / D-pad move focus spatially, Enter selects,
 * Back (Escape, Backspace, or the TV's back key) goes back. A mouse also works:
 * hovering focuses, clicking selects.
 */
export function initNavigation(): void {
  init({ debug: false, visualDebug: false, distanceCalculationMethod: "center" });
  // Remember whether the last input was keys or a real mouse move. Browsers send
  // mouseenter when content scrolls under a resting pointer; those must not
  // steal focus from the D-pad. (Real moves have a non-zero movement.)
  window.addEventListener("keydown", () => (pointerActive = false), true);
  window.addEventListener(
    "mousemove",
    (e) => {
      if (e.movementX || e.movementY) pointerActive = true;
    },
    { passive: true },
  );
}

let pointerActive = false;

/** True when the user is using a mouse rather than keys / a remote. */
export function usingPointer(): boolean {
  return pointerActive;
}

// Back keys across platforms: Escape/Backspace (browsers), 10009 (Samsung Tizen),
// 461 (LG webOS), "GoBack"/"BrowserBack" (Android TV / others).
const BACK_KEYS = new Set(["Escape", "Backspace", "GoBack", "BrowserBack"]);
const BACK_CODES = new Set([10009, 461]);

export function useBackKey(onBack: () => void, enabled = true): void {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode)) {
        e.preventDefault();
        cb.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);
}

/** Keep the focused element on screen (rows scroll sideways, the page scrolls vertically). */
function reveal(el: HTMLElement | null) {
  el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
}

interface FocusableProps extends Pick<UseFocusableConfig, "focusKey"> {
  children: (state: { focused: boolean }) => ReactNode;
  onSelect?: () => void;
  onFocused?: () => void;
  className?: string;
  disabled?: boolean;
  /** Accessible label for screen readers / mouse users. */
  label?: string;
  /** Scroll into view on focus (default). Off when the parent positions it. */
  reveal?: boolean;
}

/** A focusable, selectable element (button, card, tile). */
export function Focusable({ children, onSelect, onFocused, className, disabled, focusKey, label, reveal: autoReveal = true }: FocusableProps) {
  const { ref, focused, focusSelf } = useFocusable({
    ...(focusKey && { focusKey }),
    focusable: !disabled,
    onEnterPress: () => onSelect?.(),
    onFocus: () => {
      if (autoReveal) reveal(ref.current as HTMLElement | null);
      onFocused?.();
    },
  });
  return (
    <div
      ref={ref}
      role="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={[className, focused && "is-focused", disabled && "is-disabled"].filter(Boolean).join(" ")}
      onMouseEnter={() => !disabled && pointerActive && focusSelf()}
      onClick={() => !disabled && onSelect?.()}
    >
      {children({ focused })}
    </div>
  );
}

interface GroupProps extends Pick<UseFocusableConfig, "focusKey"> {
  children: ReactNode;
  className?: string;
  /** Remember the last focused child when focus returns to this group. */
  remember?: boolean;
  /** Keep focus inside (e.g. a dialog). */
  trap?: boolean;
  /** Focus this group's first/remembered child on mount. */
  autoFocus?: boolean;
  preferredChildFocusKey?: string;
}

/** A container that scopes navigation (a row, a menu, a dialog). */
export function FocusGroup({ children, className, remember = true, trap, autoFocus, focusKey, preferredChildFocusKey }: GroupProps) {
  const { ref, focusKey: key, focusSelf } = useFocusable({
    ...(focusKey && { focusKey }),
    trackChildren: true,
    saveLastFocusedChild: remember,
    isFocusBoundary: Boolean(trap),
    ...(preferredChildFocusKey && { preferredChildFocusKey }),
  });
  useEffect(() => {
    if (autoFocus) focusSelf();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);
  return (
    <FocusContext.Provider value={key}>
      <div ref={ref} className={className}>
        {children}
      </div>
    </FocusContext.Provider>
  );
}

export { setFocus };
