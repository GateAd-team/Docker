/**
 * Calculs financiers de Bao : conversion de devises, coût de revient (landed cost),
 * droits de douane, marges par marché. Fonctions pures, testées dans test/finance.test.ts.
 */
import type {
  Currency, Market, MarketPrice, Order, OrderLine, Product, Quote, Settings, Shipment,
} from './types';

export function toEur(amount: number, currency: Currency, settings: Settings): number {
  const rate = settings.fxToEur[currency] ?? 1;
  return amount * rate;
}

/** Montant en EUR d'un coût additionnel (saisi dans sa devise). */
export function extraCostEur(x: { amount?: number; currency?: Currency; amountEur?: number }, settings: Settings): number {
  return x.currency ? toEur(x.amount ?? 0, x.currency, settings) : x.amountEur ?? 0;
}

export function fromEur(amountEur: number, currency: Currency, settings: Settings): number {
  const rate = settings.fxToEur[currency] ?? 1;
  return rate === 0 ? 0 : amountEur / rate;
}

/** Volume total (m³) occupé par une ligne de commande. */
export function lineCbm(product: Product | undefined, qty: number): number {
  if (!product || product.unitsPerCarton <= 0 || product.cartonCbm <= 0) return 0;
  return (qty / product.unitsPerCarton) * product.cartonCbm;
}

export interface LandedCostBreakdown {
  productId: string;
  qty: number;
  /** Part de l'expédition attribuée à cette ligne (0-1). */
  share: number;
  shareBasis: 'volume' | 'valeur' | 'aucune';
  goodsUnitEur: number;
  freightUnitEur: number;
  insuranceUnitEur: number;
  originFeesUnitEur: number;
  destinationFeesUnitEur: number;
  /** Valeur en douane (CIF) : marchandise + fret + assurance. */
  customsValueUnitEur: number;
  dutyRatePct: number;
  dutyUnitEur: number;
  /** TVA à l'import, donnée à titre indicatif (récupérable pour une société). */
  importVatUnitEur: number;
  /** Coût de revient unitaire hors TVA. */
  landedUnitEur: number;
  landedTotalEur: number;
}

export interface ShipmentContext {
  shipment: Shipment;
  /** Toutes les lignes de toutes les commandes de l'expédition, pour calculer la part. */
  lines: { line: OrderLine; product: Product | undefined }[];
}

/**
 * Coût de revient d'une ligne de commande.
 * La logistique est répartie au prorata du volume si on le connaît, sinon de la valeur.
 */
export function computeLandedCost(
  product: Product | undefined,
  line: OrderLine,
  ctx: ShipmentContext | null,
  settings: Settings,
  importVatPct = settings.defaultVat.FR,
): LandedCostBreakdown {
  const qty = Math.max(line.qty, 0);
  const goodsUnitEur = toEur(line.unitPrice, line.currency, settings);
  const dutyRatePct = product?.dutyRatePct ?? settings.defaultDutyRatePct;

  let share = 0;
  let shareBasis: LandedCostBreakdown['shareBasis'] = 'aucune';
  let freightUnitEur = 0, insuranceUnitEur = 0, originFeesUnitEur = 0, destinationFeesUnitEur = 0;

  if (ctx && qty > 0) {
    const totalCbm = ctx.lines.reduce((s, l) => s + lineCbm(l.product, l.line.qty), 0);
    const myCbm = lineCbm(product, qty);
    if (totalCbm > 0 && myCbm > 0) {
      share = myCbm / totalCbm; shareBasis = 'volume';
    } else {
      const totalValue = ctx.lines.reduce((s, l) => s + toEur(l.line.unitPrice, l.line.currency, settings) * l.line.qty, 0);
      const myValue = goodsUnitEur * qty;
      if (totalValue > 0) { share = myValue / totalValue; shareBasis = 'valeur'; }
    }
    const c = ctx.shipment.currency;
    freightUnitEur = (toEur(ctx.shipment.freightCost, c, settings) * share) / qty;
    insuranceUnitEur = (toEur(ctx.shipment.insuranceCost, c, settings) * share) / qty;
    originFeesUnitEur = (toEur(ctx.shipment.originFees, c, settings) * share) / qty;
    destinationFeesUnitEur = (toEur(ctx.shipment.destinationFees, c, settings) * share) / qty;
  }

  const customsValueUnitEur = goodsUnitEur + freightUnitEur + insuranceUnitEur + originFeesUnitEur;
  const dutyUnitEur = customsValueUnitEur * (dutyRatePct / 100);
  const importVatUnitEur = (customsValueUnitEur + dutyUnitEur) * (importVatPct / 100);
  const landedUnitEur = customsValueUnitEur + dutyUnitEur + destinationFeesUnitEur;

  return {
    productId: line.productId, qty, share, shareBasis,
    goodsUnitEur, freightUnitEur, insuranceUnitEur, originFeesUnitEur, destinationFeesUnitEur,
    customsValueUnitEur, dutyRatePct, dutyUnitEur, importVatUnitEur,
    landedUnitEur, landedTotalEur: landedUnitEur * qty,
  };
}

