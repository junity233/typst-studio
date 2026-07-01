import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";

const STORAGE_KEY = "ts-split-sizes";
const DEFAULT_SIZES: number[] = [50, 50];

function loadSizes(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((n) => typeof n === "number")
      ) {
        return parsed as number[];
      }
    }
  } catch {
    // ignore corrupt storage / unavailable localStorage
  }
  return DEFAULT_SIZES;
}

export interface SplitPaneProps {
  children: ReactNode;
  /** Minimum size (px) applied to each pane. */
  minSize?: number;
}

/**
 * Thin wrapper around allotment's horizontal split with sensible defaults.
 * Pane sizes are persisted to localStorage (key: `ts-split-sizes`).
 */
export function SplitPane({ children, minSize = 120 }: SplitPaneProps) {
  const [sizes] = useState<number[]>(loadSizes);
  const saveTimer = useRef<number | null>(null);

  const handleChange = useCallback((next: number[]) => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
    }
    saveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore quota / serialization errors
      }
    }, 200);
  }, []);

  return (
    <Allotment
      vertical={false}
      proportionalLayout
      defaultSizes={sizes}
      minSize={minSize}
      onChange={handleChange}
    >
      {children}
    </Allotment>
  );
}
