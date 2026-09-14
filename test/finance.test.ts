import { describe, expect, it } from 'vitest';
import { computeLandedCost, computeMargin, priceForTargetMargin, toEur, type ShipmentContext } from '../src/shared/finance';
import { DEFAULT_SETTINGS, type MarketPrice, type Product, type Settings, type Shipment } from '../src/shared/types';

const settings: Settings = { ...DEFAULT_SETTINGS, fxToEur: { EUR: 1, USD: 0.9, GBP: 1.2, CNY: 0.125 } };

const frame: Product = { id: 'p1', projectId: 'pr', folderId: null, name: 'Grand cadre', familyId: 'p1', version: 'V1', versionDate: '', versionNotes: '', isCurrentVersion: true, supplierName: '', sku: '', description: '', factoryId: null, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0, hsCode: '', dutyRatePct: 6, unitWeightKg: 4, unitsPerCarton: 6, cartonCbm: 0.522, notes: '' };
const trolley: Product = { id: 'p2', projectId: 'pr', folderId: null, name: 'Chariot', familyId: 'p2', version: 'V1', versionDate: '', versionNotes: '', isCurrentVersion: true, supplierName: '', sku: '', description: '', factoryId: null, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0, hsCode: '', dutyRatePct: 2, unitWeightKg: 36, unitsPerCarton: 1, cartonCbm: 1.0, notes: '' };

const shipment: Shipment = {
  id: 's1', projectId: null, reference: 'EXP-1', orderIds: ['o1'], partnerId: null, agentId: null, mode: 'mer', incoterm: 'FOB',
  status: 'en_transit', etd: '', eta: '', cbm: 40, weightKg: 2000,
  freightCost: 3000, insuranceCost: 100, originFees: 400, destinationFees: 900, currency: 'USD', trackingRef: '', documentId: null, notes: '',
};

describe('conversion', () => {
  it('convertit en EUR avec le taux', () => {
    expect(toEur(100, 'USD', settings)).toBeCloseTo(90);
    expect(toEur(100, 'EUR', settings)).toBe(100);
  });
});

describe('coût de revient', () => {
  it('sans expédition : marchandise + droits uniquement', () => {
    const b = computeLandedCost(frame, { productId: 'p1', qty: 100, unitPrice: 26.1, currency: 'USD' }, null, settings);
    expect(b.goodsUnitEur).toBeCloseTo(23.49);
    expect(b.freightUnitEur).toBe(0);
    expect(b.dutyUnitEur).toBeCloseTo(23.49 * 0.06);
    expect(b.landedUnitEur).toBeCloseTo(23.49 * 1.06);
    expect(b.shareBasis).toBe('aucune');
  });

  it("répartit la logistique au prorata du volume", () => {
    const l1 = { productId: 'p1', qty: 60, unitPrice: 26.1, currency: 'USD' as const }; // 10 cartons = 5.22 m³
    const l2 = { productId: 'p2', qty: 10, unitPrice: 170, currency: 'USD' as const };  // 10 m³
    const ctx: ShipmentContext = { shipment, lines: [{ line: l1, product: frame }, { line: l2, product: trolley }] };
    const b1 = computeLandedCost(frame, l1, ctx, settings);
    const b2 = computeLandedCost(trolley, l2, ctx, settings);
    expect(b1.shareBasis).toBe('volume');
    expect(b1.share + b2.share).toBeCloseTo(1);
    expect(b1.share).toBeCloseTo(5.22 / 15.22);
    // Logistique totale 4400 USD = 3960 EUR, entièrement répartie
    const total = (b1.freightUnitEur + b1.insuranceUnitEur + b1.originFeesUnitEur + b1.destinationFeesUnitEur) * 60
      + (b2.freightUnitEur + b2.insuranceUnitEur + b2.originFeesUnitEur + b2.destinationFeesUnitEur) * 10;
    expect(total).toBeCloseTo(3960);
    // Les droits s'appliquent sur la valeur CIF (marchandise + fret + assurance + frais départ), pas sur les frais d'arrivée
    expect(b1.dutyUnitEur).toBeCloseTo((b1.goodsUnitEur + b1.freightUnitEur + b1.insuranceUnitEur + b1.originFeesUnitEur) * 0.06);
    expect(b1.landedUnitEur).toBeCloseTo(b1.customsValueUnitEur + b1.dutyUnitEur + b1.destinationFeesUnitEur);
  });

  it('retombe sur la valeur si le volume est inconnu', () => {
    const noCbm: Product = { ...frame, cartonCbm: 0 };
    const l1 = { productId: 'p1', qty: 10, unitPrice: 100, currency: 'USD' as const };
    const l2 = { productId: 'p2', qty: 10, unitPrice: 300, currency: 'USD' as const };
    const ctx: ShipmentContext = { shipment, lines: [{ line: l1, product: noCbm }, { line: l2, product: { ...trolley, cartonCbm: 0 } }] };
    const b1 = computeLandedCost(noCbm, l1, ctx, settings);
    expect(b1.shareBasis).toBe('valeur');
    expect(b1.share).toBeCloseTo(0.25);
  });
});

