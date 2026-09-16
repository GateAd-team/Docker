import { describe, expect, it } from 'vitest';
import { shipmentForMail, suggestShipmentUpdate, shipmentCostsFromAnalysis } from '../src/shared/mailAnalysis';

const ship = { id: 's1', reference: 'FCL-2026-09 (40HQ)', trackingRef: 'MSKU1234567', status: 'planifiee' as const, etd: '2026-08-28', eta: '', notes: '' };

describe('email ↔ expédition', () => {
  it('rattache par numéro de conteneur', () => {
    expect(shipmentForMail({ subject: 'RE: Container MSKU 1234567 — customs', text: '' }, [ship])).toBe('s1');
    expect(shipmentForMail({ subject: 'Hello', text: 'nothing here' }, [ship])).toBeNull();
  });
  it('lit le statut et les dates', () => {
    const s = suggestShipmentUpdate({ date: '2026-08-29', subject: 'Vessel departed', text: 'Your container is on board. ETA Le Havre: 5 Oct 2026. Regards' }, ship);
    expect(s.status).toBe('en_transit');
    expect(s.eta).toBe('2026-10-05');
    expect(s.etd).toBe('');
  });
  it('ne fait jamais reculer le statut', () => {
    const s = suggestShipmentUpdate({ date: '2026-09-01', subject: 'Booking confirmed, cargo received at warehouse', text: '' }, { ...ship, status: 'en_transit' });
    expect(s.status).toBeNull();
  });
  it('comprend les dates françaises et numériques', () => {
    const s = suggestShipmentUpdate({ date: '2026-09-01', subject: 'Départ prévu : 12/09/2026', text: 'Arrivée prévue le 15 oct' }, ship);
    expect(s.etd).toBe('2026-09-12');
    expect(s.eta).toBe('2026-10-15');
  });
});

describe('doublons d\'expéditions', async () => {
  const { findDuplicateShipments, mergeShipments, removeShipmentFromDb } = await import('../src/shared/mailAnalysis');
  const base = { id: 'a', projectId: null, reference: 'FCL sept', orderIds: ['o1'], partnerId: 'p1', agentId: null, mode: 'mer' as const, incoterm: 'FOB' as const, status: 'planifiee' as const, etd: '2026-08-28', eta: '', cbm: 0, weightKg: 0, freightCost: 4200, insuranceCost: 0, originFees: 0, destinationFees: 0, currency: 'USD' as const, trackingRef: 'MSKU1234567', documentId: null, notes: '' };
  const other = { ...base, id: 'b', reference: 'Container MSKU 1234567', orderIds: ['o2'], partnerId: null, status: 'en_transit' as const, etd: '', eta: '2026-10-05', cbm: 67, freightCost: 0, trackingRef: '', notes: 'Navire MSC Anna.' };
  it('détecte le même conteneur écrit différemment', () => { expect(findDuplicateShipments([base, other]).length).toBe(1); });
  it('fusionne en complétant les trous et en gardant le statut le plus avancé', () => {
    const m = mergeShipments(base, other);
    expect(m.id).toBe('a'); expect(m.status).toBe('en_transit'); expect(m.eta).toBe('2026-10-05'); expect(m.etd).toBe('2026-08-28');
    expect(m.cbm).toBe(67); expect(m.freightCost).toBe(4200); expect(m.orderIds).toEqual(['o1', 'o2']); expect(m.notes).toContain('MSC Anna');
  });
  it('détache les emails à la suppression', () => {
    const d = removeShipmentFromDb({ shipments: [base], mails: [{ shipmentId: 'a' }, { shipmentId: null }] }, 'a');
    expect(d.shipments).toEqual([]); expect(d.mails[0].shipmentId).toBeNull();
  });
});

describe('shipmentCostsFromAnalysis', () => {
  const cur = { freightCost: 1200, insuranceCost: 0, originFees: 150, destinationFees: 0, currency: 'USD' as const, notes: '' };
  it('une facture remplace le devis et force le total', () => {
    const r = shipmentCostsFromAnalysis(cur, { freightCost: 1800, originFees: 200, destinationFees: 350, insuranceCost: null, invoiceTotal: 2400, invoiceRef: 'F-2026-118', invoiceCurrency: 'EUR' });
    expect(r.freightCost + r.originFees + r.destinationFees + r.insuranceCost).toBe(2400);
    expect(r.freightCost).toBe(1850); expect(r.currency).toBe('EUR'); expect(r.invoiceNote).toContain('F-2026-118');
  });
  it('détail incohérent : tout dans le fret', () => {
    const r = shipmentCostsFromAnalysis(cur, { originFees: 3000, invoiceTotal: 2400, invoiceCurrency: 'USD' });
    expect(r).toMatchObject({ freightCost: 2400, originFees: 0, destinationFees: 0, insuranceCost: 0 });
  });
  it('sans facture : on complète seulement les montants manquants', () => {
    const r = shipmentCostsFromAnalysis(cur, { freightCost: 999, destinationFees: 400, currency: 'EUR' });
    expect(r).toMatchObject({ freightCost: 1200, originFees: 150, destinationFees: 400, currency: 'USD', invoiceNote: '' });
  });
});