export interface MarginResult {
  market: Market;
  sellPriceTtcEur: number;
  sellPriceHtEur: number;
  platformFeeEur: number;
  lastMileEur: number;
  netRevenueEur: number;
  landedUnitEur: number;
  marginEur: number;
  /** Marge nette / prix HT. */
  marginPct: number;
  /** Prix HT / coût de revient. */
  coefficient: number;
}

export function computeMargin(landedUnitEur: number, mp: MarketPrice, settings: Settings): MarginResult {
  const sellPriceTtcEur = toEur(mp.sellPrice, mp.currency, settings);
  const sellPriceHtEur = sellPriceTtcEur / (1 + mp.vatPct / 100);
  const platformFeeEur = sellPriceHtEur * (mp.platformFeePct / 100);
  const lastMileEur = toEur(mp.lastMileCost, mp.currency, settings);
  const netRevenueEur = sellPriceHtEur - platformFeeEur - lastMileEur;
  const marginEur = netRevenueEur - landedUnitEur;
  return {
    market: mp.market, sellPriceTtcEur, sellPriceHtEur, platformFeeEur, lastMileEur, netRevenueEur,
    landedUnitEur, marginEur,
    marginPct: sellPriceHtEur > 0 ? (marginEur / sellPriceHtEur) * 100 : 0,
    coefficient: landedUnitEur > 0 ? sellPriceHtEur / landedUnitEur : 0,
  };
}

/** Prix de vente TTC minimum pour atteindre une marge cible (% du prix HT). */
export function priceForTargetMargin(landedUnitEur: number, targetMarginPct: number, mp: Pick<MarketPrice, 'vatPct' | 'platformFeePct' | 'lastMileCost' | 'currency'>, settings: Settings): number {
  // HT × (1 − fee − target) = landed + lastMile
  const denom = 1 - mp.platformFeePct / 100 - targetMarginPct / 100;
  if (denom <= 0) return 0;
  const ht = (landedUnitEur + toEur(mp.lastMileCost, mp.currency, settings)) / denom;
  return fromEur(ht * (1 + mp.vatPct / 100), mp.currency, settings);
}

