import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Returns `value` after `delay` ms of no changes. The returned value lags
 * behind `value` until the debounce window elapses.
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/**
 * Returns a stable debounced version of `cb`. Each call resets the timer; the
 * callback fires only after `delay` ms of no calls. The latest arguments are
 * used. Suited for wiring Monaco `onChange` → backend `update_text` (300ms).
 */
export function useDebouncedCallback<A extends unknown[]>(
  cb: (...args: A) => void,
  delay: number,
): (...args: A) => void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const timer = useRef<number | null>(null);

  return useCallback(
    (...args: A) => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
      timer.current = window.setTimeout(() => {
        timer.current = null;
        cbRef.current(...args);
      }, delay);
    },
    [delay],
  );
}
