"use client";
/**
 * Pinned cards on the Overview, remembered per wallet in this browser.
 * Pinned ids sort first (most recently pinned first). Storage failures just mean pins don't persist.
 */
import { useCallback, useEffect, useState } from "react";

const keyFor = (scope: string, address?: string | null) =>
  `atlas_pins:${scope}:${(address || "anon").toLowerCase()}`;

function read(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

export function usePins(scope: string, address?: string | null) {
  const key = keyFor(scope, address);
  const [pins, setPins] = useState<string[]>([]);
  useEffect(() => {
    setPins(read(key));
    const sync = (e: StorageEvent) => e.key === key && setPins(read(key));
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);
  const toggle = useCallback(
    (id: string) =>
      setPins((current) => {
        const next = current.includes(id)
          ? current.filter((p) => p !== id)
          : [id, ...current];
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {}
        return next;
      }),
    [key],
  );
  const isPinned = useCallback((id: string) => pins.includes(id), [pins]);
  /** Stable sort: pinned items first in pin order, the rest keep their order. */
  const sort = useCallback(
    <T>(items: T[], id: (item: T) => string) => {
      const rank = (item: T) => {
        const i = pins.indexOf(id(item));
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
        .map(({ item }) => item);
    },
    [pins],
  );
  return { pins, isPinned, toggle, sort };
}