describe('marges', () => {
  const mpFR: MarketPrice = { id: 'm', productId: 'p1', market: 'FR', sellPrice: 120, currency: 'EUR', vatPct: 20, platformFeePct: 10, lastMileCost: 8, date: '' };
  it('calcule la marge nette sur prix HT', () => {
    const m = computeMargin(40, mpFR, settings);
    expect(m.sellPriceHtEur).toBeCloseTo(100);
    expect(m.platformFeeEur).toBeCloseTo(10);
    expect(m.netRevenueEur).toBeCloseTo(82);
    expect(m.marginEur).toBeCloseTo(42);
    expect(m.marginPct).toBeCloseTo(42);
    expect(m.coefficient).toBeCloseTo(2.5);
  });
  it('gère un marché sans TVA en devise étrangère', () => {
    const mpUS: MarketPrice = { ...mpFR, market: 'US', sellPrice: 100, currency: 'USD', vatPct: 0, platformFeePct: 15, lastMileCost: 10 };
    const m = computeMargin(40, mpUS, settings);
    expect(m.sellPriceHtEur).toBeCloseTo(90);
    expect(m.netRevenueEur).toBeCloseTo(90 - 13.5 - 9);
  });
  it('trouve le prix TTC pour une marge cible', () => {
    const price = priceForTargetMargin(40, 42, mpFR, settings);
    expect(price).toBeCloseTo(120);
    const check = computeMargin(40, { ...mpFR, sellPrice: price }, settings);
    expect(check.marginPct).toBeCloseTo(42);
  });
});

describe('composition', () => {
  it('additionne les sous-références et le coût additionnel', async () => {
    const { unitCost } = await import('../src/shared/finance');
    const mk = (id: string, extra: Partial<Product>): Product => ({ id, projectId: null, folderId: null, name: id, familyId: id, version: 'V1', versionDate: '', versionNotes: '', isCurrentVersion: true, supplierName: '', sku: '', description: '', factoryId: null, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0, hsCode: '', dutyRatePct: 0, unitWeightKg: 0, unitsPerCarton: 0, cartonCbm: 0, notes: '', ...extra });
    const tissu = mk('tissu', {});
    const housse = mk('housse', { components: [{ productId: 'tissu', qty: 2.5, role: 'base', optionGroup: '', isDefault: false }], extraCosts: [{ id: 'x', label: 'Assemblage', amount: 1, currency: 'EUR', amountEur: 1, note: '' }] });
    const wall = mk('wall', { components: [{ productId: 'housse', qty: 1, role: 'base', optionGroup: '', isDefault: false }, { productId: 'cadre', qty: 1, role: 'base', optionGroup: '', isDefault: false }] });
    const cadre = mk('cadre', {});
    const quotes = [
      { id: 'q1', productId: 'tissu', factoryId: 'f', date: '2026-01-01', unitPrice: 4, currency: 'EUR' as const, moq: 0, incoterm: 'FOB' as const, leadTimeDays: 0, documentId: null, notes: '' },
      { id: 'q2', productId: 'cadre', factoryId: 'f', date: '2026-01-01', unitPrice: 20, currency: 'EUR' as const, moq: 0, incoterm: 'FOB' as const, leadTimeDays: 0, documentId: null, notes: '' },
    ];
    const db = { products: [tissu, housse, wall, cadre], orders: [], shipments: [], quotes, settings };
    const r = unitCost('wall', db)!;
    expect(r.basis).toBe('composition');
    expect(r.costEur).toBeCloseTo(2.5 * 4 + 1 + 20);
    expect(r.missing).toEqual([]);
  });
  it('signale les sous-références sans prix et ignore les boucles', async () => {
    const { unitCost } = await import('../src/shared/finance');
    const mk = (id: string, extra: Partial<Product>): Product => ({ id, projectId: null, folderId: null, name: id, familyId: id, version: 'V1', versionDate: '', versionNotes: '', isCurrentVersion: true, supplierName: '', sku: '', description: '', factoryId: null, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0, hsCode: '', dutyRatePct: 0, unitWeightKg: 0, unitsPerCarton: 0, cartonCbm: 0, notes: '', ...extra });
    const a = mk('a', { components: [{ productId: 'b', qty: 1, role: 'base', optionGroup: '', isDefault: false }] });
    const b = mk('b', { components: [{ productId: 'a', qty: 1, role: 'base', optionGroup: '', isDefault: false }] });
    const r = unitCost('a', { products: [a, b], orders: [], shipments: [], quotes: [], settings });
    expect(r?.missing.length).toBeGreaterThan(0);
  });
});

