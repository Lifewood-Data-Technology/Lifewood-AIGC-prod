"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { mayRestoreTabSession, prepareTabSession, stopTabRestore } from "../lib/tab-session";

const TabOwnership = createContext({ ready: false, owned: false, acquire: async () => false, release: () => {} });
export const useTabOwnership = () => useContext(TabOwnership);

/** A fresh/duplicate tab stays on Login. Only a reload may restore its own proof. */
export default function SingleTabGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [owned, setOwned] = useState(false);
  const held = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const pending = useRef<Promise<boolean> | null>(null);
  const release = useCallback(() => {
    generation.current++;
    held.current?.();
    held.current = null;
    pending.current = null;
    setOwned(false);
  }, []);
  const acquire = useCallback((): Promise<boolean> => {
    if (held.current) return Promise.resolve(true);
    if (pending.current) return pending.current;
    if (!window.navigator.locks) return Promise.resolve(false);
    const epoch = generation.current;
    const result = new Promise<boolean>(resolve => {
      void window.navigator.locks.request("lifewood-workbench-active-tab", { mode: "exclusive", ifAvailable: true }, async lock => {
        if (!lock || epoch !== generation.current) { resolve(false); return; }
        await new Promise<void>(unlock => {
          held.current = unlock;
          setOwned(true);
          resolve(true);
        });
      }).catch(() => resolve(false));
    });
    pending.current = result;
    void result.finally(() => { if (pending.current === result) pending.current = null; });
    return result;
  }, []);
  useEffect(() => {
    let disposed = false;
    const setup = async () => {
      prepareTabSession();
      if (mayRestoreTabSession()) await acquire();
      if (!disposed) setReady(true);
    };
    queueMicrotask(() => { if (!disposed) void setup(); });
    // Reload/close releases only the local lock, NEVER sends a server logout.
    const hide = () => { stopTabRestore(); release(); setReady(false); };
    const show = (event: PageTransitionEvent) => { if (event.persisted) void setup(); };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => { disposed = true; release(); window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); };
  }, [acquire, release]);
  return <TabOwnership.Provider value={{ ready, owned, acquire, release }}>{children}</TabOwnership.Provider>;
}
