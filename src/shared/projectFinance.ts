/**
 * Analyse financière d'une importation : pour chaque marchandise de la liste de courses (ce qui arrive en France),
 * coût d'achat (prix payés si commandé, sinon prix connus / compositions), transport réparti au prorata du volume,
 * droits de douane, prix de vente (marché FR) et bénéfice avec / sans transport.
 */
import type { Database, Project } from './types';
import { computeMargin, formatEur, fromEur, lineCbm, shipmentTotalEur, toEur } from './finance';
import { canonicalProductId, explodeNeeds, factoryLinePrice, includedInParentPrice } from './importFlows';

export interface ProjectFinanceLine {
  productId: string;
  name: string;
  qty: number;
  /** Coût d'achat unitaire (marchandise + sous-références achetées ailleurs), EUR. */
  goodsUnitEur: number;
  goodsEur: number;
  /** Part de transport, EUR (répartie au volume, sinon à la valeur). */
  transportEur: number;
  transportUnitEur: number;
  shareBasis: 'volume' | 'valeur' | 'aucune';
  cbm: number;
  dutyEur: number;
  /** Prix de vente TTC et HT unitaires (EUR) et revenu net HT unitaire (après commission et livraison client). */
  sellTtcEur: number | null;
  sellHtEur: number | null;
  netUnitEur: number | null;
  revenueEur: number;
  profitNoTransportEur: number | null;
  profitEur: number | null;
  marginPct: number | null;
  /** Détail lisible du coût d'achat. */
  costDetail: string;
  hasPrice: boolean;
}

export interface ProjectFinance {
  lines: ProjectFinanceLine[];
  goodsEur: number;
  transportEur: number;
  dutyEur: number;
  costEur: number;
  revenueEur: number;
  profitNoTransportEur: number;
  profitEur: number;
  marginPct: number | null;
  /** Marchandises sans prix de vente FR. */
  missingPrices: { productId: string; name: string }[];
  /** Marchandises sans coût d'achat connu. */
  missingCosts: { productId: string; name: string }[];
  totalCbm: number;
  shipments: number;
}

/** Prix réellement payés dans les commandes de l'importation, par (usine, produit), en EUR. */
function paidPrices(db: Database, projectId: string): Map<string, number> {
  const acc = new Map<string, { qty: number; eur: number }>();
  for (const o of db.orders.filter((o) => o.projectId === projectId)) for (const l of o.lines) {
    if (!l.productId || l.isService || !(l.qty > 0)) continue;
    const key = `${o.factoryId}|${canonicalProductId(db, l.productId)}`;
    const cur = acc.get(key) ?? { qty: 0, eur: 0 };
    const unit = toEur(l.unitPrice, l.currency, db.settings);
    cur.eur = (cur.eur * cur.qty + unit * l.qty) / (cur.qty + l.qty); cur.qty += l.qty;
    acc.set(key, cur);
  }
  return new Map([...acc.entries()].map(([k, v]) => [k, v.eur]));
}

/** Coût d'achat total (EUR) d'une quantité d'un produit fini : toutes ses sous-références chez chaque usine, sans double compte. */
export function goodsCostEur(db: Database, projectId: string, productId: string, qty: number): { eur: number; detail: string; complete: boolean } {
  const paid = paidPrices(db, projectId);
  const needs = explodeNeeds(db, [{ productId, qty }]);
  let eur = 0; let complete = true; const parts: string[] = [];
  for (const n of needs) {
    if (includedInParentPrice(db, n)) continue;
    if (!n.factoryId) { if (!needs.some((x) => x.parentId === n.productId)) complete = false; continue; }
    const p = db.products.find((x) => x.id === n.productId);
    const paidUnit = paid.get(`${n.factoryId}|${n.productId}`);
    const price = paidUnit != null ? { eur: paidUnit, src: 'payé' } : (() => { const fp = factoryLinePrice(db, n.productId, n.factoryId); return fp ? { eur: fp.eur, src: fp.source === 'composition' ? 'composé' : 'dernier prix' } : null; })();
    if (!price) { complete = false; parts.push(`${p?.name ?? '?'} : prix inconnu`); continue; }
    eur += price.eur * n.qty;
    parts.push(`${p?.name ?? '?'} ${n.qty} × ${formatEur(price.eur)} (${price.src})`);
  }
  return { eur, detail: parts.join(' · '), complete };
}

