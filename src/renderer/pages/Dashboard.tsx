import React from 'react';
import { useStore } from '../store';
import { useNav } from '../App';
import { Badge, Empty, Stat, fmtDate, daysUntil } from '../components/ui';
import { ORDER_STATUS, SHIPMENT_STATUS, statusOf } from '../labels';
import { formatEur, orderTotalEur, shipmentTotalEur, unitCost, computeMargin } from '../../shared/finance';

export function Dashboard() {
  const { db } = useStore();
  const { go } = useNav();

  const activeOrders = db.orders.filter((o) => !['livree', 'devis'].includes(o.status));
  const activeShipments = db.shipments.filter((s) => s.status !== 'livree');
  const inbox = db.documents.filter((d) => !d.extracted);
  const committed = activeOrders.reduce((s, o) => s + orderTotalEur(o, db.settings), 0);
  const logistics = activeShipments.reduce((s, x) => s + shipmentTotalEur(x, db.settings), 0);

  const upcoming = [
    ...activeOrders.filter((o) => o.expectedReadyDate).map((o) => ({ date: o.expectedReadyDate, label: `Fin de production · ${o.reference || 'commande'}`, sub: db.factories.find((f) => f.id === o.factoryId)?.name ?? '', go: () => go('factories', o.factoryId) })),
    ...activeShipments.filter((s) => s.eta).map((s) => ({ date: s.eta, label: `Arrivée · ${s.reference}`, sub: statusOf(SHIPMENT_STATUS, s.status).label, go: () => go('logistics', s.id) })),
  ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);

  const marginRows = db.products.map((p) => {
    const ref = unitCost(p.id, db);
    const fr = db.marketPrices.find((m) => m.productId === p.id && m.market === 'FR');
    const m = ref && fr ? computeMargin(ref.costEur, fr, db.settings) : null;
    return { p, ref, m };
  }).filter((r) => r.ref && r.m).slice(0, 6);

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Tableau de bord</h1><div className="sub">Vue d'ensemble de tes importations.</div></div>
        <div className="actions"><button className="btn primary" onClick={() => go('documents')}>⇩ Importer des documents</button></div>
      </div>

      <div className="grid c4 mb">
        <Stat label="Références au catalogue" value={db.products.length} hint={`${db.folders.length} dossier${db.folders.length > 1 ? 's' : ''}`} />
        <Stat label="Commandes en cours" value={activeOrders.length} hint={`${formatEur(committed, 0)} engagés`} />
        <Stat label="Expéditions en cours" value={activeShipments.length} hint={`${formatEur(logistics, 0)} de logistique`} />
        <Stat label="Documents à traiter" value={inbox.length} hint={inbox.length ? 'En attente de lecture' : 'Tout est à jour'} />
      </div>

      <div className="grid c2">
        <div className="card">
          <div className="card-head"><h2>Prochaines échéances</h2></div>
          {upcoming.length === 0 ? <Empty icon="📅" title="Aucune échéance" text="Les dates de fin de production et d'arrivée apparaîtront ici." /> : (
            <div className="list">
              {upcoming.map((u, i) => {
                const d = daysUntil(u.date);
                return (
                  <div className="row" key={i} onClick={u.go}>
                    <div><div className="title">{u.label}</div><div className="meta">{u.sub}</div></div>
                    <div className="right"><div>{fmtDate(u.date)}</div><div className="meta">{d == null ? '' : d < 0 ? <span style={{ color: 'var(--bad)' }}>en retard de {-d} j</span> : d === 0 ? "aujourd'hui" : `dans ${d} j`}</div></div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h2>Catalogue</h2><button className="btn small" onClick={() => go('merchandise')}>Tout voir</button></div>
          {db.products.length === 0 ? <Empty icon="▦" title="Aucune référence" text="Crée ta première référence dans Marchandise." action={<button className="btn primary" onClick={() => go('merchandise')}>Ouvrir Marchandise</button>} /> : (
            <div className="list">
              {db.products.filter((p) => !db.products.some((x) => x.components.some((c) => c.productId === p.id))).slice(0, 6).map((p) => {
                const cost = unitCost(p.id, db);
                return (
                  <div className="row" key={p.id} onClick={() => go('merchandise', p.id)}>
                    <div><div className="title">{p.name}</div><div className="meta">{p.components.length ? `${p.components.length} sous-références` : db.factories.find((f) => f.id === p.factoryId)?.name ?? 'référence simple'}</div></div>
                    <div className="right">{cost ? formatEur(cost.costEur) : <span className="muted">—</span>}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h2>Commandes en cours</h2><button className="btn small" onClick={() => go('factories')}>Usines</button></div>
          {activeOrders.length === 0 ? <Empty icon="⚙" title="Aucune commande en cours" /> : (
            <table className="tbl">
              <thead><tr><th>Réf.</th><th>Usine</th><th>Statut</th><th className="num">Montant</th></tr></thead>
              <tbody>
                {activeOrders.map((o) => {
                  const st = statusOf(ORDER_STATUS, o.status);
                  return (
                    <tr key={o.id} className="click" onClick={() => go('factories', o.factoryId, o.id)}>
                      <td className="strong">{o.reference || '—'}</td>
                      <td>{db.factories.find((f) => f.id === o.factoryId)?.name ?? '—'}</td>
                      <td><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td className="num">{formatEur(orderTotalEur(o, db.settings), 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h2>Marges (France)</h2><button className="btn small" onClick={() => go('finance')}>Finance</button></div>
          {marginRows.length === 0 ? <Empty icon="€" title="Pas encore de coût de revient" text="Ajoute une commande ou un devis pour un produit." /> : (
            <table className="tbl">
              <thead><tr><th>Produit</th><th className="num">Coût de revient</th><th className="num">Marge</th></tr></thead>
              <tbody>
                {marginRows.map(({ p, ref, m }) => (
                  <tr key={p.id} className="click" onClick={() => go('finance', p.id)}>
                    <td className="strong">{p.name}</td>
                    <td className="num">{formatEur(ref!.costEur)}</td>
                    <td className="num">{m ? <Badge tone={m.marginPct >= 40 ? 'green' : m.marginPct >= 20 ? 'amber' : 'red'}>{m.marginPct.toFixed(0)} %</Badge> : <span className="muted">prix de vente ?</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
