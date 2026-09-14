import { folderPath } from './Merchandise';
import React, { useEffect, useMemo, useState } from 'react';
import { today, useStore } from '../store';
import { useNav } from '../App';
import { Badge, Empty, Field, NumberInput, Select, Stat, fmtDate } from '../components/ui';
import { MARKET_LABELS } from '../labels';
import { folderTree } from './Merchandise';
import type { Currency, Market, MarketPrice } from '../../shared/types';
import { familyVersions, computeLandedCost, computeMargin, formatEur, formatMoney, formatPct, priceForTargetMargin, priceHistory, shipmentContextForOrder, shipmentTotalEur, unitCost, type LandedCostBreakdown, type UnitCostResult } from '../../shared/finance';
import { extraCostEur } from '../../shared/finance';
import { MarketForm } from '../components/MarketForm';

const MARKETS: Market[] = ['FR', 'UK', 'US'];
const DEFAULT_CURRENCY: Record<Market, Currency> = { FR: 'EUR', UK: 'GBP', US: 'USD' };
const CURRENCIES: { value: Currency; label: string }[] = [{ value: 'EUR', label: 'EUR' }, { value: 'GBP', label: 'GBP' }, { value: 'USD', label: 'USD' }, { value: 'CNY', label: 'CNY' }];