export function projectFinance(db: Database, project: Project): ProjectFinance {
  const orderIds = new Set(db.orders.filter((o) => o.projectId === project.id).map((o) => o.id));
  const ships = db.shipments.filter((s) => s.projectId === project.id || s.orderIds.some((id) => orderIds.has(id)));
  const transportTotal = ships.reduce((t, s) => t + shipmentTotalEur(s, db.settings), 0);
  const contents = project.contents.filter((l) => l.productId && l.qty > 0);
  const base = contents.map((l) => {
    const product = db.products.find((p) => p.id === l.productId);
    const cost = goodsCostEur(db, project.id, l.productId, l.qty);
    return { l, product, cost, cbm: lineCbm(product, l.qty) };
  });
  const totalCbm = base.reduce((t, b) => t + b.cbm, 0);
  const totalValue = base.reduce((t, b) => t + b.cost.eur, 0);
  const lines: ProjectFinanceLine[] = base.map(({ l, product, cost, cbm }) => {
    let share = 0; let shareBasis: ProjectFinanceLine['shareBasis'] = 'aucune';
    if (totalCbm > 0 && cbm > 0) { share = cbm / totalCbm; shareBasis = 'volume'; }
    else if (totalValue > 0 && cost.eur > 0) { share = cost.eur / totalValue; shareBasis = 'valeur'; }
    const transportEur = transportTotal * share;
    const goodsUnitEur = l.qty > 0 ? cost.eur / l.qty : 0;
    const dutyRate = product?.dutyRatePct ?? db.settings.defaultDutyRatePct;
    const dutyEur = (cost.eur + transportEur) * (dutyRate / 100);
    const mp = db.marketPrices.filter((m) => m.productId === l.productId && m.market === 'FR').sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    const landedUnit = l.qty > 0 ? (cost.eur + transportEur + dutyEur) / l.qty : 0;
    const m = mp ? computeMargin(landedUnit, mp, db.settings) : null;
    const netUnit = m ? m.netRevenueEur : null;
    const revenue = netUnit != null ? netUnit * l.qty : 0;
    const dutyNoTransport = cost.eur * (dutyRate / 100);
    return {
      productId: l.productId, name: product?.name ?? l.productId, qty: l.qty,
      goodsUnitEur, goodsEur: cost.eur, transportEur, transportUnitEur: l.qty > 0 ? transportEur / l.qty : 0, shareBasis, cbm, dutyEur,
      sellTtcEur: m ? m.sellPriceTtcEur : null, sellHtEur: m ? m.sellPriceHtEur : null, netUnitEur: netUnit, revenueEur: revenue,
      profitNoTransportEur: netUnit != null ? revenue - cost.eur - dutyNoTransport : null,
      profitEur: netUnit != null ? revenue - cost.eur - transportEur - dutyEur : null,
      marginPct: m && m.sellPriceHtEur > 0 ? ((revenue - cost.eur - transportEur - dutyEur) / (m.sellPriceHtEur * l.qty)) * 100 : null,
      costDetail: cost.detail, hasPrice: !!mp,
    };
  });
  const goodsEur = lines.reduce((t, x) => t + x.goodsEur, 0);
  const transportEur = lines.reduce((t, x) => t + x.transportEur, 0);
  const dutyEur = lines.reduce((t, x) => t + x.dutyEur, 0);
  const priced = lines.filter((x) => x.hasPrice);
  const revenueEur = priced.reduce((t, x) => t + x.revenueEur, 0);
  const profitNoTransportEur = priced.reduce((t, x) => t + (x.profitNoTransportEur ?? 0), 0);
  const profitEur = priced.reduce((t, x) => t + (x.profitEur ?? 0), 0);
  const htTotal = priced.reduce((t, x) => t + (x.netUnitEur != null ? x.revenueEur : 0), 0);
  return {
    lines, goodsEur, transportEur, dutyEur, costEur: goodsEur + transportEur + dutyEur,
    revenueEur, profitNoTransportEur, profitEur,
    marginPct: htTotal > 0 ? (profitEur / htTotal) * 100 : null,
    missingPrices: lines.filter((x) => !x.hasPrice).map((x) => ({ productId: x.productId, name: x.name })),
    missingCosts: base.filter((b) => !b.cost.complete).map((b) => ({ productId: b.l.productId, name: b.product?.name ?? b.l.productId })),
    totalCbm, shipments: ships.length,
  };
}

/** Prix de vente HT minimum (EUR) pour une marge cible sur une ligne, à partir de son coût de revient complet. */
export function sellPriceHtForMargin(line: ProjectFinanceLine, targetPct: number, db: Database): number {
  const mp = db.marketPrices.find((m) => m.productId === line.productId && m.market === 'FR');
  const fee = mp?.platformFeePct ?? 0; const lastMile = mp ? toEur(mp.lastMileCost, mp.currency, db.settings) : 0;
  const landed = line.qty > 0 ? (line.goodsEur + line.transportEur + line.dutyEur) / line.qty : 0;
  const denom = 1 - fee / 100 - targetPct / 100;
  return denom <= 0 ? 0 : (landed + lastMile) / denom;
}

/** Prix de vente TTC minimum (EUR) pour une marge cible sur une ligne, à partir de son coût de revient complet. */
export function sellPriceForMargin(line: ProjectFinanceLine, targetPct: number, db: Database): number {
  const mp = db.marketPrices.find((m) => m.productId === line.productId && m.market === 'FR');
  const vat = mp?.vatPct ?? db.settings.defaultVat.FR; const fee = mp?.platformFeePct ?? 0; const lastMile = mp ? toEur(mp.lastMileCost, mp.currency, db.settings) : 0;
  const landed = line.qty > 0 ? (line.goodsEur + line.transportEur + line.dutyEur) / line.qty : 0;
  const denom = 1 - fee / 100 - targetPct / 100;
  if (denom <= 0) return 0;
  return fromEur((landed + lastMile) / denom * (1 + vat / 100), 'EUR', db.settings);
}