/** Historique des prix d'un produit, converti en EUR et trié par date. */
export function priceHistory(quotes: Quote[], productId: string, settings: Settings) {
  return quotes
    .filter((q) => q.productId === productId)
    .map((q) => ({ ...q, unitPriceEur: toEur(q.unitPrice, q.currency, settings) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Montant total d'une commande en EUR. */
export function orderTotalEur(order: Order, settings: Settings): number {
  return order.lines.reduce((s, l) => s + toEur(l.unitPrice, l.currency, settings) * l.qty, 0);
}

/** Coût logistique total d'une expédition en EUR. */
export function shipmentTotalEur(s: Shipment, settings: Settings): number {
  return toEur(s.freightCost + s.insuranceCost + s.originFees + s.destinationFees, s.currency, settings);
}

/** Trouve l'expédition qui contient une commande, et construit le contexte de répartition. */
export function shipmentContextForOrder(orderId: string, orders: Order[], shipments: Shipment[], products: Product[]): ShipmentContext | null {
  const shipment = shipments.find((s) => s.orderIds.includes(orderId));
  if (!shipment) return null;
  const lines = orders
    .filter((o) => shipment.orderIds.includes(o.id))
    .flatMap((o) => o.lines.map((line) => ({ line, product: products.find((p) => p.id === line.productId) })));
  return { shipment, lines };
}

/**
 * Coût de revient "de référence" d'un produit : sa dernière commande expédiée si elle existe,
 * sinon sa dernière commande, sinon son dernier devis (sans logistique).
 */
export function referenceLandedCost(
  productId: string,
  db: { products: Product[]; orders: Order[]; shipments: Shipment[]; quotes: Quote[]; settings: Settings },
): { breakdown: LandedCostBreakdown; source: string } | null {
  const product = db.products.find((p) => p.id === productId);
  const ordersWithLine = db.orders
    .filter((o) => o.lines.some((l) => l.productId === productId))
    .sort((a, b) => b.date.localeCompare(a.date));
  const withShipment = ordersWithLine.find((o) => db.shipments.some((s) => s.orderIds.includes(o.id)));
  const order = withShipment ?? ordersWithLine[0];
  if (order) {
    const line = order.lines.find((l) => l.productId === productId)!;
    const ctx = shipmentContextForOrder(order.id, db.orders, db.shipments, db.products);
    return {
      breakdown: computeLandedCost(product, line, ctx, db.settings),
      source: ctx ? `Commande ${order.reference || order.id} + expédition ${ctx.shipment.reference}` : `Commande ${order.reference || order.id} (sans logistique)`,
    };
  }
  const q = priceHistory(db.quotes, productId, db.settings).at(-1);
  if (q) {
    const line: OrderLine = { productId, qty: q.moq || 1, unitPrice: q.unitPrice, currency: q.currency };
    return { breakdown: computeLandedCost(product, line, null, db.settings), source: `Dernier devis du ${q.date} (sans logistique)` };
  }
  return null;
}

export function formatEur(n: number, digits = 2): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: digits }).format(n);
}
export function formatMoney(n: number, currency: Currency, digits = 2): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: digits }).format(n);
}
export function formatPct(n: number): string {
  return `${n.toFixed(1).replace('.', ',')} %`;
}

/**
 * Composants réellement comptés dans le coût standard : les composants de base
 * + pour chaque groupe d'options, la variante par défaut (ou la première du groupe).
 * `overrides` permet de choisir une autre variante par groupe (simulation).
 */
