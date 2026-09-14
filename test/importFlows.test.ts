import { describe, expect, it } from 'vitest';
import { emptyDatabase, type OrderLine, type Product, type Project } from '../src/shared/types';
import { generateFlows, proposeContents } from '../src/shared/importFlows';

const mk = (id: string, extra: Partial<Product>): Product => ({ id, projectId: null, folderId: null, name: id, familyId: id, version: 'V1', versionDate: '', versionNotes: '', isCurrentVersion: true, supplierName: '', sku: '', description: '', factoryId: null, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0, hsCode: '', dutyRatePct: 0, unitWeightKg: 0, unitsPerCarton: 0, cartonCbm: 0, notes: '', ...extra });
const base = (productId: string, qty: number) => ({ productId, qty, role: 'base' as const, optionGroup: '', isDefault: false });

function scenario() {
  const db = emptyDatabase();
  db.products.push(
    mk('epp', { name: 'Plaque EPP', factoryId: 'A' }),
    mk('frame', { name: 'Cadre', factoryId: 'B' }),
    mk('tissu', { name: 'Tissu', factoryId: 'C' }),
    mk('housse', { name: 'Housse', factoryId: 'D', components: [base('tissu', 2.4)] }),
    mk('wall', { name: 'Wall 1 m', factoryId: 'D', components: [base('epp', 1), base('frame', 1), base('housse', 1)] }),
  );
  const line = (productId: string, qty: number): OrderLine => ({ productId, qty, unitPrice: 1, currency: 'USD' });
  const order = (id: string, factoryId: string, lines: OrderLine[]) => ({ id, projectId: 'imp', factoryId, reference: id, date: '2026-09-01', status: 'en_production' as const, lines, depositPct: 30, depositPaid: true, balancePaid: false, productionDays: 30, expectedReadyDate: '', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null, notes: '' });
  db.orders.push(
    order('oA', 'A', [line('epp', 356)]),
    order('oB', 'B', [line('frame', 356)]),
    order('oC', 'C', [line('tissu', 1000)]),
    order('oD', 'D', [{ productId: '', qty: 356, unitPrice: 3, currency: 'USD', label: 'Confection + assemblage', isService: true }]),
  );
  const project: Project = { id: 'imp', name: 'Conteneur', description: '', status: 'production', targetDate: '2026-10-01', container: '40HQ', notes: '', flows: [], layout: {}, contents: [], consolidatorFactoryId: null, docLinks: [], negotiations: [], createdAt: '', updatedAt: '' };
  db.projects.push(project);
  return { db, project };
}

describe('contenu du conteneur déduit des compositions', () => {
  it('propose le produit fini assemblé chez la dernière usine, même sans référence sur sa facture', () => {
    const { db, project } = scenario();
    const props = proposeContents(db, project);
    const wall = props.find((p) => p.productId === 'wall');
    expect(wall?.qty).toBe(356);
    expect(wall?.kind).toBe('assembled');
    // Reliquat de tissu (1000 − 356 × 2,4 = 145,6 m) : composant du Wall, il ne monte PAS dans le conteneur
    const tissu = props.find((p) => p.productId === 'tissu');
    expect(tissu?.kind).toBe('component');
    expect(tissu?.qty).toBe(0);
    expect(tissu?.reason).toContain('145.6');
    expect(props.some((p) => p.productId === 'epp')).toBe(false);
  });

  it('un produit fini facturé tel quel consomme ses composants facturés à part (paravents + tissu)', () => {
    const { db, project } = scenario();
    db.products.push(mk('paravent', { name: 'Paravent', factoryId: 'D', components: [base('tissu', 3)] }));
    // Facture paravents chez D + facture tissu chez C, sans Wall
    db.orders = db.orders.filter((o) => o.id === 'oC');
    db.orders.push({ id: 'oP', projectId: 'imp', factoryId: 'D', reference: 'oP', date: '2026-09-01', status: 'en_production', lines: [{ productId: 'paravent', qty: 200, unitPrice: 40, currency: 'USD' }], depositPct: 30, depositPaid: true, balancePaid: false, productionDays: 30, expectedReadyDate: '', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null, notes: '' });
    const props = proposeContents(db, project);
    expect(props.find((p) => p.productId === 'paravent')).toMatchObject({ qty: 200, kind: 'ordered' });
    const tissu = props.find((p) => p.productId === 'tissu');
    expect(tissu?.kind).toBe('component');
    expect(tissu?.qty).toBe(0);
  });

  it('génère les flux A→D, B→D, C→D et D→France', () => {
    const { db, project } = scenario();
    const flows = generateFlows(db, project, [{ productId: 'wall', qty: 356 }], () => Math.random().toString(36).slice(2), '2026-09-08');
    const key = (f: { fromFactoryId: string; to: string }) => `${f.fromFactoryId}→${f.to}`;
    expect(flows.map(key).sort()).toEqual(['A→D', 'B→D', 'C→D', 'D→FR']);
    expect(flows.find((f) => key(f) === 'C→D')?.lines[0]).toEqual({ productId: 'tissu', qty: 854.4 });
    expect(flows.find((f) => key(f) === 'D→FR')?.lines).toEqual([{ productId: 'wall', qty: 356 }]);
    expect(flows.every((f) => f.auto)).toBe(true);
  });

  it('fait converger vers l\'usine de groupage quand elle est définie', () => {
    const { db, project } = scenario();
    db.factories.push({ id: 'D', name: 'D', city: '', province: '', address: '', website: '', wechat: '', email: '', phone: '', specialties: '', rating: 0, notes: '', comments: [] });
    project.consolidatorFactoryId = 'D';
    const flows = generateFlows(db, project, [{ productId: 'wall', qty: 356 }, { productId: 'tissu', qty: 100 }], () => 'x', '');
    const key = (f: { fromFactoryId: string; to: string }) => `${f.fromFactoryId}→${f.to}`;
    expect(flows.map(key).sort()).toEqual(['A→D', 'B→D', 'C→D', 'D→FR']);
    expect(flows.find((f) => key(f) === 'C→D')?.lines.find((l) => l.productId === 'tissu')?.qty).toBeCloseTo(954.4, 1);
    expect(flows.find((f) => key(f) === 'D→FR')?.lines).toEqual([{ productId: 'wall', qty: 356 }, { productId: 'tissu', qty: 100 }]);
  });

  it('conserve le statut des flux existants et les flux manuels', () => {
    const { db, project } = scenario();
    project.flows = [
      { id: 'f1', fromFactoryId: 'A', to: 'D', lines: [{ productId: 'epp', qty: 10 }], date: '2026-09-02', status: 'recu', note: 'camion', auto: true },
      { id: 'manual', fromFactoryId: 'B', to: 'A', lines: [], date: '', status: 'prevu', note: 'échantillons' },
      { id: 'stale', fromFactoryId: 'C', to: 'A', lines: [], date: '', status: 'prevu', note: '', auto: true },
    ];
    const flows = generateFlows(db, project, [{ productId: 'wall', qty: 356 }], () => 'x', '');
    const ad = flows.find((f) => f.id === 'f1')!;
    expect(ad.status).toBe('recu'); expect(ad.note).toBe('camion'); expect(ad.lines[0].qty).toBe(356);
    expect(flows.some((f) => f.id === 'manual')).toBe(true);
    expect(flows.some((f) => f.id === 'stale')).toBe(false);
  });
});