describe('options', () => {
  it("compte l'option par défaut et permet de simuler une autre variante", async () => {
    const { unitCost } = await import('../src/shared/finance');
    const mk = (id: string, extra: Partial<Product>): Product => ({ id, projectId: null, folderId: null, name: id, familyId: id, version: 'V1', versionDate: '', versionNotes: '', isCurrentVersion: true, supplierName: '', sku: '', description: '', factoryId: null, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0, hsCode: '', dutyRatePct: 0, unitWeightKg: 0, unitsPerCarton: 0, cartonCbm: 0, notes: '', ...extra });
    const q = (productId: string, unitPrice: number) => ({ id: `q-${productId}`, productId, factoryId: 'f', date: '2026-01-01', unitPrice, currency: 'EUR' as const, moq: 0, incoterm: 'FOB' as const, leadTimeDays: 0, documentId: null, notes: '' });
    const wall = mk('wall', { components: [
      { productId: 'cadre', qty: 1, role: 'base', optionGroup: '', isDefault: false },
      { productId: 'housse-std', qty: 1, role: 'option', optionGroup: 'Housse', isDefault: true },
      { productId: 'housse-m1', qty: 1, role: 'option', optionGroup: 'Housse', isDefault: false },
    ] });
    const db = { products: [wall, mk('cadre', {}), mk('housse-std', {}), mk('housse-m1', {})], orders: [], shipments: [], quotes: [q('cadre', 20), q('housse-std', 8), q('housse-m1', 14)], settings };
    expect(unitCost('wall', db)!.costEur).toBeCloseTo(28);
    expect(unitCost('wall', db, new Set(), { Housse: 'housse-m1' })!.costEur).toBeCloseTo(34);
  });
});

describe('prix usine + sous-références', () => {
  it('additionne le prix usine et les sous-références, sauf si incluses', async () => {
    const { unitCost } = await import('../src/shared/finance');
    const mk = (id: string, extra: Partial<Product>): Product => ({ id, projectId: null, folderId: null, name: id, familyId: id, version: 'V1', versionDate: '', versionNotes: '', isCurrentVersion: true, supplierName: '', sku: '', description: '', factoryId: null, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0, hsCode: '', dutyRatePct: 0, unitWeightKg: 0, unitsPerCarton: 0, cartonCbm: 0, notes: '', ...extra });
    const q = (productId: string, unitPrice: number) => ({ id: `q-${productId}`, productId, factoryId: 'f', date: '2026-01-01', unitPrice, currency: 'EUR' as const, moq: 0, incoterm: 'FOB' as const, leadTimeDays: 0, documentId: null, notes: '' });
    const housse = mk('housse', { components: [{ productId: 'tissu', qty: 2, role: 'base', optionGroup: '', isDefault: false }] });
    const db = { products: [housse, mk('tissu', {})], orders: [], shipments: [], quotes: [q('housse', 5), q('tissu', 3)], settings };
    const r = unitCost('housse', db)!;
    expect(r.basis).toBe('achat+composition');
    expect(r.costEur).toBeCloseTo(5 + 6);
    const db2 = { ...db, products: [{ ...housse, componentsIncludedInPrice: true }, mk('tissu', {})] };
    expect(unitCost('housse', db2)!.costEur).toBeCloseTo(5);
  });
});