export function effectiveComponents(product: Product, overrides: Record<string, string> = {}): Product['components'] {
  const base = product.components.filter((c) => c.role !== 'option');
  const groups = new Map<string, Product['components']>();
  for (const c of product.components.filter((c) => c.role === 'option')) {
    const g = c.optionGroup || 'Options';
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const chosen: Product['components'] = [];
  groups.forEach((opts, g) => {
    const pick = (overrides[g] && opts.find((o) => o.productId === overrides[g])) ?? opts.find((o) => o.isDefault) ?? opts[0];
    if (pick) chosen.push(pick);
  });
  return [...base, ...chosen];
}

export interface UnitCostResult {
  costEur: number;
  /** 'achat' : prix usine seul ; 'composition' : somme des sous-références ; 'achat+composition' : les deux. */
  basis: 'achat' | 'composition' | 'achat+composition';
  /** Part du coût venant du prix usine (logistique et douane comprises), hors composition et coût additionnel. */
  purchaseEur: number;
  /** Part venant des sous-références. */
  compositionEur: number;
  /** Coûts additionnels détaillés (assemblage, transport interne, réparation…). */
  extraCosts: { label: string; amountEur: number }[];
  source: string;
  breakdown: LandedCostBreakdown | null;
  /** Détail par sous-référence quand la base est la composition. */
  components: { productId: string; qty: number; unitCostEur: number | null; totalEur: number }[];
  assemblyCostEur: number;
  /** Sous-références dont le coût est inconnu (le total est donc partiel). */
  missing: string[];
}

/**
 * Coût de revient unitaire d'une référence :
 *   prix usine (avec logistique et douane, s'il existe)
 * + sous-références (sauf si `componentsIncludedInPrice`, sauf celles fabriquées par la même usine — comprises dans le prix —,
 *   ou si aucun prix usine → composition seule)
 * + coût additionnel (assemblage, finition…).
 */
export function unitCost(
  productId: string,
  db: { products: Product[]; orders: Order[]; shipments: Shipment[]; quotes: Quote[]; settings: Settings },
  seen: Set<string> = new Set(),
  overrides: Record<string, string> = {},
): UnitCostResult | null {
  const product = db.products.find((p) => p.id === productId);
  if (!product || seen.has(productId)) return null;
  seen.add(productId);
  const extraCosts = (product.extraCosts ?? []).map((x) => ({ label: x.label, amountEur: extraCostEur(x, db.settings) }));
  const assembly = extraCosts.reduce((s, x) => s + x.amountEur, 0) + (product.assemblyCostEur || 0);
  const ref = referenceLandedCost(productId, db);
  // Sous-références comptées en plus du prix usine : toutes, sauf si l'usine fournit tout (componentsIncludedInPrice),
  // et sauf celles fabriquées par la même usine que le produit (déjà comprises dans son prix, ex. la housse dans le Wall).
  const sameFactory = (c: { productId: string }) => !!ref && !!product.factoryId && db.products.find((p) => p.id === c.productId)?.factoryId === product.factoryId;
  const comps = ref && product.componentsIncludedInPrice ? [] : effectiveComponents(product, overrides).filter((c) => !sameFactory(c));
  if (!ref && comps.length === 0) return null;

  const missing: string[] = [];
  const components = comps.map((c) => {
    const sub = unitCost(c.productId, db, new Set(seen));
    if (!sub) missing.push(c.productId);
    else missing.push(...sub.missing);
    return { productId: c.productId, qty: c.qty, unitCostEur: sub?.costEur ?? null, totalEur: (sub?.costEur ?? 0) * c.qty };
  });
  const compositionEur = components.reduce((s, c) => s + c.totalEur, 0);
  const purchaseEur = ref?.breakdown.landedUnitEur ?? 0;
  const basis: UnitCostResult['basis'] = ref && comps.length ? 'achat+composition' : ref ? 'achat' : 'composition';
  const source = ref
    ? `${ref.source}${comps.length ? ` + ${comps.length} sous-référence${comps.length > 1 ? 's' : ''}` : product.components.length && product.componentsIncludedInPrice ? ' (sous-références incluses dans le prix)' : ''}${assembly ? ' + coûts additionnels' : ''}`
    : `Composition (${comps.length} sous-référence${comps.length > 1 ? 's' : ''})${assembly ? ' + coûts additionnels' : ''}`;
  return { costEur: purchaseEur + compositionEur + assembly, basis, purchaseEur, compositionEur, extraCosts, source, breakdown: ref?.breakdown ?? null, components, assemblyCostEur: assembly, missing };
}

/** Toutes les versions d'une famille, triées par numéro de version. */
export function familyVersions(products: Product[], familyId: string): Product[] {
  const num = (v: string) => Number((v.match(/[\d.]+/) ?? ['0'])[0]) || 0;
  return products.filter((p) => (p.familyId || p.id) === familyId).sort((a, b) => num(a.version) - num(b.version) || a.versionDate.localeCompare(b.versionDate));
}
/** Version actuelle d'une famille (celle marquée, sinon la plus récente). */
export function currentVersion(products: Product[], familyId: string): Product | undefined {
  const all = familyVersions(products, familyId);
  return all.find((p) => p.isCurrentVersion) ?? all.at(-1);
}
export function nextVersionLabel(products: Product[], familyId: string): string {
  const num = (v: string) => Number((v.match(/\d+/) ?? ['0'])[0]) || 0;
  return `V${Math.max(0, ...familyVersions(products, familyId).map((p) => num(p.version))) + 1}`;
}
