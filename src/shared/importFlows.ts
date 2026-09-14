/**
 * Déduction automatique du contenu d'un conteneur et des flux entre usines
 * à partir des commandes de l'importation et des compositions des marchandises.
 *
 * Exemple : cadres commandés chez A, EPP chez B, tissu chez C ; l'usine D facture
 * « confection des housses + assemblage » sans référence de marchandise. Les compositions
 * disent que Wall 1 m = EPP + cadre + housse et que Housse = tissu, fabriquée chez D :
 * on propose donc « 356 × Wall 1 m » dans le conteneur, et les flux A→D, B→D, C→D, D→France.
 */
import type { Database, Project, ProjectFlow } from './types';
import { effectiveComponents, extraCostEur, priceHistory, toEur } from './finance';
import type { Currency } from './types';

export interface ContentProposal {
  productId: string;
  qty: number;
  /** assembled : produit fini constitué des composants commandés ; ordered : commandé tel quel ; component : commandé mais consommé par un autre produit, ne monte pas dans le conteneur. */
  kind: 'assembled' | 'ordered' | 'component';
  /** Explication lisible : ce qui limite la quantité, ce qui manque… */
  reason: string;
}

/** Toutes les versions d'une même marchandise (V1, V2…) comptent comme la même : on ramène chaque id à la version courante de sa famille. */
export function canonicalProductId(db: Database, productId: string): string {
  const p = db.products.find((x) => x.id === productId);
  if (!p) return productId;
  const fam = p.familyId || p.id;
  const cur = db.products.find((x) => (x.familyId || x.id) === fam && x.isCurrentVersion) ?? db.products.filter((x) => (x.familyId || x.id) === fam).at(-1);
  return cur?.id ?? productId;
}

/** Quantités de marchandises commandées dans l'importation (hors prestations), toutes versions confondues. */
export function orderedQuantities(db: Database, projectId: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of db.orders.filter((o) => o.projectId === projectId)) for (const l of o.lines) {
    if (!l.productId || l.isService) continue;
    const id = canonicalProductId(db, l.productId);
    m.set(id, (m.get(id) ?? 0) + l.qty);
  }
  return m;
}

interface Buildable { qty: number; limitedBy: string | null; missing: string[]; covered: number; total: number }

/**
 * Combien d'unités d'un produit on peut constituer avec ce qui est disponible.
 * Un composant fabriqué par l'usine qui assemble le produit (même factoryId) est supposé fourni par elle.
 */
export function buildable(db: Database, productId: string, available: Map<string, number>, stack = new Set<string>()): Buildable {
  const product = db.products.find((p) => p.id === productId);
  if (!product) return { qty: 0, limitedBy: null, missing: [], covered: 0, total: 0 };
  if (available.has(productId)) return { qty: available.get(productId)!, limitedBy: product.name, missing: [], covered: 1, total: 1 };
  const comps = effectiveComponents(product, {});
  if (comps.length === 0 || stack.has(productId)) return { qty: 0, limitedBy: null, missing: [product.name], covered: 0, total: 1 };
  stack.add(productId);
  let qty = Infinity; let limitedBy: string | null = null; const missing: string[] = []; let covered = 0;
  for (const c of comps) {
    const sub = db.products.find((p) => p.id === canonicalProductId(db, c.productId));
    if (!sub) continue;
    if (sub.factoryId && sub.factoryId === product.factoryId && !available.has(sub.id) && effectiveComponents(sub, {}).every((x) => !available.has(x.productId))) { covered++; continue; } // fourni par l'assembleur
    const b = buildable(db, sub.id, available, stack);
    if (b.qty <= 0) { missing.push(sub.name); continue; }
    covered++;
    const q = Math.floor(b.qty / (c.qty || 1));
    if (q < qty) { qty = q; limitedBy = b.limitedBy ?? sub.name; }
  }
  stack.delete(productId);
  return { qty: qty === Infinity ? 0 : qty, limitedBy, missing, covered, total: comps.length };
}

