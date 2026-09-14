import { describe, expect, it } from 'vitest';
import { emptyDatabase, type Product, type Project } from '../src/shared/types';
import { buildCounterOffer, buildNegotiationLines, buildRfq, counterPrice, suggestTarget } from '../src/shared/negotiation';

const mk = (id: string, extra: Partial<Product>): Product => ({ id, projectId: null, folderId: null, name: id, familyId: id, version: 'V1', versionDate: '', versionNotes: '', isCurrentVersion: true, supplierName: '', sku: '', description: '', factoryId: null, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0, hsCode: '', dutyRatePct: 0, unitWeightKg: 0, unitsPerCarton: 0, cartonCbm: 0, notes: '', ...extra });
const fac = (id: string, name: string) => ({ id, name, city: '', province: '', address: '', website: '', wechat: '', email: '', phone: '', specialties: '', rating: 0, notes: '', comments: [] });
const quote = (id: string, productId: string, factoryId: string, unitPrice: number, date: string, moq = 0) => ({ id, productId, factoryId, date, unitPrice, currency: 'USD' as const, moq, incoterm: 'FOB' as const, leadTimeDays: 30, documentId: null, notes: '' });

function scenario() {
  const db = emptyDatabase();
  db.factories.push(fac('A', 'Vangarden'), fac('B', 'Onmuse'));
  db.products.push(mk('frame', { name: 'Grand cadre', supplierName: 'Big Frame 2000x1000', factoryId: 'A' }));
  db.quotes.push(quote('q1', 'frame', 'A', 26.1, '2026-05-10', 356), quote('q2', 'frame', 'B', 24.1, '2026-08-01', 300));
  const project: Project = { id: 'imp', name: 'Conteneur', description: '', status: 'sourcing', targetDate: '2026-11-15', container: '40HQ', notes: '', flows: [], layout: {}, contents: [{ productId: 'frame', qty: 400 }], consolidatorFactoryId: null, docLinks: [], negotiations: [], createdAt: '', updatedAt: '' };
  db.projects.push(project);
  return { db, project };
}

describe('négociation assistée', () => {
  it('vise le concurrent moins cher, sinon ~7 % sous le dernier prix', () => {
    expect(suggestTarget(26.1, 24.1, 400, 356)).toBe(24.1);
    expect(suggestTarget(26.1, null, 400, 356)).toBeCloseTo(24.27, 2);
    expect(suggestTarget(26.1, null, 200, 356)).toBeCloseTo(25.06, 2); // quantité en baisse : effort plus modeste
    expect(suggestTarget(null, null, 10, 0)).toBeNull();
  });

  it('ouvre les lignes avec dernier prix et cible', () => {
    const { db, project } = scenario();
    const lines = buildNegotiationLines(db, project, 'A');
    expect(lines).toHaveLength(1);
    expect(lines[0].qty).toBe(400); expect(lines[0].lastPrice).toBe(26.1); expect(lines[0].targetPrice).toBe(24.1);
  });

  it('rédige la demande de prix en anglais et en chinois avec la concurrence', () => {
    const { db, project } = scenario();
    const neg = { id: 'n', factoryId: 'A', status: 'a_lancer' as const, lines: buildNegotiationLines(db, project, 'A'), messages: [], notes: '' };
    const txt = buildRfq({ db, project, neg, sender: 'Théo', company: 'Wall Up' });
    expect(txt).toContain('400 × Big Frame 2000x1000');
    expect(txt).toContain('last time 26.10 USD');
    expect(txt).toContain('other offers');
    expect(txt).toContain('中文');
    expect(txt).toContain('24.10 USD');
  });

  it('propose une contre-offre entre l\'offre et la cible', () => {
    expect(counterPrice(26, 24)).toBeCloseTo(24.8, 2);
    expect(counterPrice(23, 24)).toBe(23);
    const { db, project } = scenario();
    const lines = buildNegotiationLines(db, project, 'A').map((l) => ({ ...l, offeredPrice: 26 }));
    const neg = { id: 'n', factoryId: 'A', status: 'en_cours' as const, lines, messages: [], notes: '' };
    const txt = buildCounterOffer({ db, project, neg, sender: 'Théo', company: 'Wall Up' });
    expect(txt).toContain('Could you do 24.86 USD');
    expect(txt).toContain('another offer at 24.10 USD');
  });
});
