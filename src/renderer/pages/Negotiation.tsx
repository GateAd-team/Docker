/**
 * Onglet Négociation d'une importation : pour chaque usine de l'arborescence, Bao prépare
 * la demande de prix (EN + 中文), lit les réponses (captures WeChat, PDF), propose les contre-offres
 * et enregistre les prix convenus dans l'historique. L'utilisateur garde l'envoi et la décision.
 */
import React, { useState } from 'react';
import { newId, today, useStore } from '../store';
import { useNav } from '../App';
import { api } from '../api';
import { useViewer } from '../components/Viewer';
import { Badge, ConfirmButton, Empty, Modal, Stars, fmtDate } from '../components/ui';
import type { Negotiation, NegotiationLine, Order, Project } from '../../shared/types';
import { explodeNeeds, includedInParentPrice } from '../../shared/importFlows';
import { bestCompetitor, buildCounterOffer, buildNegotiationLines, buildRfq, matchOffers, savingsUsd } from '../../shared/negotiation';
import { productSimilarity } from '../applyExtraction';
import { formatMoney } from '../../shared/finance';

const STATUS: Record<Negotiation['status'], { label: string; tone: '' | 'blue' | 'amber' | 'green' | 'red' }> = {
  a_lancer: { label: 'À lancer', tone: '' }, en_cours: { label: 'En cours', tone: 'amber' }, accord: { label: 'Accord', tone: 'green' }, abandon: { label: 'Abandonnée', tone: 'red' },
};

const usd = (n: number | null | undefined) => (n == null ? '—' : formatMoney(n, 'USD'));

