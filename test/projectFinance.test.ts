import { describe, expect, it } from 'vitest';
import { emptyDatabase, type Product, type Project } from '../src/shared/types';
import { projectFinance } from '../src/shared/projectFinance';

const mk = (id: string, extra: Partial<Product>): Product => ({ id, projectId: null, folderId: null, name: id, familyId: id, version: 'V1', versionDate: '', versionNotes: '', isCurrentVersion: true, supplierName: '', sku: '', description: '', factoryId: null, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0, hsCode: '', dutyRatePct: 0, unitWeightKg: 0, unitsPerCarton: 1, cartonCbm: 0, notes: '', ...extra });

describe('analyse financière d\'une importation', () => {
  it('répartit le transport au volume et calcule le bénéfice avec / sans transport', () => {
    const db = emptyDatabase();
    db.settings.fxToEur.USD = 1; db.settings.defaultDutyRatePct = 0;
    db.products.push(mk('a', { name: 'A', factoryId: 'F', cartonCbm: 1, unitsPerCarton: 1 }), mk('b', { name: 'B', factoryId: 'F', cartonCbm: 3, unitsPerCarton: 1 }));
    db.orders.push({ id: 'o', projectId: 'imp', factoryId: 'F', reference: 'o', date: '', status: 'en_production', lines: [{ productId: 'a', qty: 10, unitPrice: 10, currency: 'USD' }, { productId: 'b', qty: 10, unitPrice: 20, currency: 'USD' }], depositPct: 30, depositPaid: true, balancePaid: false, productionDays: 30, expectedReadyDate: '', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null, notes: '' });
    db.shipments.push({ id: 's', projectId: 'imp', reference: 's', orderIds: ['o'], partnerId: null, agentId: null, mode: 'mer', incoterm: 'FOB', status: 'planifiee', etd: '', eta: '', cbm: 40, weightKg: 0, freightCost: 400, insuranceCost: 0, originFees: 0, destinationFees: 0, currency: 'USD', trackingRef: '', documentId: null, notes: '' });
    db.marketPrices.push({ id: 'm', productId: 'a', market: 'FR', sellPrice: 60, currency: 'EUR', vatPct: 20, platformFeePct: 0, lastMileCost: 0, date: '' });
    const project: Project = { id: 'imp', name: 'X', description: '', status: 'production', targetDate: '', container: '', notes: '', flows: [], layout: {}, contents: [{ productId: 'a', qty: 10 }, { productId: 'b', qty: 10 }], consolidatorFactoryId: null, docLinks: [], negotiations: [], createdAt: '', updatedAt: '' };
    db.projects.push(project);
    const f = projectFinance(db, project);
    expect(f.goodsEur).toBe(300);
    // volumes : A 10 m³, B 30 m³ → A porte 25 % du transport (100 €)
    const a = f.lines.find((l) => l.productId === 'a')!;
    expect(a.transportEur).toBeCloseTo(100, 6); expect(a.shareBasis).toBe('volume');
    // A : 60 € TTC → 50 € HT × 10 = 500 € ; sans transport 500 − 100 = 400 ; avec : 300
    expect(a.revenueEur).toBeCloseTo(500, 6);
    expect(a.profitNoTransportEur).toBeCloseTo(400, 6);
    expect(a.profitEur).toBeCloseTo(300, 6);
    expect(f.missingPrices.map((x) => x.productId)).toEqual(['b']);
    expect(f.profitEur).toBeCloseTo(300, 6);
  });
});
