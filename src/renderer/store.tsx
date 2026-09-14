import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Database } from '../shared/types';
import { emptyDatabase, normalizeDatabase } from '../shared/types';
import { api } from './api';

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
export function today(): string { return new Date().toISOString().slice(0, 10); }

interface StoreValue {
  db: Database;
  ready: boolean;
  /** Applique une mutation (immutable : on renvoie une nouvelle base) puis sauvegarde. */
  update: (fn: (db: Database) => Database) => void;
  replace: (db: Database) => void;
  toast: (msg: string, bad?: boolean) => void;
}

const Ctx = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<Database>(emptyDatabase);
  const [ready, setReady] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ msg: string; bad: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => { api.loadDb().then((d) => { setDb(normalizeDatabase(d)); setReady(true); }); }, []);
  // Base fusionnée reçue du serveur (autre poste) : on remplace sans ré-enregistrer (le principal l'a déjà fait).
  useEffect(() => api.onRemoteDb((d) => setDb(normalizeDatabase(d))), []);

  const persist = useCallback((next: Database) => { api.saveDb(next).catch((e) => console.error(e)); }, []);

  const update = useCallback((fn: (db: Database) => Database) => {
    setDb((prev) => { const next = fn(prev); persist(next); return next; });
  }, [persist]);

  const replace = useCallback((next: Database) => { setDb(next); persist(next); }, [persist]);

  const toast = useCallback((msg: string, bad = false) => {
    setToastMsg({ msg, bad });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToastMsg(null), 3200);
  }, []);

  const value = useMemo(() => ({ db, ready, update, replace, toast }), [db, ready, update, replace, toast]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {toastMsg && <div className={`toast${toastMsg.bad ? ' bad' : ''}`}>{toastMsg.msg}</div>}
    </Ctx.Provider>
  );
}

export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore hors StoreProvider');
  return v;
}