/** Consomme récursivement les composants nécessaires à `qty` unités du produit. */
function consume(db: Database, productId: string, qty: number, available: Map<string, number>, stack = new Set<string>()) {
  if (available.has(productId)) { available.set(productId, Math.max(0, available.get(productId)! - qty)); return; }
  const product = db.products.find((p) => p.id === productId);
  if (!product || stack.has(productId)) return;
  stack.add(productId);
  for (const c of effectiveComponents(product, {})) consume(db, canonicalProductId(db, c.productId), qty * c.qty, available, stack);
  stack.delete(productId);
}

function usesRecursively(db: Database, productId: string, targetId: string, stack = new Set<string>()): boolean {
  const p = db.products.find((x) => x.id === productId);
  if (!p || stack.has(productId)) return false;
  stack.add(productId);
  return effectiveComponents(p, {}).some((c) => canonicalProductId(db, c.productId) === canonicalProductId(db, targetId) || usesRecursively(db, canonicalProductId(db, c.productId), targetId, stack));
}

/** Propose le contenu final du conteneur : produits assemblables d'après les compositions, puis reliquats. */
export function proposeContents(db: Database, project: Project): ContentProposal[] {
  const available = orderedQuantities(db, project.id);
  if (available.size === 0) return [];
  const out: ContentProposal[] = [];
  const working = new Map(available);
  // 1) Produits finis commandés tels quels qui ont une composition (ex. paravents faits avec un tissu lui aussi facturé) :
  //    leurs composants commandés sont consommés, ils ne montent pas dans le conteneur en plus.
  const orderedFinished = [...available.keys()].filter((id) => {
    const p = db.products.find((x) => x.id === id);
    return !!p && effectiveComponents(p, {}).length > 0 && ![...available.keys()].some((other) => other !== id && usesRecursively(db, other, id));
  });
  for (const id of orderedFinished) {
    const p = db.products.find((x) => x.id === id)!;
    for (const c of effectiveComponents(p, {})) consume(db, canonicalProductId(db, c.productId), available.get(id)! * c.qty, working);
  }
  // 2) Candidats : produits composés (version actuelle) dont au moins un composant est commandé dans l'importation.
  const candidates = db.products
    .filter((p) => p.isCurrentVersion && p.components.length > 0 && !available.has(p.id) && [...available.keys()].some((id) => usesRecursively(db, p.id, id)))
    .map((p) => ({ p, b: buildable(db, p.id, available) }))
    .filter(({ b }) => b.qty > 0 && b.covered / Math.max(1, b.total) >= 0.5);
  // On garde les produits de plus haut niveau (pas utilisés par un autre candidat retenu).
  const top = candidates.filter(({ p }) => !candidates.some(({ p: other }) => other.id !== p.id && usesRecursively(db, other.id, p.id)));
  top.sort((a, b) => b.b.qty * (db.products.find((x) => x.id === b.p.id)?.components.length ?? 0) - a.b.qty * (db.products.find((x) => x.id === a.p.id)?.components.length ?? 0));
  for (const { p } of top) {
    const b = buildable(db, p.id, working);
    if (b.qty <= 0) continue;
    consume(db, p.id, b.qty, working);
    const reason = [b.limitedBy ? `limité par ${b.limitedBy}` : '', b.missing.length ? `⚠ non commandé : ${b.missing.join(', ')}` : ''].filter(Boolean).join(' · ');
    out.push({ productId: p.id, qty: b.qty, kind: 'assembled', reason: reason || "d'après la composition" });
  }
  // 3) Le reste : commandé tel quel — sauf les composants d'un produit déjà retenu (tissu des paravents, EPP des Wall…),
  //    qui restent chez l'usine qui assemble et ne montent pas dans le conteneur.
  const name = (id: string) => db.products.find((x) => x.id === id)?.name ?? id;
  const loaded = [...out.map((x) => x.productId), ...[...working.entries()].filter(([, q]) => q > 0.5).map(([id]) => id)];
  const parentsOf = (id: string) => loaded.filter((pid) => pid !== id && usesRecursively(db, pid, id));
  const rest = [...working.entries()].filter(([, q]) => q > 0.5);
  for (const [id, q] of rest) if (!parentsOf(id).length) out.push({ productId: id, qty: Math.round(q * 100) / 100, kind: 'ordered', reason: available.get(id) !== q ? 'reliquat, expédié tel quel' : 'commandé, expédié tel quel' });
  for (const [id, q] of rest) { const parents = parentsOf(id); if (parents.length) out.push({ productId: id, qty: 0, kind: 'component', reason: `composant de ${parents.map(name).join(', ')} — ${Math.round(q * 100) / 100} restant (chutes / marge), non chargé` }); }
  return out;
}

