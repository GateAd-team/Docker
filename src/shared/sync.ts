/**
 * Synchronisation de l'espace de travail partagé : fusion à trois voies (base = dernière version synchronisée,
 * local = ce poste, remote = le serveur) fiche par fiche, pour que deux personnes puissent travailler en même temps
 * sans s'écraser. Pur (sans Electron), testé.
 */
import type { Database, Settings } from './types';

/** Collections synchronisées (tout sauf les réglages, traités à part). */
export const SYNCED_COLLECTIONS = ['projects', 'folders', 'products', 'drawings', 'factories', 'contacts', 'partners', 'quotes', 'orders', 'shipments', 'marketPrices', 'documents', 'mails'] as const;
export type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number];

type Rec = { id: string } & Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const byId = (rows: Rec[]) => new Map(rows.map((r) => [r.id, r]));

/**
 * Fusion d'une collection. Pour chaque id :
 * - modifié d'un seul côté → on prend ce côté ; modifié des deux côtés → le local gagne (c'est ce que l'utilisateur vient de faire) ;
 * - supprimé d'un côté et pas modifié de l'autre → supprimé ; supprimé d'un côté mais modifié de l'autre → conservé (la modification l'emporte) ;
 * - créé d'un côté → ajouté.
 * L'ordre suit le remote puis les ajouts locaux.
 */
export function mergeCollection(base: Rec[], local: Rec[], remote: Rec[]): { rows: Rec[]; changed: boolean } {
  const B = byId(base), L = byId(local), R = byId(remote);
  const ids = [...new Set([...remote.map((r) => r.id), ...local.map((r) => r.id), ...base.map((r) => r.id)])];
  const out: Rec[] = [];
  for (const id of ids) {
    const b = B.get(id), l = L.get(id), r = R.get(id);
    const localChanged = !same(b, l), remoteChanged = !same(b, r);
    let pick: Rec | undefined;
    if (!localChanged && !remoteChanged) pick = l ?? r;
    else if (localChanged && !remoteChanged) pick = l;               // seul le local a bougé (y compris suppression locale → l undefined)
    else if (!localChanged && remoteChanged) pick = r;               // seul le remote a bougé
    else pick = l ?? r;                                              // conflit : le local gagne ; si le local a supprimé mais le remote modifié → on garde le remote
    if (pick) out.push(pick);
  }
  // Ordre stable : celui du remote, puis les nouveautés locales dans leur ordre
  const order = new Map<string, number>(); remote.forEach((r, i) => order.set(r.id, i)); local.forEach((r, i) => { if (!order.has(r.id)) order.set(r.id, remote.length + i); });
  out.sort((a, c) => (order.get(a.id) ?? 1e9) - (order.get(c.id) ?? 1e9));
  return { rows: out, changed: !same(out, remote) };
}

/** Réglages : partagés (taux, TVA, société, clé API, modèle…) sauf ce qui est propre au poste (Gmail, cloud). */
export const LOCAL_ONLY_SETTINGS: (keyof Settings)[] = ['gmail', 'cloud'];

export function mergeSettings(base: Settings, local: Settings, remote: Settings): Settings {
  const out: Record<string, unknown> = { ...remote };
  for (const k of Object.keys(local) as (keyof Settings)[]) {
    if (LOCAL_ONLY_SETTINGS.includes(k)) { out[k] = local[k]; continue; }
    const localChanged = !same(base[k], local[k]);
    if (localChanged) out[k] = local[k];
    else if (!(k in remote)) out[k] = local[k];
  }
  return out as unknown as Settings;
}

/** Ce qui part sur le serveur : la base sans les réglages propres au poste. */
export function toShared(db: Database): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...db.settings };
  for (const k of LOCAL_ONLY_SETTINGS) delete settings[k];
  const out: Record<string, unknown> = { version: db.version, settings };
  for (const c of SYNCED_COLLECTIONS) out[c] = db[c];
  return out;
}

/** Fusion complète. `remote` peut être partiel (première synchro : espace vide). */
export function mergeDatabases(base: Database, local: Database, remote: Partial<Database>): { db: Database; localChanges: boolean; remoteChanges: boolean } {
  let localChanges = false, remoteChanges = false;
  const next: Database = { ...local };
  for (const c of SYNCED_COLLECTIONS) {
    const b = (base[c] ?? []) as unknown as Rec[], l = (local[c] ?? []) as unknown as Rec[], r = (remote[c] ?? (remote[c] === undefined ? b : [])) as unknown as Rec[];
    const m = mergeCollection(b, l, r);
    (next as unknown as Record<string, unknown>)[c] = m.rows;
    if (!same(m.rows, r)) localChanges = true;   // le serveur doit recevoir quelque chose
    if (!same(m.rows, l)) remoteChanges = true;  // ce poste doit changer quelque chose
  }
  const rs = remote.settings ? ({ ...local.settings, ...remote.settings } as Settings) : local.settings;
  next.settings = mergeSettings(base.settings, local.settings, rs);
  if (!same(toShared(next).settings, toShared({ ...next, settings: rs } as Database).settings)) localChanges = true;
  if (!same(next.settings, local.settings)) remoteChanges = true;
  return { db: next, localChanges, remoteChanges };
}
