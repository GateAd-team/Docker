import React, { useEffect, useState } from 'react';
import { Field, NumberInput, Select } from './ui';
import type { Currency, MarketPrice } from '../../shared/types';

const CURRENCIES: { value: Currency; label: string }[] = [{ value: 'EUR', label: 'EUR' }, { value: 'GBP', label: 'GBP' }, { value: 'USD', label: 'USD' }, { value: 'CNY', label: 'CNY' }];
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Prix de vente d'une marchandise sur un marché : saisie HT ou TTC (l'autre se recalcule avec la TVA), commission et livraison. */
export function MarketForm({ mp, onSave }: { mp: MarketPrice; onSave: (v: MarketPrice) => void }) {
  const [v, setV] = useState(mp);
  useEffect(() => setV(mp), [mp.id, mp.sellPrice, mp.vatPct, mp.platformFeePct, mp.lastMileCost, mp.currency]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(v) !== JSON.stringify(mp);
  const ht = r2(v.sellPrice / (1 + v.vatPct / 100));
  return (
    <div className="form c3">
      <Field label="Prix de vente HT"><NumberInput value={ht} onChange={(x) => setV({ ...v, sellPrice: r2(x * (1 + v.vatPct / 100)) })} /></Field>
      <Field label="Prix de vente TTC"><NumberInput value={v.sellPrice} onChange={(x) => setV({ ...v, sellPrice: x })} /></Field>
      <Field label="Devise"><Select value={v.currency} onChange={(x) => setV({ ...v, currency: x })} options={CURRENCIES} /></Field>
      <Field label="TVA / taxe"><NumberInput value={v.vatPct} onChange={(x) => setV({ ...v, vatPct: x })} unit="%" /></Field>
      <Field label="Commission plateforme"><NumberInput value={v.platformFeePct} onChange={(x) => setV({ ...v, platformFeePct: x })} unit="%" /></Field>
      <Field label="Livraison client"><NumberInput value={v.lastMileCost} onChange={(x) => setV({ ...v, lastMileCost: x })} /></Field>
      <Field label=""><button className="btn primary small" onClick={() => onSave(v)} disabled={!dirty}>Enregistrer</button></Field>
    </div>
  );
}
