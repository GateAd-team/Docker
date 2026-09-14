import { describe, expect, it } from 'vitest';
import { seedDatabase } from '../src/renderer/seed';
import { buildOverview, runTool } from '../src/shared/assistant';

describe('assistant : outils de synthèse', () => {
  const db = seedDatabase();
  it('construit un état du logiciel lisible', () => {
    const o = buildOverview(db);
    expect(o).toContain('IMPORTATIONS');
    expect(o).toContain(db.projects[0].name);
  });
  it('analyse une importation sans planter', () => {
    const p = db.projects.find((x) => x.contents.length)!;
    const r = runTool(db, 'analyser_importation', { projectId: p.id }).result as { analyseFinanciere: unknown; besoinsParUsine: Record<string, unknown[]> };
    expect(typeof r.analyseFinanciere).toBe('object');
    expect(Object.keys(r.besoinsParUsine).length).toBeGreaterThan(0);
  });
  it('détaille une expédition et fait le point du jour', () => {
    const s = db.shipments[0];
    const r = runTool(db, 'expedition', { shipmentId: s.id }).result as { expedition: { reference: string } };
    expect(r.expedition.reference).toBe(s.reference);
    const pj = runTool(db, 'point_du_jour', {}).result as { importations: unknown[] };
    expect(pj.importations.length).toBeGreaterThan(0);
  });
});
