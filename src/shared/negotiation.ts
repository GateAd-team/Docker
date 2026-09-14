/**
 * Négociation assistée : Docker prépare les demandes de prix et les contre-offres (anglais + chinois),
 * calcule des prix cibles à partir de l'historique et de la concurrence, et lit les réponses ;
 * l'utilisateur garde l'envoi et la décision.
 */
import type { Database, Negotiation, NegotiationLine, Project } from './types';
import { explodeNeeds, factoryLinePrice, includedInParentPrice } from './importFlows';
import { fromEur, priceHistory, toEur } from './finance';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Prix en USD d'un devis (dernier prix) chez une usine, pour un produit. */
export function lastPriceUsd(db: Database, productId: string, factoryId: string): { price: number; date: string; qty: number } | null {
  const q = priceHistory(db.quotes.filter((x) => x.factoryId === factoryId), productId, db.settings).at(-1);
  if (!q) return null;
  return { price: r2(q.currency === 'USD' ? q.unitPrice : fromEur(toEur(q.unitPrice, q.currency, db.settings), 'USD', db.settings)), date: q.date, qty: q.moq };
}

/** Meilleure offre connue chez une AUTRE usine pour ce produit (concurrence). */
export function bestCompetitor(db: Database, productId: string, factoryId: string): { factoryId: string; name: string; price: number; date: string } | null {
  let best: { factoryId: string; name: string; price: number; date: string } | null = null;
  for (const f of db.factories) {
    if (f.id === factoryId) continue;
    const lp = lastPriceUsd(db, productId, f.id);
    if (lp && (!best || lp.price < best.price)) best = { factoryId: f.id, name: f.name, price: lp.price, date: lp.date };
  }
  return best;
}

/**
 * Prix cible : le meilleur concurrent s'il est moins cher, sinon ~7 % sous le dernier prix
 * (et ~4 % seulement si la quantité baisse par rapport à la dernière commande).
 */
export function suggestTarget(last: number | null, competitor: number | null, qty: number, lastQty: number): number | null {
  if (last == null && competitor == null) return null;
  if (last == null) return r2(competitor!);
  const cut = lastQty > 0 && qty < lastQty ? 0.96 : 0.93;
  const fromHistory = last * cut;
  return r2(competitor != null && competitor < fromHistory ? competitor : fromHistory);
}