export function NegotiationTab({ project, onCreateOrder }: { project: Project; onCreateOrder: (factoryId: string, lines: Order['lines']) => void }) {
  const { db, update, toast } = useStore();
  const { go } = useNav();
  const { open: openDoc } = useViewer();
  const [draft, setDraft] = useState<{ negId: string; title: string; text: string } | null>(null);
  const [reply, setReply] = useState<{ negId: string; text: string; offers: Record<string, string>; documentId: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Usines concernées : celles qui facturent quelque chose dans la liste de courses.
  const needs = explodeNeeds(db, project.contents).filter((n) => n.factoryId && !includedInParentPrice(db, n));
  const factoryIds = [...new Set(needs.map((n) => n.factoryId!))].filter((id) => db.factories.some((f) => f.id === id));
  const ctx = { db, project, sender: db.settings.senderName || 'Théo', company: db.settings.companyName || 'Wall Up' };

  const saveNeg = (neg: Negotiation) => update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, negotiations: p.negotiations.some((n) => n.id === neg.id) ? p.negotiations.map((n) => (n.id === neg.id ? neg : n)) : [...p.negotiations, neg] } : p)) }));
  const negFor = (factoryId: string): Negotiation => project.negotiations.find((n) => n.factoryId === factoryId) ?? { id: newId(), factoryId, status: 'a_lancer', lines: buildNegotiationLines(db, project, factoryId), messages: [], notes: '' };
  const refreshLines = (neg: Negotiation) => saveNeg({ ...neg, lines: buildNegotiationLines(db, project, neg.factoryId, neg) });
  const setLine = (neg: Negotiation, productId: string, patch: Partial<NegotiationLine>) => saveNeg({ ...neg, lines: neg.lines.map((l) => (l.productId === productId ? { ...l, ...patch } : l)) });
  const addMessage = (neg: Negotiation, from: 'moi' | 'usine', text: string, documentId: string | null = null, patch: Partial<Negotiation> = {}) =>
    saveNeg({ ...neg, ...patch, status: patch.status ?? (neg.status === 'a_lancer' ? 'en_cours' : neg.status), messages: [...neg.messages, { id: newId(), date: today(), from, text, documentId }] });

  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast('Message copié — colle-le dans WeChat'); } catch { toast('Impossible de copier : sélectionne le texte à la main', true); } };

  /** Lit une capture WeChat / un PDF de réponse : l'IA extrait les prix, on les associe aux lignes. */
  const readReply = async (neg: Negotiation) => {
    const docs = await api.importFiles();
    if (!docs.length) return;
    const doc = docs[0];
    setBusy(neg.id);
    try {
      update((d) => ({ ...d, documents: [...docs, ...d.documents], projects: d.projects.map((p) => (p.id === project.id ? { ...p, docLinks: [...p.docLinks, { documentId: doc.id, factoryId: neg.factoryId }] } : p)) }));
      const result = await api.extractDocument(doc.id);
      const data = result.data as { text?: string; prices?: { item: string; price: number; currency: string }[]; lines?: { productName?: string; description?: string; unitPrice?: number }[]; currency?: string };
      const prices = data.prices ?? (data.lines ?? []).map((l) => ({ item: l.productName || l.description || '', price: l.unitPrice ?? 0, currency: data.currency || 'USD' }));
      const matched = matchOffers(db, neg, prices, productSimilarity);
      const offers: Record<string, string> = {};
      for (const m of matched) offers[m.productId] = String(m.price);
      update((d) => ({ ...d, documents: d.documents.map((x) => (x.id === doc.id ? { ...x, kind: result.kind, extracted: result.data, summary: result.summary } : x)) }));
      setReply({ negId: neg.id, text: data.text || result.summary || '', offers, documentId: doc.id });
      if (!matched.length) toast("Aucun prix reconnu automatiquement : saisis-les à la main", true);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };

  const applyReply = () => {
    if (!reply) return;
    const neg = project.negotiations.find((n) => n.id === reply.negId) ?? negFor(factoryIds.find((id) => negFor(id).id === reply.negId) ?? '');
    const lines = neg.lines.map((l) => (reply.offers[l.productId] && Number(reply.offers[l.productId]) > 0 ? { ...l, offeredPrice: Number(reply.offers[l.productId]) } : l));
    addMessage({ ...neg, lines }, 'usine', reply.text || 'Réponse reçue (prix mis à jour).', reply.documentId);
    setReply(null); toast('Offre enregistrée');
  };

  const agree = (neg: Negotiation) => {
    const lines = neg.lines.map((l) => ({ ...l, agreedPrice: l.agreedPrice ?? l.offeredPrice ?? l.targetPrice ?? l.lastPrice }));
    const quotes = lines.filter((l) => l.agreedPrice != null).map((l) => ({ id: newId(), productId: l.productId, factoryId: neg.factoryId, date: today(), unitPrice: l.agreedPrice!, currency: 'USD' as const, moq: l.qty, incoterm: 'FOB' as const, leadTimeDays: 0, documentId: null, notes: `Prix négocié — importation « ${project.name} »` }));
    update((d) => ({ ...d, quotes: [...d.quotes, ...quotes], projects: d.projects.map((p) => (p.id === project.id ? { ...p, negotiations: p.negotiations.some((n) => n.id === neg.id) ? p.negotiations.map((n) => (n.id === neg.id ? { ...neg, lines, status: 'accord' as const } : n)) : [...p.negotiations, { ...neg, lines, status: 'accord' as const }] } : p)) }));
    toast(`Accord enregistré : ${quotes.length} prix ajouté${quotes.length > 1 ? 's' : ''} à l'historique`);
  };

  if (factoryIds.length === 0) return <div className="card"><Empty icon="🤝" title="Rien à négocier pour l'instant" text="Remplis d'abord la liste de courses (onglet Arborescence des flux) : Bao en déduit les usines à consulter et prépare les demandes de prix." /></div>;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div><h2>Négociation assistée</h2><div className="small muted">Bao rédige les demandes de prix et les contre-offres (anglais + chinois), lit les réponses WeChat en capture d'écran et te propose le prochain coup. Toi, tu copies-colles et tu décides.</div></div>
          <div className="row-flex small">
            <label className="muted">Signature</label>
            <input value={db.settings.senderName} placeholder="Prénom" onChange={(e) => update((d) => ({ ...d, settings: { ...d.settings, senderName: e.target.value } }))} style={{ width: 90 }} />
            <input value={db.settings.companyName} placeholder="Société" onChange={(e) => update((d) => ({ ...d, settings: { ...d.settings, companyName: e.target.value } }))} style={{ width: 110 }} />
          </div>
        </div>
        <div className="small muted">{factoryIds.length} usine{factoryIds.length > 1 ? 's' : ''} à consulter · économie potentielle si toutes les cibles sont atteintes : <b>{usd(factoryIds.reduce((t, id) => { const n = negFor(id); return t + n.lines.reduce((s, l) => s + ((l.lastPrice ?? 0) - (l.targetPrice ?? l.lastPrice ?? 0)) * l.qty, 0); }, 0))}</b></div>
      </div>

      {factoryIds.map((factoryId) => {
        const factory = db.factories.find((f) => f.id === factoryId)!;
        const neg = negFor(factoryId);
        const st = STATUS[neg.status];
        const hasOffer = neg.lines.some((l) => l.offeredPrice != null);
        const above = neg.lines.filter((l) => l.offeredPrice != null && l.targetPrice != null && l.offeredPrice > l.targetPrice).length;
        const total = (key: 'lastPrice' | 'targetPrice' | 'offeredPrice' | 'agreedPrice') => neg.lines.reduce((t, l) => t + (l[key] ?? 0) * l.qty, 0);
        const contact = db.contacts.find((c) => c.ownerType === 'factory' && c.ownerId === factoryId);
        return (
          <div key={factoryId} className="card neg-card">
            <div className="card-head">
              <div>
                <h2 style={{ cursor: 'pointer' }} onClick={() => go('factories', factoryId)}>{factory.name} <Stars value={factory.rating} size={12} /></h2>
                <div className="small muted">{[contact && `${contact.name}${contact.wechat ? ` · WeChat ${contact.wechat}` : ''}`, factory.wechat && !contact?.wechat && `WeChat ${factory.wechat}`, factory.email].filter(Boolean).join(' · ') || 'Aucun contact enregistré'}</div>
              </div>
              <div className="row-flex">
                <Badge tone={st.tone}>{st.label}</Badge>
                {neg.status === 'accord' && savingsUsd(neg) !== 0 && <Badge tone={savingsUsd(neg) > 0 ? 'green' : 'red'}>{savingsUsd(neg) > 0 ? '−' : '+'}{usd(Math.abs(savingsUsd(neg)))} vs dernier prix</Badge>}
              </div>
            </div>

            <table className="tbl small">
              <thead><tr><th>Référence</th><th className="num">Qté</th><th className="num">Dernier prix</th><th className="num">Concurrence</th><th className="num">Cible</th><th className="num">Offre reçue</th><th className="num">Convenu</th></tr></thead>
              <tbody>{neg.lines.map((l) => {
                const p = db.products.find((x) => x.id === l.productId);
                const comp = bestCompetitor(db, l.productId, factoryId);
                const tone = l.offeredPrice == null || l.targetPrice == null ? undefined : l.offeredPrice <= l.targetPrice ? 'var(--ok)' : l.lastPrice != null && l.offeredPrice > l.lastPrice ? 'var(--bad)' : 'var(--warn)';
                return (
                  <tr key={l.productId}>
                    <td><b style={{ cursor: 'pointer' }} onClick={() => go('merchandise', l.productId)}>{p?.name ?? '?'}</b>{p?.supplierName ? <div className="muted">{p.supplierName}</div> : null}</td>
                    <td className="num">{l.qty}</td>
                    <td className="num">{usd(l.lastPrice)}</td>
                    <td className="num">{comp ? <span title={`${comp.name} · ${fmtDate(comp.date)}`} style={{ color: l.lastPrice != null && comp.price < l.lastPrice ? 'var(--ok)' : undefined }}>{usd(comp.price)}<div className="muted" style={{ fontSize: 10 }}>{comp.name.split(' ').slice(0, 2).join(' ')}</div></span> : <span className="muted">—</span>}</td>
                    <td className="num"><input type="number" step="0.01" value={l.targetPrice ?? ''} placeholder="—" onChange={(e) => setLine(neg, l.productId, { targetPrice: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 84, textAlign: 'right' }} /></td>
                    <td className="num"><input type="number" step="0.01" value={l.offeredPrice ?? ''} placeholder="—" onChange={(e) => setLine(neg, l.productId, { offeredPrice: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 84, textAlign: 'right', color: tone, fontWeight: tone ? 600 : undefined }} /></td>
                    <td className="num"><input type="number" step="0.01" value={l.agreedPrice ?? ''} placeholder="—" onChange={(e) => setLine(neg, l.productId, { agreedPrice: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 84, textAlign: 'right' }} /></td>
                  </tr>
                );
              })}
              <tr className="total"><td>Total</td><td /><td className="num">{usd(total('lastPrice'))}</td><td /><td className="num">{usd(total('targetPrice'))}</td><td className="num">{hasOffer ? usd(total('offeredPrice')) : '—'}</td><td className="num">{neg.lines.some((l) => l.agreedPrice != null) ? usd(total('agreedPrice')) : '—'}</td></tr>
              </tbody>
            </table>

            <div className="row-flex mt" style={{ flexWrap: 'wrap' }}>
              <button className="btn primary small" onClick={() => setDraft({ negId: neg.id, title: `Demande de prix — ${factory.name}`, text: buildRfq({ ...ctx, neg }) })}>✉ Préparer la demande de prix</button>
              <button className="btn small" disabled={busy === neg.id} onClick={() => readReply(neg)}>{busy === neg.id ? <><span className="spinner" /> Lecture…</> : '📸 Lire une réponse (capture / PDF)'}</button>
              <button className="btn small" onClick={() => setReply({ negId: neg.id, text: '', offers: Object.fromEntries(neg.lines.map((l) => [l.productId, l.offeredPrice != null ? String(l.offeredPrice) : ''])), documentId: null })}>✎ Saisir une réponse</button>
              {hasOffer && above > 0 && <button className="btn small" onClick={() => setDraft({ negId: neg.id, title: `Contre-offre — ${factory.name}`, text: buildCounterOffer({ ...ctx, neg }) })}>💡 Contre-offre ({above} ligne{above > 1 ? 's' : ''} au-dessus de la cible)</button>}
              {neg.status !== 'accord' && <ConfirmButton label="✔ Accord à ces prix" className="btn small" onConfirm={() => agree(neg)} />}
              {neg.status === 'accord' && <button className="btn small" onClick={() => onCreateOrder(factoryId, neg.lines.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.agreedPrice ?? l.offeredPrice ?? 0, currency: 'USD' as const })))}>📝 Créer la commande aux prix convenus</button>}
              <span style={{ flex: 1 }} />
              <button className="btn ghost small" title="Recalcule les quantités depuis la liste de courses (garde cibles et offres)" onClick={() => refreshLines(neg)}>⟳ Quantités</button>
              {neg.status !== 'abandon' ? <button className="btn ghost small" onClick={() => saveNeg({ ...neg, status: 'abandon' })}>Abandonner</button> : <button className="btn ghost small" onClick={() => saveNeg({ ...neg, status: 'en_cours' })}>Reprendre</button>}
            </div>

            {neg.messages.length > 0 && (
              <div className="neg-thread">
                {neg.messages.map((m) => (
                  <div key={m.id} className={`neg-msg ${m.from}`}>
                    <div className="meta">{m.from === 'moi' ? `${ctx.sender} → ${factory.name.split(' ')[0]}` : `${factory.name.split(' ')[0]} → ${ctx.sender}`} · {fmtDate(m.date)}{m.documentId && <> · <a style={{ cursor: 'pointer' }} onClick={() => openDoc(m.documentId!)}>📄 capture</a></>}<span style={{ flex: 1 }} /><button className="btn ghost small" onClick={() => saveNeg({ ...neg, messages: neg.messages.filter((x) => x.id !== m.id) })}>✕</button></div>
                    <div className="text">{m.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {draft && (
        <Modal title={draft.title} onClose={() => setDraft(null)} wide footer={<><button className="btn" onClick={() => setDraft(null)}>Fermer</button><span style={{ flex: 1 }} /><button className="btn" onClick={() => copy(draft.text)}>📋 Copier</button><button className="btn primary" onClick={() => { const neg = project.negotiations.find((n) => n.id === draft.negId) ?? factoryIds.map(negFor).find((n) => n.id === draft.negId)!; addMessage(neg, 'moi', draft.text); copy(draft.text); setDraft(null); }}>📋 Copier et marquer comme envoyé</button></>}>
          <div className="small muted mb">Relis, ajuste si besoin, puis colle dans WeChat (ou par email). Le message est en anglais puis en chinois ; garde les deux ou supprime une langue.</div>
          <textarea value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} style={{ width: '100%', minHeight: 320, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.45 }} />
        </Modal>
      )}

      {reply && (() => {
        const neg = project.negotiations.find((n) => n.id === reply.negId) ?? factoryIds.map(negFor).find((n) => n.id === reply.negId);
        if (!neg) return null;
        return (
          <Modal title="Réponse de l'usine" onClose={() => setReply(null)} footer={<><button className="btn" onClick={() => setReply(null)}>Annuler</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={applyReply}>Enregistrer l'offre</button></>}>
            <div className="small muted mb">{reply.documentId ? 'Prix lus dans la capture — vérifie et corrige avant d\'enregistrer.' : 'Saisis les prix proposés par l\'usine (USD / unité).'}</div>
            <table className="tbl small">
              <thead><tr><th>Référence</th><th className="num">Cible</th><th className="num">Offre (USD)</th></tr></thead>
              <tbody>{neg.lines.map((l) => (
                <tr key={l.productId}>
                  <td>{db.products.find((p) => p.id === l.productId)?.name}</td>
                  <td className="num muted">{usd(l.targetPrice)}</td>
                  <td className="num"><input type="number" step="0.01" value={reply.offers[l.productId] ?? ''} onChange={(e) => setReply({ ...reply, offers: { ...reply.offers, [l.productId]: e.target.value } })} style={{ width: 100, textAlign: 'right' }} /></td>
                </tr>
              ))}</tbody>
            </table>
            <div className="mt"><div className="small muted">Résumé / texte de la réponse (facultatif)</div><textarea value={reply.text} onChange={(e) => setReply({ ...reply, text: e.target.value })} style={{ width: '100%', minHeight: 80 }} placeholder="Ex. : OK pour 25 USD si 400 pcs, délai 35 jours." /></div>
          </Modal>
        );
      })()}
    </>
  );
}