/**
 * Génère les flux entre usines à partir du contenu du conteneur et des compositions :
 * chaque composant part de son usine vers l'usine qui assemble le produit parent ; le produit fini part vers la France.
 * Les flux existants sur le même trajet gardent leur statut, date et note ; les flux automatiques obsolètes sont retirés.
 */
export function generateFlows(db: Database, project: Project, contents: Project['contents'], newId: () => string, today: string): ProjectFlow[] {
  const pairs = new Map<string, Map<string, number>>(); // "from→to" → productId → qty
  const add = (from: string, to: string, productId: string, qty: number) => {
    if (!from || from === to) return;
    const key = `${from}→${to}`;
    const m = pairs.get(key) ?? new Map<string, number>();
    m.set(productId, (m.get(productId) ?? 0) + qty);
    pairs.set(key, m);
  };
  const walk = (productId: string, qty: number, dest: string, stack: Set<string>) => {
    const product = db.products.find((p) => p.id === productId);
    if (!product || stack.has(productId)) return;
    stack.add(productId);
    const from = product.factoryId ?? '';
    if (from && from !== dest) add(from, dest, productId, qty);
    const assembler = from || dest;
    // Composants : ils rejoignent l'usine qui assemble (ou la destination si le produit est assemblé sur place / en France).
    if (product.componentsIncludedInPrice && from) { stack.delete(productId); return; } // l'usine fournit tout, rien ne transite
    for (const c of effectiveComponents(product, {})) walk(c.productId, qty * c.qty, assembler, stack);
    stack.delete(productId);
  };
  // Groupage : si une usine charge le conteneur, tout converge vers elle, puis elle expédie vers la France.
  const hub = project.consolidatorFactoryId && db.factories.some((f) => f.id === project.consolidatorFactoryId) ? project.consolidatorFactoryId : 'FR';
  for (const line of contents) walk(line.productId, line.qty, hub, new Set());
  if (hub !== 'FR') for (const line of contents) add(hub, 'FR', line.productId, line.qty);

  const result: ProjectFlow[] = [];
  const used = new Set<string>();
  for (const [key, m] of pairs) {
    const [from, to] = key.split('→');
    const lines = [...m.entries()].map(([productId, qty]) => ({ productId, qty: Math.round(qty * 100) / 100 }));
    const existing = project.flows.find((f) => f.fromFactoryId === from && f.to === to);
    if (existing) { used.add(existing.id); result.push({ ...existing, lines, auto: true }); }
    else result.push({ id: newId(), fromFactoryId: from, to, lines, date: to === 'FR' ? project.targetDate || '' : '', status: 'prevu', note: '', auto: true });
  }
  // Flux saisis à la main : conservés. Flux automatiques d'une génération précédente : retirés s'ils n'existent plus.
  for (const f of project.flows) if (!used.has(f.id) && !f.auto) result.push(f);
  return result;
}




export interface Need {
  productId: string;
  /** Usine à qui commander (null = assemblé en France, rien à commander pour cette ligne). */
  factoryId: string | null;
  qty: number;
  /** Produit fini de la liste de courses dont ce besoin découle (le premier rencontré). */
  forProductId: string;
  /** Produit parent direct dans la composition (null pour une ligne de la liste de courses). */
  parentId: string | null;
  /** Le parent est acheté « sous-références comprises » : ce besoin est fourni par l'usine du parent, rien à commander. */
  inPrice?: boolean;
  depth: number;
}

/**
 * Éclate la liste de courses (produits finis voulus en France) en besoins par usine,
 * d'après les compositions : chaque produit fabriqué par une usine est à lui commander,
 * et ses composants sont à commander à leurs usines respectives (sauf si l'usine fournit tout).
 */
