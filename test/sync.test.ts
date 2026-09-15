import { describe, expect, it } from 'vitest';
import { emptyDatabase, type Database, type Factory } from '../src/shared/types';
import { mergeCollection, mergeDatabases, toShared } from '../src/shared/sync';

const fac = (id: string, name: string): Factory => ({ id, name, city: '', province: '', address: '', website: '', wechat: '', email: '', phone: '', specialties: '', rating: 0, notes: '', comments: [] });

describe('fusion à trois voies', () => {
  it('garde les modifications des deux côtés et applique les suppressions', () => {
    const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];
    const local = [{ id: 'a', v: 2 }, { id: 'c', v: 1 }, { id: 'd', v: 1 }];          // a modifié, b supprimé, d créé
    const remote = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 3 }, { id: 'e', v: 1 }]; // c modifié, e créé
    const { rows } = mergeCollection(base, local, remote);
    expect(rows.map((r) => `${r.id}${r.v}`).sort()).toEqual(['a2', 'c3', 'd1', 'e1']);
  });
  it('en cas de conflit sur la même fiche, le local gagne ; une fiche modifiée à distance mais supprimée localement est conservée', () => {
    const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
    const local = [{ id: 'a', v: 2 }];
    const remote = [{ id: 'a', v: 3 }, { id: 'b', v: 9 }];
    const { rows } = mergeCollection(base, local, remote);
    expect(rows).toEqual([{ id: 'a', v: 2 }, { id: 'b', v: 9 }]);
  });
  it('fusionne une base complète ; les réglages Gmail restent locaux, la clé API est partagée', () => {
    const base = emptyDatabase();
    const local: Database = { ...emptyDatabase(), factories: [fac('f1', 'Kuo Ching')] };
    local.settings = { ...local.settings, gmail: { ...local.settings.gmail, email: 'theo@x.fr' } };
    const remoteDb: Database = { ...emptyDatabase(), factories: [fac('f2', 'Vangarden')] };
    remoteDb.settings = { ...remoteDb.settings, anthropicApiKey: 'sk-shared' };
    const remote = toShared(remoteDb) as Partial<Database>;
    expect((remote.settings as unknown as Record<string, unknown>).gmail).toBeUndefined();
    const m = mergeDatabases(base, local, remote);
    expect(m.db.factories.map((f) => f.id).sort()).toEqual(['f1', 'f2']);
    expect(m.db.settings.anthropicApiKey).toBe('sk-shared');
    expect(m.db.settings.gmail.email).toBe('theo@x.fr');
    expect(m.localChanges).toBe(true); expect(m.remoteChanges).toBe(true);
  });
  it('rien à faire quand tout est identique', () => {
    const base = { ...emptyDatabase(), factories: [fac('f1', 'A')] };
    const m = mergeDatabases(base, base, toShared(base) as Partial<Database>);
    expect(m.localChanges).toBe(false); expect(m.remoteChanges).toBe(false);
  });
});
