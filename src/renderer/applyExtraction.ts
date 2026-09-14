/**
 * Transforme le résultat de la lecture IA d'un document en propositions de fiches
 * (usine, contacts, produits, devis, commande, expédition, plan…), puis les applique.
 * L'utilisateur garde la main : il choisit le projet, associe chaque produit à une fiche
 * existante ou en crée une nouvelle, et coche ce qu'il veut enregistrer.
 */
import type {
  Contact, Currency, Database, DocumentRecord, Drawing, ExtractionResult, Factory, Order, Partner, Product, Quote, Shipment,
} from '../shared/types';
import type { CatalogueData, ContactData, DrawingData, InvoiceData, PackingListData, TransportQuoteData } from '../shared/extraction';
import { newId, today } from './store';
import { toEur } from '../shared/finance';

export function norm(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/co\.?,? ?ltd\.?|technology|furniture|company|limited/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function similar(a: string, b: string): number {
  const ta = new Set(norm(a).split(' ').filter((t) => t.length > 2));
  const tb = new Set(norm(b).split(' ').filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  ta.forEach((t) => { if (tb.has(t)) common++; });
  return common / Math.min(ta.size, tb.size);
}

export function findFactory(db: Database, name: string): Factory | undefined {
  if (!name) return undefined;
  return db.factories.find((f) => norm(f.name) === norm(name)) ?? db.factories.find((f) => similar(f.name, name) >= 0.6);
}
export function findPartner(db: Database, name: string): Partner | undefined {
  if (!name) return undefined;
  return db.partners.find((p) => norm(p.name) === norm(name)) ?? db.partners.find((p) => similar(p.name, name) >= 0.6);
}
/** Ressemblance entre deux libellés de produit : les mots comptent, les nombres (dimensions) doivent être compatibles. */
export function productSimilarity(a: string, b: string): number {
  const toks = (x: string) => norm(x).split(' ').filter((t) => t.length > 1);
  const ta = toks(a), tb = toks(b);
  const isNum = (t: string) => /^\d+([.,]\d+)?$/.test(t);
  const wa = new Set(ta.filter((t) => !isNum(t) && t.length > 2)), wb = new Set(tb.filter((t) => !isNum(t) && t.length > 2));
  const na = new Set(ta.filter(isNum)), nb = new Set(tb.filter(isNum));
  if (!wa.size || !wb.size) return 0;
  let cw = 0; wa.forEach((t) => { if (wb.has(t)) cw++; });
  const wordScore = cw / Math.min(wa.size, wb.size);
  if (na.size && nb.size) {
    let cn = 0; na.forEach((t) => { if (nb.has(t)) cn++; });
    if (cn / Math.min(na.size, nb.size) < 0.5) return 0; // dimensions différentes → produits différents
  }
  return wordScore;
}

export function findProduct(db: Database, _projectId: string, label: string, sku = '', supplierLabel = ''): Product | undefined {
  const inProject = db.products;
  if (sku) { const bySku = inProject.find((p) => p.sku && norm(p.sku) === norm(sku)); if (bySku) return bySku; }
  let best: Product | undefined; let bestScore = 0;
  for (const p of inProject) {
    const s = Math.max(productSimilarity(p.name, label), p.supplierName ? productSimilarity(p.supplierName, label) : 0, supplierLabel && p.supplierName ? productSimilarity(p.supplierName, supplierLabel) : 0);
    if (s > bestScore) { best = p; bestScore = s; }
  }
  if (bestScore < 0.6 || !best) return undefined;
  // Si la fiche trouvée appartient à une famille, on renvoie sa version actuelle.
  const fam = best.familyId || best.id;
  return db.products.filter((x) => (x.familyId || x.id) === fam).find((x) => x.isCurrentVersion) ?? best;
}

export interface ProductProposal {
  key: string;
  label: string;
  /** Libellé brut sur le document (nom fournisseur). */
  supplierLabel: string;
  qty: number;
  unitPrice: number;
  hsCode: string;
  /** Champs de fiche remplis par l'IA (facultatifs). */
  details: { description: string; sku: string; dutyRatePct: number | null; unitWeightKg: number | null };
  /** Colisage déduit d'une packing list, si disponible. */
  packing?: { unitsPerCarton: number; cartonCbm: number; unitWeightKg: number };
  suggestedProductId: string | null;
  /** Prestation (confection, assemblage…) et non une marchandise. */
  isService: boolean;
}

export interface Proposal {
  kind: ExtractionResult['kind'];
  factory?: { draft: Factory; existingId: string | null };
  partner?: { draft: Partner; existingId: string | null };
  contacts: Omit<Contact, 'ownerId'>[];
  products: ProductProposal[];
  currency: Currency;
  quotes: boolean;              // proposer d'ajouter les prix à l'historique
  order?: Omit<Order, 'id' | 'projectId' | 'factoryId' | 'lines'>;
  shipment?: Omit<Shipment, 'id' | 'partnerId' | 'agentId' | 'orderIds'>;
  drawing?: Omit<Drawing, 'id' | 'productId' | 'documentId'>;
  needsProject: boolean;
  needsDrawingProduct: boolean;
}

const asCurrency = (c: unknown): Currency => (['USD', 'EUR', 'GBP', 'CNY'].includes(String(c).toUpperCase()) ? (String(c).toUpperCase() as Currency) : 'USD');
const asIncoterm = (s: unknown): 'EXW' | 'FOB' | 'CIF' | 'DDP' => { const v = String(s ?? '').toUpperCase(); return (['EXW', 'FOB', 'CIF', 'DDP'] as const).find((i) => v.includes(i)) ?? 'FOB'; };
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const s = (v: unknown): string => (v == null ? '' : String(v));

export function buildProposal(result: ExtractionResult, db: Database, doc: DocumentRecord): Proposal {
  const base: Proposal = { kind: result.kind, contacts: [], products: [], currency: 'USD', quotes: false, needsProject: false, needsDrawingProduct: false };
  const d = result.data as Record<string, unknown>;

  const factoryFrom = (sup: Partial<InvoiceData['supplier']> | undefined, specialties = ''): Proposal['factory'] | undefined => {
    if (!sup?.name) return undefined;
    const existing = findFactory(db, sup.name);
    return {
      existingId: existing?.id ?? null,
      draft: {
        id: existing?.id ?? newId(), name: s(sup.name), city: s(sup.city), province: s(sup.province), address: s(sup.address),
        website: s(sup.website), wechat: s(sup.wechat), email: s(sup.email), phone: s(sup.phone), specialties, rating: existing?.rating ?? 0, notes: '', comments: existing?.comments ?? [],
      },
    };
  };
  const contactFrom = (sup: { contactName?: string; email?: string; phone?: string; wechat?: string } | undefined, ownerType: Contact['ownerType']) => {
    if (!sup?.contactName) return;
    base.contacts.push({ id: newId(), ownerType, name: s(sup.contactName), role: '', email: s(sup.email), phone: s(sup.phone), wechat: s(sup.wechat), whatsapp: '' });
  };

  if (result.kind === 'facture' || result.kind === 'proforma' || result.kind === 'bon_de_commande') {
    const inv = d as unknown as InvoiceData & { packingList?: Partial<PackingListData> };
    base.needsProject = true;
    base.currency = asCurrency(inv.currency);
    base.factory = factoryFrom(inv.supplier);
    contactFrom(inv.supplier, 'factory');
    const packLines = inv.packingList?.lines ?? [];
    base.products = (inv.lines ?? []).map((l, i) => {
      const label = s(l.productName || l.description || l.model) || `Ligne ${i + 1}`;
      const pl = packLines.find((p) => similar(s(p.description || p.model), s(l.description || label)) >= 0.5);
      const fromPl = pl && n(pl.cartons) > 0 ? { unitsPerCarton: n(pl.pcsPerCarton) || Math.round(n(pl.qty) / n(pl.cartons)), cartonCbm: n(pl.cbm) / n(pl.cartons), unitWeightKg: n(pl.qty) ? n(pl.netKg) / n(pl.qty) : 0 } : undefined;
      const fromLine = n(l.pcsPerCarton) > 0 || n(l.cartonCbm) > 0 ? { unitsPerCarton: n(l.pcsPerCarton), cartonCbm: n(l.cartonCbm), unitWeightKg: n(l.unitWeightKg) } : undefined;
      const descr = [s(l.productDescription), [l.material && `Matière : ${s(l.material)}`, l.dimensions && `Dimensions : ${s(l.dimensions)}`, l.color && `Couleur : ${s(l.color)}`].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
      return {
        key: `l${i}`, label, supplierLabel: s(l.description || l.model || label), qty: n(l.qty), unitPrice: n(l.unitPrice), hsCode: s(l.hsCode),
        details: { description: descr, sku: s(l.model), dutyRatePct: l.suggestedDutyRatePct == null ? null : n(l.suggestedDutyRatePct), unitWeightKg: l.unitWeightKg == null ? null : n(l.unitWeightKg) },
        packing: fromPl ?? fromLine,
        suggestedProductId: null,
        isService: !!l.isService || /\b(sewing|assembl|assembly|labou?r|installation|workmanship|processing|confection|couture|montage|main[- ]d'?oeuvre|main[- ]d'?œuvre|service|fee)\b/i.test(`${s(l.description)} ${s(l.productName)}`) && !/\b(frame|cover|board|panel|trolley|fabric|bracket)\b/i.test(s(l.productName)),
      };
    });
    base.quotes = true;
    const extras = (inv.extraCosts ?? []).map((e) => `${s(e.label)} : ${n(e.amount)} ${base.currency}`).join(' · ');
    const pack = inv.packingList?.totals ? `Colisage : ${n(inv.packingList.totals.qty)} pcs / ${n(inv.packingList.totals.cartons)} colis / ${n(inv.packingList.totals.grossKg)} kg brut / ${n(inv.packingList.totals.cbm)} m³.` : '';
    base.order = {
      reference: s(inv.invoiceNumber || inv.proformaNumber), date: s(inv.date) || today(),
      status: result.kind === 'bon_de_commande' ? 'devis' : (inv.isProforma || result.kind === 'proforma') ? 'pi_recue' : 'acompte_paye', depositPct: 30, depositPaid: !(inv.isProforma || result.kind !== 'facture'), balancePaid: false,
      productionDays: n(inv.leadTimeDays), expectedReadyDate: '', invoiceDocumentId: doc.id, proformaDocumentId: null, packingListDocumentId: inv.packingList ? doc.id : null,
      notes: [inv.incoterm ? `Incoterm ${asIncoterm(inv.incoterm)}.` : '', inv.paymentTerms ? `Paiement : ${s(inv.paymentTerms)}.` : '', extras ? `Frais annexes : ${extras}.` : '', pack].filter(Boolean).join(' '),
    };
  } else if (result.kind === 'packing_list') {
    const pl = d as unknown as PackingListData;
    base.needsProject = true;
    base.factory = factoryFrom(pl.supplier);
    base.products = (pl.lines ?? []).map((l, i) => ({
      key: `l${i}`, label: s(l.description || l.model) || `Ligne ${i + 1}`, supplierLabel: s(l.description || l.model), qty: n(l.qty), unitPrice: 0, hsCode: s(l.hsCode),
      details: { description: '', sku: s(l.model), dutyRatePct: null, unitWeightKg: null },
      packing: n(l.cartons) > 0 ? { unitsPerCarton: n(l.pcsPerCarton) || Math.round(n(l.qty) / n(l.cartons)), cartonCbm: n(l.cbm) / n(l.cartons), unitWeightKg: n(l.qty) ? n(l.netKg) / n(l.qty) : 0 } : undefined,
      suggestedProductId: null, isService: false,
    }));
  } else if (result.kind === 'catalogue') {
    const cat = d as unknown as CatalogueData;
    base.needsProject = true;
    base.factory = factoryFrom(cat.supplier, (cat.products ?? []).slice(0, 4).map((p) => s(p.name)).join(', '));
    contactFrom(cat.supplier, 'factory');
    base.currency = asCurrency(cat.products?.[0]?.currency);
    base.products = (cat.products ?? []).map((p, i) => ({ key: `p${i}`, label: s(p.name || p.model) || `Produit ${i + 1}`, supplierLabel: s(p.name || p.model), qty: n(p.moq), unitPrice: n(p.price), hsCode: '', details: { description: s(p.description), sku: s(p.model), dutyRatePct: null, unitWeightKg: null }, suggestedProductId: null, isService: false }));
    base.quotes = base.products.some((p) => p.unitPrice > 0);
  } else if (result.kind === 'plan_technique') {
    const dr = d as unknown as DrawingData;
    base.needsProject = true; base.needsDrawingProduct = true;
    base.drawing = {
      version: s(dr.version) || '', title: s(dr.title || dr.partName) || doc.fileName,
      changelog: [dr.material ? `Matériau : ${s(dr.material)}` : '', dr.thicknessMm ? `ép. ${n(dr.thicknessMm)} mm` : '', dr.overallDimensionsMm ? `encombrement ${s(dr.overallDimensionsMm)}` : '', s(dr.notes)].filter(Boolean).join(' · '),
      status: 'brouillon', createdAt: new Date().toISOString(),
    };
  } else if (result.kind === 'devis_transport') {
    const tq = d as unknown as TransportQuoteData;
    const existing = tq.forwarder?.name ? findPartner(db, tq.forwarder.name) : undefined;
    if (tq.forwarder?.name) {
      base.partner = { existingId: existing?.id ?? null, draft: { id: existing?.id ?? newId(), type: 'transporteur', name: s(tq.forwarder.name), city: s(tq.forwarder.city), email: s(tq.forwarder.email), phone: s(tq.forwarder.phone), wechat: s(tq.forwarder.wechat), services: '', notes: '', insights: { summary: '', actions: [], analyzedAt: '' } } };
      contactFrom(tq.forwarder, 'partner');
    }
    const mode = (['mer', 'air', 'rail', 'express'] as const).find((m) => s(tq.mode).toLowerCase().includes(m) || (m === 'mer' && /sea|ocean|fcl|lcl/i.test(s(tq.mode)))) ?? 'mer';
    base.currency = asCurrency(tq.currency);
    const st = (['planifiee', 'collectee', 'en_transit', 'dedouanement', 'livree'] as const).find((x) => x === s(tq.status)) ?? 'planifiee';
    base.shipment = {
      projectId: null, reference: s(tq.containerNo) ? `${s(tq.origin) || 'Chine'} → ${s(tq.destination) || 'France'} · ${s(tq.containerNo)}` : `${s(tq.origin) || 'Chine'} → ${s(tq.destination) || 'France'}${tq.date ? ` (${s(tq.date)})` : ''}`, mode, incoterm: asIncoterm(tq.incoterm), status: st,
      etd: s(tq.etd), eta: s(tq.eta), cbm: n(tq.cbm), weightKg: n(tq.weightKg), freightCost: n(tq.freightCost), insuranceCost: n(tq.insuranceCost), originFees: n(tq.originFees), destinationFees: n(tq.destinationFees),
      currency: base.currency, trackingRef: s(tq.containerNo) || s(tq.blNo), documentId: doc.id,
      notes: [s(tq.blNo) && s(tq.containerNo) ? `B/L ${s(tq.blNo)}.` : '', tq.vessel ? `Navire ${s(tq.vessel)}.` : '', tq.transitDays ? `Transit ${n(tq.transitDays)} j.` : '', tq.validUntil ? `Valable jusqu'au ${s(tq.validUntil)}.` : '', ...(tq.details ?? []).map((x) => `${s(x.label)} : ${n(x.amount)}`)].filter(Boolean).join(' '),
    };
  } else if (result.kind === 'contact') {
    const c = d as unknown as ContactData;
    const type = c.companyType === 'transporteur' ? 'transporteur' : c.companyType === 'agent' ? 'agent' : c.companyType === 'usine' ? 'usine' : 'autre';
    if (c.company && type === 'usine') {
      base.factory = factoryFrom({ name: c.company, address: c.address, city: c.city, website: c.website, phone: '', email: '', wechat: '' } as InvoiceData['supplier']);
      base.contacts.push({ id: newId(), ownerType: 'factory', name: s(c.name), role: s(c.role), email: s(c.email), phone: s(c.phone), wechat: s(c.wechat), whatsapp: s(c.whatsapp) });
    } else if (c.company) {
      const existing = findPartner(db, c.company);
      base.partner = { existingId: existing?.id ?? null, draft: { id: existing?.id ?? newId(), type: type === 'agent' ? 'agent' : 'transporteur', name: s(c.company), city: s(c.city), email: '', phone: '', wechat: '', services: '', notes: s(c.website), insights: { summary: '', actions: [], analyzedAt: '' } } };
      base.contacts.push({ id: newId(), ownerType: 'partner', name: s(c.name), role: s(c.role), email: s(c.email), phone: s(c.phone), wechat: s(c.wechat), whatsapp: s(c.whatsapp) });
    }
  }
  return base;
}

/** Commande existante qui ressemble au document lu (même commande vue via sa proforma, sa facture, sa packing list…). */
export interface OrderMatch { order: Order; score: number; reasons: string[] }

const ORDER_RANK: Record<Order['status'], number> = { devis: 0, pi_recue: 1, acompte_paye: 2, en_production: 3, prete: 4, expediee: 5, livree: 6 };
const close = (a: number, b: number, tol = 0.015) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) <= tol;

/** Cherche, chez la même usine, les commandes qui correspondent au document (référence, montant, lignes). */
export function findMatchingOrders(db: Database, p: Proposal): OrderMatch[] {
  const factoryId = p.factory?.existingId;
  if (!factoryId || (!p.order && p.kind !== 'packing_list')) return [];
  const ref = norm(p.order?.reference ?? '');
  const docTotal = p.products.reduce((t, l) => t + l.qty * l.unitPrice, 0);
  const docQty = p.products.reduce((t, l) => t + l.qty, 0);
  const out: OrderMatch[] = [];
  for (const o of db.orders) {
    if (o.factoryId !== factoryId) continue;
    let score = 0; const reasons: string[] = [];
    if (ref && norm(o.reference) === ref) { score += 3; reasons.push(`même référence ${o.reference}`); }
    const oTotal = o.lines.reduce((t, l) => t + l.qty * l.unitPrice, 0);
    if (docTotal > 0 && close(docTotal, oTotal)) { score += 2; reasons.push('même montant total'); }
    const oQty = o.lines.reduce((t, l) => t + l.qty, 0);
    if (p.products.length && o.lines.length) {
      const matched = p.products.filter((l) => o.lines.some((ol) => ol.qty === l.qty && (l.unitPrice <= 0 || close(ol.unitPrice, l.unitPrice)))).length;
      const ratio = matched / Math.max(p.products.length, o.lines.length);
      if (ratio >= 0.5) { score += ratio >= 0.99 ? 2 : 1; reasons.push(ratio >= 0.99 ? 'mêmes lignes (quantités et prix)' : 'plusieurs lignes identiques'); }
      else if (docQty > 0 && docQty === oQty && p.products.length === o.lines.length) { score += 1; reasons.push('mêmes quantités'); }
    }
    if (p.order?.date && o.date) {
      const days = Math.abs((new Date(p.order.date).getTime() - new Date(o.date).getTime()) / 86400000);
      if (days <= 45) { score += 0.5; reasons.push(days < 1 ? 'même date' : `à ${Math.round(days)} j d'écart`); }
    }
    if (score >= 2) out.push({ order: o, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Associe les lignes du document aux références d'une commande existante (quantité + prix, puis libellé). */
export function mapLinesToOrder(db: Database, p: Proposal, order: Order): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<number>();
  for (const l of p.products) {
    let idx = order.lines.findIndex((ol, i) => !used.has(i) && ol.qty === l.qty && (l.unitPrice <= 0 || close(ol.unitPrice, l.unitPrice)));
    if (idx < 0) {
      let best = 0;
      order.lines.forEach((ol, i) => {
        if (used.has(i)) return;
        const prod = db.products.find((x) => x.id === ol.productId);
        const sc = prod ? Math.max(productSimilarity(prod.name, l.label), prod.supplierName ? productSimilarity(prod.supplierName, l.supplierLabel || l.label) : 0) : 0;
        if (sc > best) { best = sc; idx = i; }
      });
      if (best < 0.5) idx = -1;
    }
    if (idx >= 0) { used.add(idx); map[l.key] = order.lines[idx].productId; }
  }
  return map;
}

const nk = (x: string | undefined | null) => (x ?? '').toLowerCase().replace(/[\s\-_./]/g, '');
const SHIP_RANK: Record<Shipment['status'], number> = { planifiee: 0, collectee: 1, en_transit: 2, dedouanement: 3, livree: 4 };
/** Expédition existante qui correspond au document (même n° de conteneur / B/L, sinon même transporteur + même trajet). */
export function findMatchingShipment(db: Database, p: Proposal): Shipment | undefined {
  if (!p.shipment) return undefined;
  const key = nk(p.shipment.trackingRef);
  if (key.length >= 6) { const hit = db.shipments.find((s) => nk(s.trackingRef) === key || nk(s.notes).includes(key) || nk(s.reference).includes(key)); if (hit) return hit; }
  const partnerId = p.partner?.existingId;
  if (partnerId) { const same = db.shipments.filter((s) => s.partnerId === partnerId && s.status !== 'livree'); if (same.length === 1) return same[0]; }
  return undefined;
}
/** Complète une expédition existante avec ce que dit le document : champs vides remplis, statut qui avance, coûts pris si absents. */
export function mergeShipmentFromDoc(existing: Shipment, fromDoc: NonNullable<Proposal['shipment']>, partnerId: string | null): Shipment {
  const pick = <T,>(a: T, b: T, empty: T) => (a !== empty ? a : b);
  const hasCosts = existing.freightCost || existing.insuranceCost || existing.originFees || existing.destinationFees;
  return {
    ...existing,
    partnerId: existing.partnerId ?? partnerId,
    status: SHIP_RANK[fromDoc.status] > SHIP_RANK[existing.status] ? fromDoc.status : existing.status,
    etd: pick(existing.etd, fromDoc.etd, ''), eta: fromDoc.eta || existing.eta,
    cbm: pick(existing.cbm, fromDoc.cbm, 0), weightKg: pick(existing.weightKg, fromDoc.weightKg, 0),
    freightCost: hasCosts ? existing.freightCost : fromDoc.freightCost, insuranceCost: hasCosts ? existing.insuranceCost : fromDoc.insuranceCost,
    originFees: hasCosts ? existing.originFees : fromDoc.originFees, destinationFees: hasCosts ? existing.destinationFees : fromDoc.destinationFees,
    currency: hasCosts ? existing.currency : fromDoc.currency,
    trackingRef: pick(existing.trackingRef, fromDoc.trackingRef, ''),
    documentId: existing.documentId ?? fromDoc.documentId,
    notes: fromDoc.notes && !existing.notes.includes(fromDoc.notes) ? [existing.notes, fromDoc.notes].filter(Boolean).join(' ') : existing.notes,
  };
}

export function mergeOrderStatus(a: Order['status'], b: Order['status']): Order['status'] {
  return ORDER_RANK[a] >= ORDER_RANK[b] ? a : b;
}

export interface Choices {
  /** Projet / conteneur : id existant, '' pour aucun, ou 'new' (voir newProjectName). */
  projectId: string;
  newProjectName: string;
  /** Commande existante à laquelle rattacher le document ('' = créer une nouvelle commande). */
  orderId: string;
  /** Expédition existante à compléter avec ce document ('' = créer une nouvelle expédition). */
  shipmentId: string;
  /** Dossier dans lequel ranger les nouvelles références. */
  folderId: string;
  /** clé de produit proposé → id de produit existant, ou 'new', ou 'skip'. */
  productMap: Record<string, string>;
  /** Pour les lignes créées : nom interne, référence interne et dossier choisis par l'utilisateur. */
  newProducts: Record<string, { name: string; sku: string; folderId: string | null }>;
  drawingProductId: string;
  saveFactory: boolean;
  savePartner: boolean;
  saveContacts: boolean;
  saveQuotes: boolean;
  saveOrder: boolean;
  saveShipment: boolean;
  saveDrawing: boolean;
  savePacking: boolean;
}

/** Propose une référence interne à partir du nom (préfixe + initiales), unique dans le catalogue. */
export function suggestSku(db: Database, name: string): string {
  const words = norm(name).split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w));
  const letters = words.slice(0, 3).map((w) => w.slice(0, 3).toUpperCase()).join('-');
  const dims = (name.match(/\d{3,4}/g) ?? []).slice(0, 2).join('x');
  const base = [letters || 'REF', dims].filter(Boolean).join('-');
  let sku = base; let i = 2;
  while (db.products.some((p) => p.sku && norm(p.sku) === norm(sku))) sku = `${base}-${i++}`;
  return sku;
}

export function defaultChoices(p: Proposal, db: Database, projectId: string): Choices {
  const productMap: Record<string, string> = {};
  const newProducts: Choices['newProducts'] = {};
  const folderId = '';
  const match = findMatchingOrders(db, p)[0];
  const fromOrder = match ? mapLinesToOrder(db, p, match.order) : {};
  for (const pp of p.products) {
    productMap[pp.key] = pp.isService ? 'service' : fromOrder[pp.key] ?? findProduct(db, projectId, pp.label, pp.details?.sku, pp.supplierLabel)?.id ?? 'new';
    newProducts[pp.key] = { name: pp.label.slice(0, 80), sku: suggestSku(db, pp.label), folderId: null };
  }
  const openProjects = db.projects.filter((x) => x.status !== 'archive' && x.status !== 'vente');
  const defaultProject = match?.order.projectId || projectId || (openProjects.length === 1 ? openProjects[0].id : '');
  return {
    projectId: defaultProject, newProjectName: '', orderId: match?.order.id ?? '', shipmentId: p.shipment ? (findMatchingShipment(db, p)?.id ?? '') : '', folderId, productMap, newProducts, drawingProductId: '',
    saveFactory: !!p.factory, savePartner: !!p.partner, saveContacts: p.contacts.length > 0, saveQuotes: p.quotes,
    saveOrder: !!p.order, saveShipment: !!p.shipment, saveDrawing: !!p.drawing, savePacking: p.products.some((x) => x.packing),
  };
}

/** Applique la proposition à la base et renvoie la nouvelle base + le document mis à jour. */
export function applyProposal(db: Database, doc: DocumentRecord, result: ExtractionResult, p: Proposal, c: Choices): Database {
  const next: Database = { ...db, projects: [...db.projects], factories: [...db.factories], partners: [...db.partners], contacts: [...db.contacts], products: [...db.products], quotes: [...db.quotes], orders: [...db.orders], shipments: [...db.shipments], drawings: [...db.drawings], documents: [...db.documents] };
  const linked: DocumentRecord['linkedTo'] = [];
  let projectId = c.projectId;
  if (projectId === 'new') {
    projectId = c.newProjectName.trim() ? newId() : '';
    if (projectId) next.projects.push({ id: projectId, name: c.newProjectName.trim(), description: '', status: 'sourcing', targetDate: '', container: '', notes: '', flows: [], layout: {}, contents: [], consolidatorFactoryId: null, docLinks: [], negotiations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  c = { ...c, projectId };
  if (projectId) linked.push({ type: 'project', id: projectId });

  let factoryId: string | null = null;
  if (p.factory && c.saveFactory) {
    factoryId = p.factory.draft.id;
    const idx = next.factories.findIndex((f) => f.id === factoryId);
    if (idx >= 0) {
      const old = next.factories[idx];
      next.factories[idx] = { ...old, city: old.city || p.factory.draft.city, province: old.province || p.factory.draft.province, address: old.address || p.factory.draft.address, email: old.email || p.factory.draft.email, phone: old.phone || p.factory.draft.phone, wechat: old.wechat || p.factory.draft.wechat, website: old.website || p.factory.draft.website, specialties: old.specialties || p.factory.draft.specialties };
    } else next.factories.push(p.factory.draft);
    linked.push({ type: 'factory', id: factoryId });
  } else if (p.factory?.existingId) factoryId = p.factory.existingId;

  let partnerId: string | null = null;
  if (p.partner && c.savePartner) {
    partnerId = p.partner.draft.id;
    if (!next.partners.some((x) => x.id === partnerId)) next.partners.push(p.partner.draft);
    linked.push({ type: 'partner', id: partnerId });
  }

  if (c.saveContacts) {
    for (const ct of p.contacts) {
      const ownerId = ct.ownerType === 'factory' ? factoryId : partnerId;
      if (!ownerId) continue;
      const dup = next.contacts.some((x) => x.ownerId === ownerId && norm(x.name) === norm(ct.name));
      if (!dup) next.contacts.push({ ...ct, ownerId });
    }
  }

  const productIds: Record<string, string> = {};
  /** Lignes de prestation (confection, assemblage…) : gardées sur la commande, éventuellement ajoutées au coût d'une référence. */
  const serviceLines: Order['lines'] = [];
  for (const pp of p.products) {
    const choice = c.productMap[pp.key] ?? 'new';
    if (choice === 'skip') continue;
    if (choice === 'service' || choice.startsWith('service:')) {
      const target = choice.startsWith('service:') ? choice.slice('service:'.length) : '';
      serviceLines.push({ productId: target, qty: pp.qty, unitPrice: pp.unitPrice, currency: p.currency, label: pp.label, isService: true });
      if (target) {
        const idx = next.products.findIndex((x) => x.id === target);
        if (idx >= 0) {
          const prod = next.products[idx];
          const amountEur = toEur(pp.unitPrice, p.currency, db.settings);
          const amount = pp.unitPrice, currency = p.currency;
          const label = pp.label.slice(0, 60);
          const existingCost = prod.extraCosts.find((x) => norm(x.label) === norm(label));
          const extraCosts = existingCost ? prod.extraCosts.map((x) => (x === existingCost ? { ...x, amount, currency, amountEur, note: `Facture ${p.order?.reference ?? doc.fileName}` } : x)) : [...prod.extraCosts, { id: newId(), label, amount, currency, amountEur, note: `Facture ${p.order?.reference ?? doc.fileName} — ${pp.qty} × ${pp.unitPrice} ${p.currency}` }];
          next.products[idx] = { ...prod, extraCosts };
          linked.push({ type: 'product', id: target });
        }
      }
      continue;
    }
    let id = choice;
    if (choice.startsWith('newversion:')) {
      // Nouvelle version d'une famille existante, à partir de sa version actuelle.
      const baseId = choice.slice('newversion:'.length);
      const base = next.products.find((x) => x.id === baseId);
      if (base) {
        const fam = base.familyId || base.id;
        const num = (v: string) => Number((v.match(/\d+/) ?? ['0'])[0]) || 0;
        const ver = `V${Math.max(0, ...next.products.filter((x) => (x.familyId || x.id) === fam).map((x) => num(x.version))) + 1}`;
        id = newId();
        next.products = next.products.map((x) => ((x.familyId || x.id) === fam ? { ...x, isCurrentVersion: false } : x));
        next.products.push({
          ...base, id, familyId: fam, version: ver, versionDate: p.order?.date ?? today(), isCurrentVersion: true,
          versionNotes: c.newProducts?.[pp.key]?.name && c.newProducts[pp.key].name !== base.name ? c.newProducts[pp.key].name : `Depuis ${doc.fileName}${factoryId && factoryId !== base.factoryId ? ` — nouvelle usine` : ''}`,
          factoryId: factoryId ?? base.factoryId, supplierName: pp.supplierLabel || base.supplierName,
          description: pp.details.description || base.description, hsCode: base.hsCode || pp.hsCode,
          components: base.components.map((x) => ({ ...x })), extraCosts: base.extraCosts.map((x) => ({ ...x, id: newId() })),
          ...(c.savePacking && pp.packing ? { unitsPerCarton: pp.packing.unitsPerCarton || base.unitsPerCarton, cartonCbm: pp.packing.cartonCbm || base.cartonCbm, unitWeightKg: pp.packing.unitWeightKg || base.unitWeightKg } : {}),
        });
        productIds[pp.key] = id;
        linked.push({ type: 'product', id });
        continue;
      }
    }
    if (choice === 'new') {
      id = newId();
      const np = c.newProducts?.[pp.key];
      next.products.push({
        id, projectId: c.projectId || null, folderId: np?.folderId ?? (c.folderId || null), name: (np?.name || pp.label).slice(0, 80), familyId: id, version: 'V1', versionDate: p.order?.date ?? today(), versionNotes: `Créée depuis ${doc.fileName}`, isCurrentVersion: true, supplierName: pp.supplierLabel, sku: np?.sku ?? pp.details.sku, description: pp.details.description, factoryId, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0,
        hsCode: pp.hsCode, dutyRatePct: pp.details.dutyRatePct ?? db.settings.defaultDutyRatePct,
        unitWeightKg: pp.packing?.unitWeightKg || pp.details.unitWeightKg || 0, unitsPerCarton: pp.packing?.unitsPerCarton ?? 0, cartonCbm: pp.packing?.cartonCbm ?? 0,
        notes: `Créée depuis ${doc.fileName}`,
      });
    } else {
      const idx = next.products.findIndex((x) => x.id === id);
      if (idx >= 0) {
        const cur = next.products[idx];
        next.products[idx] = {
          ...cur,
          factoryId: cur.factoryId ?? factoryId,
          hsCode: cur.hsCode || pp.hsCode,
          sku: cur.sku || pp.details.sku,
          supplierName: cur.supplierName || pp.supplierLabel,
          description: cur.description || pp.details.description,
          unitWeightKg: cur.unitWeightKg || pp.details.unitWeightKg || 0,
          ...(c.savePacking && pp.packing ? { unitsPerCarton: pp.packing.unitsPerCarton || cur.unitsPerCarton, cartonCbm: pp.packing.cartonCbm || cur.cartonCbm, unitWeightKg: pp.packing.unitWeightKg || cur.unitWeightKg } : {}),
        };
      }
    }
    productIds[pp.key] = id;
    linked.push({ type: 'product', id });
  }

  if (c.saveQuotes && factoryId) {
    for (const pp of p.products) {
      const productId = productIds[pp.key];
      if (!productId || pp.unitPrice <= 0) continue;
      next.quotes.push({ id: newId(), productId, factoryId, date: p.order?.date ?? today(), unitPrice: pp.unitPrice, currency: p.currency, moq: pp.qty, incoterm: asIncoterm(p.order?.notes ?? ''), leadTimeDays: p.order?.productionDays ?? 0, documentId: doc.id, notes: `Extrait de ${doc.fileName}` });
    }
  }

  if (p.order && c.saveOrder && factoryId) {
    const lines: Order['lines'] = [...p.products.filter((pp) => productIds[pp.key]).map((pp) => ({ productId: productIds[pp.key], qty: pp.qty, unitPrice: pp.unitPrice, currency: p.currency })), ...serviceLines];
    const existing = (c.orderId && next.orders.find((o) => o.id === c.orderId)) || next.orders.find((o) => o.factoryId === factoryId && o.reference && p.order!.reference && norm(o.reference) === norm(p.order!.reference));
    if (existing) {
      // Même commande vue par un autre document (proforma puis facture, par ex.) : on fusionne.
      const idx = next.orders.indexOf(existing);
      const isInvoice = result.kind === 'facture';
      const refNote = existing.reference && p.order.reference && norm(existing.reference) !== norm(p.order.reference) ? `${isInvoice ? 'PI' : 'Facture'} n° ${isInvoice ? existing.reference : p.order.reference}.` : '';
      next.orders[idx] = {
        ...existing,
        projectId: c.projectId || existing.projectId,
        reference: isInvoice && p.order.reference ? p.order.reference : existing.reference || p.order.reference,
        date: existing.date && existing.date < p.order.date ? existing.date : p.order.date || existing.date,
        status: mergeOrderStatus(existing.status, p.order.status),
        depositPaid: existing.depositPaid || p.order.depositPaid,
        productionDays: existing.productionDays || p.order.productionDays,
        lines: isInvoice && lines.length ? lines : existing.lines.length ? existing.lines : lines,
        invoiceDocumentId: isInvoice ? doc.id : existing.invoiceDocumentId,
        proformaDocumentId: result.kind === 'proforma' ? doc.id : existing.proformaDocumentId,
        packingListDocumentId: p.order.packingListDocumentId ?? existing.packingListDocumentId,
        notes: [existing.notes, refNote, existing.notes.includes(p.order.notes) ? '' : p.order.notes].filter(Boolean).join(' '),
      };
      linked.push({ type: 'order', id: existing.id });
    } else {
      const id = newId();
      next.orders.push({ ...p.order, id, projectId: c.projectId || '', factoryId, lines, proformaDocumentId: result.kind === 'proforma' ? doc.id : null, invoiceDocumentId: result.kind === 'facture' ? doc.id : null });
      linked.push({ type: 'order', id });
    }
  } else if (result.kind === 'packing_list' && c.orderId) {
    const idx = next.orders.findIndex((o) => o.id === c.orderId);
    if (idx >= 0) {
      next.orders[idx] = { ...next.orders[idx], packingListDocumentId: doc.id, projectId: c.projectId || next.orders[idx].projectId, status: mergeOrderStatus(next.orders[idx].status, 'prete') };
      linked.push({ type: 'order', id: c.orderId });
    }
  }

  if (p.shipment && c.saveShipment) {
    const idx = c.shipmentId ? next.shipments.findIndex((x) => x.id === c.shipmentId) : -1;
    if (idx >= 0) {
      next.shipments[idx] = mergeShipmentFromDoc(next.shipments[idx], p.shipment, partnerId);
      linked.push({ type: 'shipment', id: next.shipments[idx].id });
    } else {
      const id = newId();
      next.shipments.push({ ...p.shipment, id, partnerId, agentId: null, orderIds: [] });
      linked.push({ type: 'shipment', id });
    }
  }

  if (p.drawing && c.saveDrawing && c.drawingProductId) {
    const versions = next.drawings.filter((x) => x.productId === c.drawingProductId).length;
    const id = newId();
    next.drawings.push({ ...p.drawing, id, productId: c.drawingProductId, documentId: doc.id, version: p.drawing.version || `V${versions + 1}` });
    linked.push({ type: 'drawing', id });
  }

  const di = next.documents.findIndex((x) => x.id === doc.id);
  const updated: DocumentRecord = { ...doc, kind: result.kind, extracted: result.data, summary: result.summary, linkedTo: linked };
  if (di >= 0) next.documents[di] = updated; else next.documents.push(updated);
  return next;
}
