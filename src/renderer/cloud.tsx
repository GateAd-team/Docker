import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { CloudStatus } from '../shared/types';
import { api } from './api';

/**
 * État du compte / de l'espace partagé (Supabase), poussé par le process principal.
 * `status === null` : première vérification de session pas encore terminée (on affiche un écran d'attente, pas le login).
 */
interface CloudValue {
  status: CloudStatus | null;
  /** Exécute une action compte (connexion, déconnexion…) et met à jour l'état ; renvoie l'erreur éventuelle. */
  run: (fn: () => Promise<CloudStatus>) => Promise<string | null>;
  busy: boolean;
}

const Ctx = createContext<CloudValue | null>(null);

export function CloudProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const apply = (s: CloudStatus) => setStatus(s.ready ? s : null);
    api.cloudStatus().then(apply).catch(() => undefined);
    const w = (window as unknown as { dockerCloud?: { onStatus: (cb: (s: CloudStatus) => void) => () => void } }).dockerCloud;
    return w ? w.onStatus(apply) : undefined;
  }, []);
  const run = useCallback(async (fn: () => Promise<CloudStatus>) => {
    setBusy(true);
    try { const s = await fn(); setStatus(s.ready ? s : null); return null; }
    catch (e) { return (e as Error).message || String(e); }
    finally { setBusy(false); }
  }, []);
  const value = useMemo(() => ({ status, run, busy }), [status, run, busy]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCloud(): CloudValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCloud hors CloudProvider');
  return v;
}