export function FinancePage() {
  const { db, update, toast } = useStore();
  const { nav } = useNav();
  const [productId, setProductId] = useState<string>(nav.id ?? db.products[0]?.id ?? '');
  const [orderId, setOrderId] = useState<string>('');
  const [target, setTarget] = useState(40);

  useEffect(() => { if (nav.id) setProductId(nav.id); }, [nav.id]);
  const product = db.products.find((p) => p.id === productId);
  useEffect(() => { setOrderId(''); }, [productId]);

  const ordersForProduct = db.orders.filter((o) => o.lines.some((l) => l.productId === productId)).sort((a, b) => b.date.localeCompare(a.date));
  const ref = useMemo<UnitCostResult | null>(() => {
    if (!product) return null;
    if (orderId) {
      const o = ordersForProduct.find((x) => x.id === orderId)!;
      const line = o.lines.find((l) => l.productId === productId)!;
      const ctx = shipmentContextForOrder(o.id, db.orders, db.shipments, db.products);
      const breakdown = computeLandedCost(product, line, ctx, db.settings);
      const compo = unitCost(productId, db);
      const compositionEur = product.componentsIncludedInPrice ? 0 : compo?.compositionEur ?? 0;
      const extras = product.extraCosts.map((x) => ({ label: x.label, amountEur: extraCostEur(x, db.settings) }));
      const extraTotal = extras.reduce((t, x) => t + x.amountEur, 0);
      return { costEur: breakdown.landedUnitEur + compositionEur + extraTotal, basis: compositionEur ? 'achat+composition' : 'achat', purchaseEur: breakdown.landedUnitEur, compositionEur, extraCosts: extras, source: ctx ? `Commande ${o.reference} + expédition ${ctx.shipment.reference}` : `Commande ${o.reference} (sans logistique)`, breakdown, components: compo?.components ?? [], assemblyCostEur: extraTotal, missing: compo?.missing ?? [] };
    }
    return unitCost(productId, db);
  }, [db, product, productId, orderId, ordersForProduct]);

  // Historique des prix de toute la famille (toutes versions), avec l'étiquette de version.
  const history = product ? familyVersions(db.products, product.familyId || product.id).flatMap((v) => priceHistory(db.quotes, v.id, db.settings).map((h) => ({ ...h, version: v.version }))).sort((a, b) => a.date.localeCompare(b.date)) : [];

  const marketPrice = (m: Market): MarketPrice => db.marketPrices.find((x) => x.productId === productId && x.market === m)
    ?? { id: `mp-${productId}-${m}`, productId, market: m, sellPrice: 0, currency: DEFAULT_CURRENCY[m], vatPct: db.settings.defaultVat[m], platformFeePct: 0, lastMileCost: 0, date: today() };
  const saveMarket = (mp: MarketPrice) => update((d) => ({ ...d, marketPrices: d.marketPrices.some((x) => x.id === mp.id) ? d.marketPrices.map((x) => (x.id === mp.id ? { ...mp, date: today() } : x)) : [...d.marketPrices, mp] }));

  if (db.products.length === 0) {
    return <div className="page"><div className="page-head"><div><h1>Finance</h1></div></div><div className="card"><Empty icon="€" title="Aucun produit" text="Crée un projet et ses produits pour calculer coûts de revient et marges." /></div></div>;
  }

  const overview = db.products.map((p) => {
    const r = unitCost(p.id, db);
    const margins = MARKETS.map((m) => { const mp = db.marketPrices.find((x) => x.productId === p.id && x.market === m); return r && mp && mp.sellPrice > 0 ? computeMargin(r.costEur, mp, db.settings) : null; });
    return { p, r, margins };
  });

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Finance</h1><div className="sub">Coût de revient complet et marges par marché, produit par produit.</div></div>
        <div className="actions">
          <select className="search" value={productId} onChange={(e) => setProductId(e.target.value)}>
            {folderTree(db.folders).map(({ folder, depth }) => db.products.some((p) => p.folderId === folder.id) && <optgroup key={folder.id} label={`${'  '.repeat(depth)}${folder.name}`}>{db.products.filter((p) => p.folderId === folder.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}
            {db.products.some((p) => !p.folderId) && <optgroup label="Non classées">{db.products.filter((p) => !p.folderId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
          </select>
        </div>
      </div>

      {product && (
        <>
          <div className="grid c4 mb">
            <Stat label="Coût de revient unitaire" value={ref ? formatEur(ref.costEur) : '—'} hint={ref?.source ?? 'Aucune commande ni devis'} />
            {MARKETS.map((m) => {
              const mp = marketPrice(m);
              const res = ref && mp.sellPrice > 0 ? computeMargin(ref.costEur, mp, db.settings) : null;
              return <Stat key={m} label={`Marge ${MARKET_LABELS[m]}`} value={res ? <span style={{ color: res.marginPct >= 40 ? 'var(--ok)' : res.marginPct >= 20 ? 'var(--warn)' : 'var(--bad)' }}>{formatPct(res.marginPct)}</span> : '—'} hint={res ? `${formatEur(res.marginEur)} / pièce · coef ${res.coefficient.toFixed(2)}` : 'Renseigne un prix de vente'} />;
            })}
          </div>

          <div className="grid c2">
            <div className="card">
              <div className="card-head"><h2>Coût de revient</h2>
                {ordersForProduct.length > 0 && <Select value={orderId} onChange={setOrderId} options={[{ value: '', label: 'Référence automatique' }, ...ordersForProduct.map((o) => ({ value: o.id, label: `Commande ${o.reference || fmtDate(o.date)}` }))]} />}
              </div>
              {!ref ? <Empty icon="€" title="Pas de prix connu" text="Ajoute un prix usine ou une composition à cette référence (onglet Marchandise)." /> : <>{ref.breakdown && <Breakdown b={ref.breakdown} extras={ref.components.length ? [] : ref.extraCosts} />}{ref.components.length > 0 && <CompositionBreakdown r={ref} />}{ref.components.length === 0 && !ref.breakdown && <CompositionBreakdown r={ref} />}</>}
            </div>

            <div className="card">
              <div className="card-head"><h2>Historique des prix usine</h2></div>
              {history.length === 0 ? <Empty icon="📈" title="Aucun prix" text="Chaque devis, PI ou facture importé ajoute un point." /> : (
                <>
                  <PriceChart points={history.map((h) => ({ date: h.date, value: h.unitPriceEur }))} />
                  <table className="tbl mt">
                    <thead><tr><th>Date</th><th>Version</th><th>Usine</th><th className="num">Prix</th><th className="num">En EUR</th><th className="num">MOQ</th><th>Évolution</th></tr></thead>
                    <tbody>{history.map((h, i) => {
                      const prev = history[i - 1];
                      const delta = prev ? ((h.unitPriceEur - prev.unitPriceEur) / prev.unitPriceEur) * 100 : null;
                      return <tr key={h.id}><td>{fmtDate(h.date)}</td><td><Badge>{h.version}</Badge></td><td className="small">{db.factories.find((f) => f.id === h.factoryId)?.name ?? '—'}</td><td className="num">{formatMoney(h.unitPrice, h.currency)}</td><td className="num">{formatEur(h.unitPriceEur)}</td><td className="num">{h.moq || '—'}</td><td>{delta == null ? <span className="muted">—</span> : <Badge tone={delta > 0 ? 'red' : delta < 0 ? 'green' : ''}>{delta > 0 ? '+' : ''}{delta.toFixed(1)} %</Badge>}</td></tr>;
                    })}</tbody>
                  </table>
                </>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Marges par marché</h2><div className="row-flex small muted">Marge cible <input type="number" value={target} onChange={(e) => setTarget(Number(e.target.value))} style={{ width: 60, border: '1px solid var(--line)', borderRadius: 6, padding: '3px 6px' }} /> %</div></div>
            <div className="grid c3">
              {MARKETS.map((m) => {
                const mp = marketPrice(m);
                const res = ref && mp.sellPrice > 0 ? computeMargin(ref.costEur, mp, db.settings) : null;
                const suggested = ref ? priceForTargetMargin(ref.costEur, target, mp, db.settings) : 0;
                return (
                  <div key={m} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
                    <div className="row-flex mb"><b>{MARKET_LABELS[m]}</b><span style={{ flex: 1 }} />{res && <Badge tone={res.marginPct >= target ? 'green' : res.marginPct >= 20 ? 'amber' : 'red'}>{formatPct(res.marginPct)}</Badge>}</div>
                    <MarketForm mp={mp} onSave={(v) => { saveMarket(v); toast(`Prix ${MARKET_LABELS[m]} enregistré`); }} />
                    {res ? (
                      <div className="kv mt small">
                        <span className="k">Prix HT</span><span>{formatEur(res.sellPriceHtEur)}</span>
                        <span className="k">− commission</span><span>{formatEur(res.platformFeeEur)}</span>
                        <span className="k">− livraison client</span><span>{formatEur(res.lastMileEur)}</span>
                        <span className="k">− coût de revient</span><span>{formatEur(res.landedUnitEur)}</span>
                        <span className="k"><b>Marge nette</b></span><span><b>{formatEur(res.marginEur)}</b> ({formatPct(res.marginPct)}) · coef {res.coefficient.toFixed(2)}</span>
                      </div>
                    ) : <div className="muted small mt">Renseigne un prix de vente pour voir la marge.</div>}
                    {ref && suggested > 0 && <div className="small mt">Pour {target} % de marge : <b>{formatMoney(suggested, mp.currency)}</b> TTC</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <div className="card pad0">
        <div className="card-head" style={{ padding: '14px 20px 0' }}><h2>Vue d'ensemble</h2></div>
        <table className="tbl">
          <thead><tr><th>Produit</th><th>Dossier</th><th className="num">Coût de revient</th>{MARKETS.map((m) => <th key={m} className="num">Marge {m}</th>)}</tr></thead>
          <tbody>{overview.map(({ p, r, margins }) => (
            <tr key={p.id} className="click" onClick={() => setProductId(p.id)} style={p.id === productId ? { background: 'var(--accent-soft)' } : undefined}>
              <td className="strong">{p.name}</td><td className="small muted">{folderPath(db.folders, p.folderId)}</td>
              <td className="num">{r ? formatEur(r.costEur) : '—'}</td>
              {margins.map((mg, i) => <td key={i} className="num">{mg ? <span style={{ color: mg.marginPct >= 40 ? 'var(--ok)' : mg.marginPct >= 20 ? 'var(--warn)' : 'var(--bad)' }}>{formatPct(mg.marginPct)}</span> : <span className="muted">—</span>}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>

      {db.shipments.length > 0 && (
        <div className="card pad0">
          <div className="card-head" style={{ padding: '14px 20px 0' }}><h2>Évolution des coûts de transport</h2></div>
          <table className="tbl">
            <thead><tr><th>Expédition</th><th>Départ</th><th>Mode</th><th className="num">Volume</th><th className="num">Total logistique</th><th className="num">€ / m³</th></tr></thead>
            <tbody>{[...db.shipments].sort((a, b) => (a.etd || '').localeCompare(b.etd || '')).map((s) => { const t = shipmentTotalEur(s, db.settings); return <tr key={s.id}><td className="strong">{s.reference}</td><td>{fmtDate(s.etd)}</td><td>{s.mode}</td><td className="num">{s.cbm ? `${s.cbm} m³` : '—'}</td><td className="num">{formatEur(t)}</td><td className="num">{s.cbm ? formatEur(t / s.cbm) : '—'}</td></tr>; })}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CompositionBreakdown({ r }: { r: UnitCostResult }) {
  const { db } = useStore();
  const { go } = useNav();
  return (
    <table className="tbl">
      <thead><tr><th>Sous-référence</th><th className="num">Qté</th><th className="num">Coût unitaire</th><th className="num">Total</th></tr></thead>
      <tbody>
        {r.components.map((c) => { const p = db.products.find((x) => x.id === c.productId); return <tr key={c.productId} className="click" onClick={() => go('finance', c.productId)}><td>{p?.name ?? '?'}</td><td className="num">{c.qty}</td><td className="num">{c.unitCostEur != null ? formatEur(c.unitCostEur) : <span style={{ color: 'var(--warn)' }}>inconnu</span>}</td><td className="num">{c.unitCostEur != null ? formatEur(c.totalEur) : '—'}</td></tr>; })}
        {r.purchaseEur > 0 && <tr><td colSpan={3}>Prix usine de la référence (ci-dessus)</td><td className="num">{formatEur(r.purchaseEur)}</td></tr>}
        {r.extraCosts.map((x, i) => <tr key={i}><td colSpan={3} className="muted">＋ {x.label || 'Coût additionnel'}</td><td className="num">{formatEur(x.amountEur)}</td></tr>)}
        <tr className="total"><td colSpan={3}>Coût de revient unitaire{r.missing.length > 0 && <span className="muted small"> (partiel : {r.missing.length} sous-réf. sans prix)</span>}</td><td className="num">{formatEur(r.costEur)}</td></tr>
      </tbody>
    </table>
  );
}

function Breakdown({ b, extras = [] }: { b: LandedCostBreakdown; extras?: { label: string; amountEur: number }[] }) {
  const assembly = extras.reduce((t, x) => t + x.amountEur, 0);
  const rows: { label: string; value: number; sub?: string; strong?: boolean }[] = [
    { label: 'Marchandise (prix usine)', value: b.goodsUnitEur },
    { label: 'Fret', value: b.freightUnitEur, sub: b.shareBasis !== 'aucune' ? `part ${(b.share * 100).toFixed(1)} % de l'expédition (${b.shareBasis})` : 'aucune expédition rattachée' },
    { label: 'Assurance', value: b.insuranceUnitEur },
    { label: 'Frais au départ', value: b.originFeesUnitEur },
    { label: 'Valeur en douane', value: b.customsValueUnitEur, strong: true },
    { label: `Droits de douane (${b.dutyRatePct} %)`, value: b.dutyUnitEur },
    { label: "Frais à l'arrivée", value: b.destinationFeesUnitEur },
  ];
  return (
    <table className="tbl">
      <tbody>
        {rows.map((r) => <tr key={r.label}><td className={r.strong ? 'strong' : ''}>{r.label}{r.sub && <div className="muted small">{r.sub}</div>}</td><td className={`num${r.strong ? ' strong' : ''}`}>{formatEur(r.value)}</td></tr>)}
        {extras.map((x, i) => <tr key={i}><td>＋ {x.label || 'Coût additionnel'}</td><td className="num">{formatEur(x.amountEur)}</td></tr>)}
        <tr className="total"><td>{assembly ? 'Coût de revient unitaire (hors TVA)' : 'Prix usine rendu, droits compris (hors TVA)'}</td><td className="num">{formatEur(b.landedUnitEur + assembly)}</td></tr>
        <tr><td className="muted small">TVA à l'import (indicatif, récupérable)</td><td className="num muted small">{formatEur(b.importVatUnitEur)}</td></tr>
        <tr><td className="muted small">Pour {b.qty} pièces</td><td className="num muted small">{formatEur((b.landedUnitEur + assembly) * b.qty)}</td></tr>
      </tbody>
    </table>
  );
}

export function PriceChart({ points }: { points: { date: string; value: number }[] }) {
  const W = 520, H = 140, P = 28;
  if (points.length === 0) return null;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals) * 0.95, max = Math.max(...vals) * 1.05 || 1;
  const x = (i: number) => (points.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (points.length - 1));
  const y = (v: number) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
      {[0, 0.5, 1].map((t) => { const v = min + t * (max - min); return <g key={t}><line x1={P} x2={W - P} y1={y(v)} y2={y(v)} stroke="#e4e7ec" /><text x={P - 4} y={y(v) + 4} fontSize="9" fill="#6b7482" textAnchor="end">{v.toFixed(1)}</text></g>; })}
      <path d={path} fill="none" stroke="#1f5fd6" strokeWidth="2" />
      {points.map((p, i) => <g key={i}><circle cx={x(i)} cy={y(p.value)} r="4" fill="#1f5fd6" /><text x={x(i)} y={H - 6} fontSize="9" fill="#6b7482" textAnchor="middle">{fmtDate(p.date).slice(3)}</text><text x={x(i)} y={y(p.value) - 8} fontSize="10" fill="#1c2430" textAnchor="middle">{p.value.toFixed(2)} €</text></g>)}
    </svg>
  );
}