describe('liste de courses → besoins par usine', () => {
  it('éclate les produits finis en composants à commander chez chaque usine', async () => {
    const { explodeNeeds } = await import('../src/shared/importFlows');
    const { db } = scenario();
    const needs = explodeNeeds(db, [{ productId: 'wall', qty: 100 }]);
    const by = Object.fromEntries(needs.map((n) => [n.productId, n]));
    expect(by.wall.factoryId).toBe('D'); expect(by.wall.qty).toBe(100);
    expect(by.epp.factoryId).toBe('A'); expect(by.epp.qty).toBe(100);
    expect(by.frame.factoryId).toBe('B'); expect(by.frame.qty).toBe(100);
    expect(by.housse.factoryId).toBe('D'); expect(by.housse.qty).toBe(100);
    expect(by.tissu.factoryId).toBe('C'); expect(by.tissu.qty).toBe(240);
  });
});

describe('prix facturé par usine', () => {
  it('compose le prix d\'un produit sans devis : sous-références de la même usine + coûts additionnels', async () => {
    const { factoryLinePrice } = await import('../src/shared/importFlows');
    const { db } = scenario();
    db.quotes.push({ id: 'q1', productId: 'housse', factoryId: 'D', date: '2026-09-01', unitPrice: 20, currency: 'USD', moq: 0, incoterm: 'FOB', leadTimeDays: 0, documentId: null, notes: '' });
    const wall = db.products.find((p) => p.id === 'wall')!;
    wall.extraCosts = [{ id: 'x', label: 'Assemblage', amount: 10, currency: 'USD', amountEur: 0, note: '' }];
    const price = factoryLinePrice(db, 'wall', 'D')!;
    expect(price.source).toBe('composition');
    // 20 USD (housse) + 10 USD (assemblage) = 30 USD → EUR au taux de 0,92
    expect(price.eur).toBeCloseTo(30 * 0.92, 2);
  });
});

describe('versions de marchandises', () => {
  it('un tissu facturé en V2 est reconnu comme composant d\'un paravent dont la composition cite la V1', async () => {
    const { proposeContents } = await import('../src/shared/importFlows');
    const db = emptyDatabase();
    db.products.push(
      mk('tissu', { name: 'Tissu V1', familyId: 'tissu', factoryId: 'C', isCurrentVersion: false }),
      mk('tissu2', { name: 'Tissu V2', familyId: 'tissu', factoryId: 'C', version: 'V2', isCurrentVersion: true }),
      mk('paravent', { name: 'Paravent', factoryId: 'D', components: [base('tissu', 3)] }),
    );
    const order = (id: string, factoryId: string, productId: string, qty: number) => ({ id, projectId: 'imp', factoryId, reference: id, date: '2026-09-01', status: 'en_production' as const, lines: [{ productId, qty, unitPrice: 1, currency: 'USD' as const }], depositPct: 30, depositPaid: true, balancePaid: false, productionDays: 30, expectedReadyDate: '', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null, notes: '' });
    db.orders.push(order('oT', 'C', 'tissu2', 700), order('oP', 'D', 'paravent', 200));
    const project: Project = { id: 'imp', name: 'Conteneur', description: '', status: 'production', targetDate: '', container: '40HQ', notes: '', flows: [], layout: {}, contents: [], consolidatorFactoryId: null, docLinks: [], negotiations: [], createdAt: '', updatedAt: '' };
    db.projects.push(project);
    const props = proposeContents(db, project);
    expect(props.find((p) => p.productId === 'paravent')).toMatchObject({ qty: 200, kind: 'ordered' });
    expect(props.find((p) => p.productId === 'tissu2')?.kind).toBe('component');
    expect(props.some((p) => p.kind === 'ordered' && p.productId !== 'paravent')).toBe(false);
  });
});