/** Ouvre (ou met à jour) la négociation d'une usine à partir des besoins de la liste de courses. */
export function buildNegotiationLines(db: Database, project: Project, factoryId: string, existing?: Negotiation): NegotiationLine[] {
  const needs = explodeNeeds(db, project.contents).filter((n) => n.factoryId === factoryId && !includedInParentPrice(db, n));
  const byProduct = new Map<string, number>();
  for (const n of needs) byProduct.set(n.productId, (byProduct.get(n.productId) ?? 0) + n.qty);
  return [...byProduct.entries()].map(([productId, qty]) => {
    const prev = existing?.lines.find((l) => l.productId === productId);
    const lp = lastPriceUsd(db, productId, factoryId);
    const composed = !lp ? factoryLinePrice(db, productId, factoryId) : null;
    const last = lp?.price ?? (composed ? r2(composed.currency === 'USD' ? composed.unitPrice : fromEur(composed.eur, 'USD', db.settings)) : null);
    const comp = bestCompetitor(db, productId, factoryId);
    return {
      productId, qty,
      lastPrice: last,
      targetPrice: prev?.targetPrice ?? suggestTarget(last, comp?.price ?? null, qty, lp?.qty ?? 0),
      offeredPrice: prev?.offeredPrice ?? null,
      agreedPrice: prev?.agreedPrice ?? null,
    };
  });
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const usd = (n: number) => `${fmt(n)} USD`;

interface MsgCtx { db: Database; project: Project; neg: Negotiation; sender: string; company: string }

/** Demande de prix (RFQ) en anglais puis en chinois. */
export function buildRfq({ db, project, neg, sender, company }: MsgCtx): string {
  const factory = db.factories.find((f) => f.id === neg.factoryId);
  const contact = db.contacts.find((c) => c.ownerType === 'factory' && c.ownerId === neg.factoryId)?.name;
  const name = (id: string) => db.products.find((p) => p.id === id)?.supplierName || db.products.find((p) => p.id === id)?.name || id;
  const when = project.targetDate ? ` (planned shipping ${project.targetDate})` : '';
  const whenZh = project.targetDate ? `（计划 ${project.targetDate} 发货）` : '';
  const en: string[] = [];
  const zh: string[] = [];
  en.push(`Hi ${contact || factory?.name || ''},`);
  en.push(`This is ${sender} from ${company}. We are preparing our next container${when} and would like your best price for:`);
  zh.push(`${contact || factory?.name || ''} 您好，`);
  zh.push(`我是 ${company} 的 ${sender}。我们正在准备下一个集装箱订单${whenZh}，请报以下产品的最优价格：`);
  for (const l of neg.lines) {
    const lp = lastPriceUsd(db, l.productId, neg.factoryId);
    const hist = lp ? ` — last time ${usd(lp.price)} (${lp.date})` : '';
    const histZh = lp ? `（上次 ${usd(lp.price)}，${lp.date}）` : '';
    en.push(`• ${l.qty} × ${name(l.productId)}${hist}`);
    zh.push(`• ${l.qty} × ${name(l.productId)}${histZh}`);
  }
  const targets = neg.lines.filter((l) => l.targetPrice != null && (l.lastPrice == null || l.targetPrice < l.lastPrice));
  if (targets.length) {
    const comp = targets.map((l) => bestCompetitor(db, l.productId, neg.factoryId)).filter(Boolean);
    en.push(`Given the volume${comp.length ? ' and other offers we have received' : ''}, we are targeting: ${targets.map((l) => `${name(l.productId)} at ${usd(l.targetPrice!)}`).join(', ')}.`);
    zh.push(`考虑到数量${comp.length ? '以及我们收到的其他报价' : ''}，我们的目标价格为：${targets.map((l) => `${name(l.productId)} ${usd(l.targetPrice!)}`).join('，')}。`);
  }
  en.push('Terms as usual: 30% deposit, balance before shipping, FOB. Please confirm your price, MOQ and production lead time.');
  en.push('Thank you!');
  zh.push('付款方式照旧：30% 定金，发货前付清余款，FOB。请确认价格、起订量和生产周期。');
  zh.push('谢谢！');
  return `${en.join('\n')}\n\n— 中文 —\n${zh.join('\n')}`;
}

/** Contre-offre : pour chaque ligne où l'offre reçue dépasse la cible, propose un prix entre les deux (60 % vers la cible). */
export function counterPrice(offered: number, target: number): number {
  if (offered <= target) return offered;
  return r2(offered - (offered - target) * 0.6);
}

export function buildCounterOffer({ db, neg, sender, company }: MsgCtx): string {
  const factory = db.factories.find((f) => f.id === neg.factoryId);
  const contact = db.contacts.find((c) => c.ownerType === 'factory' && c.ownerId === neg.factoryId)?.name;
  const name = (id: string) => db.products.find((p) => p.id === id)?.supplierName || db.products.find((p) => p.id === id)?.name || id;
  const above = neg.lines.filter((l) => l.offeredPrice != null && l.targetPrice != null && l.offeredPrice > l.targetPrice);
  const ok = neg.lines.filter((l) => l.offeredPrice != null && (l.targetPrice == null || l.offeredPrice <= l.targetPrice));
  const en: string[] = [`Hi ${contact || factory?.name || ''}, thank you for your quotation.`];
  const zh: string[] = [`${contact || factory?.name || ''} 您好，感谢您的报价。`];
  if (ok.length) { en.push(`We can confirm ${ok.map((l) => `${name(l.productId)} at ${usd(l.offeredPrice!)}`).join(', ')}.`); zh.push(`以下价格我们可以确认：${ok.map((l) => `${name(l.productId)} ${usd(l.offeredPrice!)}`).join('，')}。`); }
  for (const l of above) {
    const comp = bestCompetitor(db, l.productId, neg.factoryId);
    const counter = counterPrice(l.offeredPrice!, l.targetPrice!);
    const why = comp && comp.price < l.offeredPrice! ? ` — we have another offer at ${usd(comp.price)}` : l.lastPrice != null && l.offeredPrice! > l.lastPrice ? ` — that is above our last order (${usd(l.lastPrice)})` : '';
    en.push(`For ${name(l.productId)}, ${usd(l.offeredPrice!)} is above what we can accept${why}. Could you do ${usd(counter)} for ${l.qty} pcs?`);
    const whyZh = comp && comp.price < l.offeredPrice! ? `，我们收到了 ${usd(comp.price)} 的其他报价` : l.lastPrice != null && l.offeredPrice! > l.lastPrice ? `，高于我们上次的订单价格（${usd(l.lastPrice)}）` : '';
    zh.push(`${name(l.productId)} 的报价 ${usd(l.offeredPrice!)} 超出了我们能接受的范围${whyZh}。${l.qty} 件能否做到 ${usd(counter)}？`);
  }
  en.push('If we can agree on this, we will confirm the order and pay the deposit this week.');
  zh.push('如果价格可以确认，我们本周即可下单并支付定金。');
  en.push(`${sender}, ${company}`);
  return `${en.join('\n')}\n\n— 中文 —\n${zh.join('\n')}`;
}

/** Associe les prix lus dans une capture / un PDF aux lignes de la négociation (par ressemblance de libellé). */
export function matchOffers(db: Database, neg: Negotiation, prices: { item: string; price: number; currency: string }[], similarity: (a: string, b: string) => number): { productId: string; price: number; item: string }[] {
  const out: { productId: string; price: number; item: string }[] = [];
  for (const pr of prices) {
    if (!pr.item || !(pr.price > 0)) continue;
    let best: { productId: string; score: number } | null = null;
    for (const l of neg.lines) {
      const p = db.products.find((x) => x.id === l.productId);
      if (!p) continue;
      const score = Math.max(similarity(p.name, pr.item), p.supplierName ? similarity(p.supplierName, pr.item) : 0);
      if (score > (best?.score ?? 0)) best = { productId: l.productId, score };
    }
    if (best && best.score >= 0.4) {
      const cur = String(pr.currency || 'USD').toUpperCase();
      const price = cur === 'USD' ? pr.price : fromEur(toEur(pr.price, (['EUR', 'GBP', 'CNY'].includes(cur) ? cur : 'USD') as 'EUR', db.settings), 'USD', db.settings);
      out.push({ productId: best.productId, price: r2(price), item: pr.item });
    }
  }
  return out;
}

/** Économie réalisée : (dernier prix − prix convenu) × quantité, en USD. */
export function savingsUsd(neg: Negotiation): number {
  return r2(neg.lines.reduce((t, l) => t + ((l.lastPrice ?? 0) - (l.agreedPrice ?? l.offeredPrice ?? l.lastPrice ?? 0)) * l.qty, 0));
}