export function explodeNeeds(db: Database, contents: Project['contents']): Need[] {
  const acc = new Map<string, Need>();
  const walk = (productId: string, qty: number, forProductId: string, parentId: string | null, depth: number, inPrice: boolean, stack: Set<string>) => {
    const product = db.products.find((p) => p.id === canonicalProductId(db, productId));
    if (!product || stack.has(product.id) || qty <= 0) return;
    stack.add(product.id);
    // Une ligne par (produit, parent) : la housse commandée telle quelle et la housse comprise dans le Wall restent distinctes.
    const key = `${product.id}|${parentId ?? ''}`;
    const cur = acc.get(key);
    if (cur) cur.qty += qty; else acc.set(key, { productId: product.id, factoryId: product.factoryId, qty, forProductId, parentId, depth, ...(inPrice ? { inPrice: true } : {}) });
    // Les sous-références sont toujours listées (on voit de quoi le produit est fait) ; si le parent est acheté « tout compris », elles sont marquées fournies par son usine.
    const provided = !!(product.componentsIncludedInPrice && product.factoryId);
    for (const c of effectiveComponents(product, {})) walk(c.productId, qty * c.qty, forProductId, product.id, depth + 1, inPrice || provided, stack);
    stack.delete(product.id);
  };
  for (const line of contents) walk(line.productId, line.qty, line.productId, null, 0, false, new Set());
  return [...acc.values()].map((n) => ({ ...n, qty: Math.round(n.qty * 100) / 100 })).sort((a, b) => a.depth - b.depth);
}

/**
 * Vrai si ce besoin est déjà compris dans le prix d'une autre ligne de la même usine :
 * un composant fabriqué par l'usine qui assemble son parent (ex. la housse dans le prix du Wall chez Kuo Ching).
 */
export function includedInParentPrice(db: Database, need: Need): boolean {
  if (need.inPrice) return true;
  if (!need.parentId || !need.factoryId) return false;
  const parent = db.products.find((p) => p.id === need.parentId);
  return !!parent && parent.factoryId === need.factoryId;
}

export interface FactoryLinePrice { eur: number; source: 'prix' | 'composition'; unitPrice: number; currency: Currency; detail: string }

/**
 * Ce que l'usine facture pour une unité de ce produit :
 * son dernier prix chez cette usine s'il existe ; sinon la somme des sous-références qu'elle fabrique elle-même
 * (récursivement) + les coûts additionnels du produit (assemblage, confection…).
 */
export function factoryLinePrice(db: Database, productId: string, factoryId: string, stack = new Set<string>()): FactoryLinePrice | null {
  const product = db.products.find((p) => p.id === productId);
  if (!product || stack.has(productId)) return null;
  const quote = priceHistory(db.quotes.filter((q) => q.factoryId === factoryId), productId, db.settings).at(-1)
    ?? (product.factoryId === factoryId ? priceHistory(db.quotes, productId, db.settings).at(-1) : undefined);
  if (quote) return { eur: toEur(quote.unitPrice, quote.currency, db.settings), source: 'prix', unitPrice: quote.unitPrice, currency: quote.currency, detail: 'dernier prix usine' };
  stack.add(productId);
  const parts: string[] = [];
  let eur = 0;
  for (const c of effectiveComponents(product, {})) {
    const sub = db.products.find((p) => p.id === c.productId);
    if (!sub || sub.factoryId !== factoryId) continue; // fabriquée ailleurs : facturée par son usine
    const sp = factoryLinePrice(db, sub.id, factoryId, stack);
    if (sp) { eur += sp.eur * c.qty; parts.push(`${c.qty} × ${sub.name}`); }
  }
  const extras = (product.extraCosts ?? []).reduce((t, x) => t + extraCostEur(x, db.settings), 0);
  if (extras > 0) { eur += extras; parts.push('coûts additionnels'); }
  stack.delete(productId);
  if (parts.length === 0) return null;
  return { eur, source: 'composition', unitPrice: eur, currency: 'EUR', detail: parts.join(' + ') };
}
