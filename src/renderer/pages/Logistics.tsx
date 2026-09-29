import React, { useEffect, useState } from 'react';
import { newId, useStore } from '../store';
import { useNav } from '../App';
import { Badge, ConfirmButton, Empty, Field, Input, Modal, NumberInput, Select, Tabs, Textarea, Timeline, fmtDate, daysUntil } from '../components/ui';
import { MODE_LABELS, SHIPMENT_STATUS, statusOf } from '../labels';
import { KIND_LABELS } from '../../shared/extraction';
import { api } from '../api';
import { useViewer } from '../components/Viewer';
import type { Contact, Currency, MailMessage, Partner, Shipment } from '../../shared/types';
import { formatEur, formatMoney, lineCbm, orderTotalEur, shipmentTotalEur } from '../../shared/finance';
import { MailsTab } from './Mails';
import { findDuplicateShipments, mergeShipmentsInDb, removeShipmentFromDb } from '../../shared/mailAnalysis';

const CURRENCIES: { value: Currency; label: string }[] = [{ value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }, { value: 'CNY', label: 'CNY' }, { value: 'GBP', label: 'GBP' }];

export function LogisticsPage() {
  const { db, update, toast } = useStore();
  const { nav, go } = useNav();
  const [tab, setTab] = useState<'expeditions' | 'partenaires' | 'emails'>('expeditions');
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [partner, setPartner] = useState<Partner | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);

  useEffect(() => { if (nav.id) { const s = db.shipments.find((x) => x.id === nav.id); if (s) setShipment(s); } }, [nav.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (nav.sub === 'emails' || nav.sub === 'partenaires' || nav.sub === 'expeditions') setTab(nav.sub); }, [nav.sub]);

  const shipments = [...db.shipments].sort((a, b) => (b.etd || '').localeCompare(a.etd || ''));
  const transporters = db.partners.filter((p) => p.type === 'transporteur');
  const agents = db.partners.filter((p) => p.type === 'agent');

  const blankShipment = (): Shipment => ({ id: newId(), projectId: null, reference: '', orderIds: [], partnerId: transporters[0]?.id ?? null, agentId: null, mode: 'mer', incoterm: 'FOB', status: 'planifiee', etd: '', eta: '', cbm: 0, weightKg: 0, freightCost: 0, insuranceCost: 0, originFees: 0, destinationFees: 0, currency: 'USD', trackingRef: '', documentId: null, notes: '' });
  const saveShipment = () => { if (!shipment) return; update((d) => ({ ...d, shipments: d.shipments.some((x) => x.id === shipment.id) ? d.shipments.map((x) => (x.id === shipment.id ? shipment : x)) : [...d.shipments, shipment] })); setShipment(null); toast('Expédition enregistrée'); };
  const savePartner = () => { if (!partner?.name.trim()) return; update((d) => ({ ...d, partners: d.partners.some((x) => x.id === partner.id) ? d.partners.map((x) => (x.id === partner.id ? partner : x)) : [...d.partners, partner] })); setPartner(null); };
  const saveContact = () => { if (!contact?.name.trim()) return; update((d) => ({ ...d, contacts: d.contacts.some((c) => c.id === contact.id) ? d.contacts.map((c) => (c.id === contact.id ? contact : c)) : [...d.contacts, contact] })); setContact(null); };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Logistique</h1><div className="sub">Expéditions, transporteurs et agents qui font le lien avec les usines.</div></div>
        <div className="actions">
          <button className="btn" onClick={() => setPartner({ id: newId(), type: 'transporteur', name: '', city: '', email: '', phone: '', wechat: '', services: '', notes: '', insights: { summary: '', actions: [], analyzedAt: '' } })}>+ Transporteur / agent</button>
          <button className="btn primary" onClick={() => setShipment(blankShipment())}>+ Expédition</button>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'expeditions', label: `Expéditions (${shipments.length})` }, { value: 'partenaires', label: `Transporteurs & agents (${db.partners.length})` }, { value: 'emails', label: `Emails (${db.mails.length}${db.mails.filter((m) => !m.read).length ? ` · ${db.mails.filter((m) => !m.read).length} non lus` : ''})` }]} />
      {tab === 'emails' && <MailsTab />}

      {tab === 'expeditions' && (() => { const dups = findDuplicateShipments(db.shipments); return dups.length > 0 && (
        <div className="card mb" style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)' }}>
          <b>⚠️ Doublons probables</b> <span className="small muted">— même n° de conteneur / suivi ou même référence. La fusion garde la première, complète ses champs vides avec la seconde, réunit commandes, emails et documents, et garde le statut le plus avancé.</span>
          {dups.map(([a, b]) => (
            <div key={`${a.id}-${b.id}`} className="row-flex small mt" style={{ gap: 8, flexWrap: 'wrap' }}>
              <b>{a.reference || 'Expédition'}</b> <span className="muted">({statusOf(SHIPMENT_STATUS, a.status).label}{a.trackingRef ? ` · ${a.trackingRef}` : ''})</span>
              <span className="muted">≈</span>
              <b>{b.reference || 'Expédition'}</b> <span className="muted">({statusOf(SHIPMENT_STATUS, b.status).label}{b.trackingRef ? ` · ${b.trackingRef}` : ''})</span>
              <span style={{ flex: 1 }} />
              <button className="btn small" onClick={() => { update((d) => mergeShipmentsInDb(d, a.id, b.id)); toast('Expéditions fusionnées'); }}>⇢ Fusionner dans « {a.reference || 'la première'} »</button>
              <button className="btn small" onClick={() => { update((d) => mergeShipmentsInDb(d, b.id, a.id)); toast('Expéditions fusionnées'); }}>⇢ Fusionner dans « {b.reference || 'la seconde'} »</button>
            </div>
          ))}
        </div>
      ); })()}
      {tab === 'expeditions' && (shipments.length === 0 ? <div className="card"><Empty icon="⛴" title="Aucune expédition" text="Regroupe une ou plusieurs commandes dans une expédition pour suivre le transport et répartir ses coûts." /></div> : shipments.map((s) => {
        const st = statusOf(SHIPMENT_STATUS, s.status);
        const orders = db.orders.filter((o) => s.orderIds.includes(o.id));
        const project = db.projects.find((p) => p.id === s.projectId);
        const partner = db.partners.find((p) => p.id === s.partnerId);
        const agent = db.partners.find((p) => p.id === s.agentId);
        const eta = daysUntil(s.eta);
        return (
          <div className="card" key={s.id} style={{ cursor: 'pointer' }} onClick={() => setShipment(s)}>
            <div className="card-head">
              <h2>{s.reference || 'Expédition'} <span className="muted small">· {MODE_LABELS[s.mode]} · {s.incoterm}</span></h2>
              <div className="row-flex">{project && <span title="Ouvrir l'importation" onClick={(e) => { e.stopPropagation(); go('projects', project.id); }}><Badge tone="blue">📦 {project.name}</Badge></span>}<Badge tone={st.tone}>{st.label}</Badge><b>{formatEur(shipmentTotalEur(s, db.settings))}</b><span onClick={(e) => e.stopPropagation()}><ConfirmButton label="🗑" className="btn ghost small" onConfirm={() => { update((d) => removeShipmentFromDb(d, s.id)); toast('Expédition supprimée'); }} /></span></div>
            </div>
            <Timeline steps={SHIPMENT_STATUS} current={s.status} />
            <div className="grid c4 mt small">
              <div><span className="muted">Départ</span><br />{fmtDate(s.etd)}</div>
              <div><span className="muted">Arrivée prévue</span><br />{fmtDate(s.eta)}{eta != null && s.status !== 'livree' ? <span className="muted"> ({eta < 0 ? `retard ${-eta} j` : `dans ${eta} j`})</span> : null}</div>
              <div><span className="muted">Transporteur</span><br />{partner?.name ?? '—'}{agent ? <><br /><span className="muted">Agent : </span>{agent.name}</> : null}</div>
              <div><span className="muted">Contenu</span><br />{orders.map((o) => `${o.reference || 'commande'} (${db.factories.find((f) => f.id === o.factoryId)?.name?.split(' ')[0] ?? ''})`).join(', ') || '—'}<br /><span className="muted">{s.cbm ? `${s.cbm} m³` : ''}{s.weightKg ? ` · ${s.weightKg} kg` : ''}{s.trackingRef ? ` · ${s.trackingRef}` : ''}</span></div>
            </div>
          </div>
        );
      }))}

      {tab === 'partenaires' && (
        <div className="grid c2">
          {[{ title: 'Transporteurs', list: transporters, type: 'transporteur' as const }, { title: 'Agents en Chine', list: agents, type: 'agent' as const }].map((grp) => (
            <div className="card" key={grp.type}>
              <div className="card-head"><h2>{grp.title}</h2><button className="btn small" onClick={() => setPartner({ id: newId(), type: grp.type, name: '', city: '', email: '', phone: '', wechat: '', services: '', notes: '', insights: { summary: '', actions: [], analyzedAt: '' } })}>+ Ajouter</button></div>
              {grp.list.length === 0 ? <div className="muted small">Aucun.</div> : grp.list.map((p) => {
                const contacts = db.contacts.filter((c) => c.ownerType === 'partner' && c.ownerId === p.id);
                const n = db.shipments.filter((s) => s.partnerId === p.id || s.agentId === p.id).length;
                return (
                  <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                    <div className="row-flex"><b style={{ cursor: 'pointer' }} onClick={() => setPartner(p)}>{p.name}</b><span className="muted small">{p.city}</span><span style={{ flex: 1 }} /><Badge>{n} expédition{n > 1 ? 's' : ''}</Badge></div>
                    <div className="small muted">{p.services}</div>
                    <div className="small">{[p.email, p.phone, p.wechat && `WeChat ${p.wechat}`].filter(Boolean).join(' · ')}</div>
                    {(p.insights.summary || p.insights.actions.some((a) => !a.done)) && (
                      <div className="insights small" style={{ margin: '6px 0' }}>
                        {p.insights.summary && <div style={{ whiteSpace: 'pre-wrap' }}>{p.insights.summary}</div>}
                        {p.insights.actions.filter((a) => !a.done).length > 0 && <div className="mt"><b>À faire</b>{p.insights.actions.filter((a) => !a.done).map((a) => <label key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}><input type="checkbox" checked={a.done} onChange={() => update((d) => ({ ...d, partners: d.partners.map((x) => (x.id === p.id ? { ...x, insights: { ...x.insights, actions: x.insights.actions.map((y) => (y.id === a.id ? { ...y, done: true } : y)) } } : x)) }))} /><span>{a.text}{a.dueDate ? <span className="muted"> · {fmtDate(a.dueDate)}</span> : null}</span></label>)}</div>}
                        <div className="muted" style={{ fontSize: 11 }}>Bilan IA des emails · {fmtDate(p.insights.analyzedAt.slice(0, 10))} · <a style={{ cursor: 'pointer' }} onClick={() => setTab('emails')}>voir les emails</a></div>
                      </div>
                    )}
                    {contacts.map((c) => <div key={c.id} className="small" style={{ cursor: 'pointer' }} onClick={() => setContact(c)}>👤 {c.name}{c.role ? ` · ${c.role}` : ''} <span className="muted">{[c.email, c.phone, c.wechat].filter(Boolean).join(' · ')}</span></div>)}
                    <button className="btn ghost small" onClick={() => setContact({ id: newId(), ownerType: 'partner', ownerId: p.id, name: '', role: '', email: '', phone: '', wechat: '', whatsapp: '' })}>+ contact</button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {shipment && <ShipmentModal shipment={shipment} onChange={setShipment} onClose={() => { setShipment(null); if (nav.id) go('logistics'); }} onSave={saveShipment} />}

      {partner && (
        <Modal title={partner.type === 'agent' ? 'Agent' : 'Transporteur'} onClose={() => setPartner(null)} footer={<>{db.partners.some((x) => x.id === partner.id) && <ConfirmButton label="Supprimer" onConfirm={() => { update((d) => ({ ...d, partners: d.partners.filter((x) => x.id !== partner.id) })); setPartner(null); }} />}<span style={{ flex: 1 }} /><button className="btn" onClick={() => setPartner(null)}>Annuler</button><button className="btn primary" onClick={savePartner}>Enregistrer</button></>}>
          <div className="form c3">
            <Field label="Nom" span={2}><Input value={partner.name} onChange={(v) => setPartner({ ...partner, name: v })} /></Field>
            <Field label="Type"><Select value={partner.type} onChange={(v) => setPartner({ ...partner, type: v })} options={[{ value: 'transporteur', label: 'Transporteur' }, { value: 'agent', label: 'Agent en Chine' }]} /></Field>
            <Field label="Ville"><Input value={partner.city} onChange={(v) => setPartner({ ...partner, city: v })} /></Field>
            <Field label="Email"><Input value={partner.email} onChange={(v) => setPartner({ ...partner, email: v })} /></Field>
            <Field label="Téléphone"><Input value={partner.phone} onChange={(v) => setPartner({ ...partner, phone: v })} /></Field>
            <Field label="WeChat"><Input value={partner.wechat} onChange={(v) => setPartner({ ...partner, wechat: v })} /></Field>
            <Field label="Services" span={2}><Input value={partner.services} onChange={(v) => setPartner({ ...partner, services: v })} placeholder="FCL/LCL, dédouanement, QC, consolidation…" /></Field>
            <Field label="Notes" span={3}><Textarea value={partner.notes} onChange={(v) => setPartner({ ...partner, notes: v })} /></Field>
          </div>
        </Modal>
      )}

      {contact && (
        <Modal title="Contact" onClose={() => setContact(null)} footer={<>{db.contacts.some((c) => c.id === contact.id) && <ConfirmButton label="Supprimer" onConfirm={() => { update((d) => ({ ...d, contacts: d.contacts.filter((c) => c.id !== contact.id) })); setContact(null); }} />}<span style={{ flex: 1 }} /><button className="btn" onClick={() => setContact(null)}>Annuler</button><button className="btn primary" onClick={saveContact}>Enregistrer</button></>}>
          <div className="form c2">
            <Field label="Nom"><Input value={contact.name} onChange={(v) => setContact({ ...contact, name: v })} /></Field>
            <Field label="Rôle"><Input value={contact.role} onChange={(v) => setContact({ ...contact, role: v })} /></Field>
            <Field label="Email"><Input value={contact.email} onChange={(v) => setContact({ ...contact, email: v })} /></Field>
            <Field label="Téléphone"><Input value={contact.phone} onChange={(v) => setContact({ ...contact, phone: v })} /></Field>
            <Field label="WeChat"><Input value={contact.wechat} onChange={(v) => setContact({ ...contact, wechat: v })} /></Field>
            <Field label="WhatsApp"><Input value={contact.whatsapp} onChange={(v) => setContact({ ...contact, whatsapp: v })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function ShipmentModal({ shipment, onChange, onClose, onSave }: { shipment: Shipment; onChange: (s: Shipment) => void; onClose: () => void; onSave: () => void }) {
  const { db, update, toast } = useStore();
  const { open: openDoc } = useViewer();
  const [importing, setImporting] = useState<string | null>(null);
  const exists = db.shipments.some((x) => x.id === shipment.id);
  // Documents liés : rattachés à l'expédition, document de transport choisi, et pièces jointes des emails de l'expédition.
  const linkedMails = db.mails.filter((m) => m.shipmentId === shipment.id).sort((a, b) => b.date.localeCompare(a.date));
  const linkedDocs = db.documents.filter((d) => d.id === shipment.documentId || d.linkedTo.some((l) => l.type === 'shipment' && l.id === shipment.id) || linkedMails.some((m) => m.attachments.some((a) => a.documentId === d.id)));
  const pendingAttachments = linkedMails.flatMap((m) => m.attachments.filter((a) => !a.documentId && /pdf|image/i.test(a.mimeType || a.filename)).map((a) => ({ m, a })));
  const importAttachment = async (m: MailMessage, index: number) => {
    setImporting(`${m.id}:${index}`);
    try {
      const doc = await api.mailAttachment(m.id, index);
      if (!doc) { toast(api.isDemo ? 'Mode démo : import des pièces jointes indisponible' : 'Pièce jointe introuvable', true); return; }
      const linked = [...doc.linkedTo, ...(m.partnerId ? [{ type: 'partner' as const, id: m.partnerId }] : []), { type: 'shipment' as const, id: shipment.id }];
      update((d) => ({ ...d, documents: [{ ...doc, linkedTo: linked }, ...d.documents], mails: d.mails.map((x) => (x.id === m.id ? { ...x, attachments: x.attachments.map((a) => (a.index === index ? { ...a, documentId: doc.id } : a)) } : x)) }));
      toast(`« ${doc.fileName} » ajouté aux documents de l'expédition`);
    } catch (e) { toast((e as Error).message, true); } finally { setImporting(null); }
  };
  const others = db.shipments.filter((x) => x.id !== shipment.id);
  const [mergeFrom, setMergeFrom] = useState('');
  const transporters = db.partners.filter((p) => p.type === 'transporteur');
  const agents = db.partners.filter((p) => p.type === 'agent');
  const candidateOrders = db.orders.filter((o) => shipment.orderIds.includes(o.id) || !db.shipments.some((s) => s.id !== shipment.id && s.orderIds.includes(o.id)));
  const toggleOrder = (id: string) => onChange({ ...shipment, orderIds: shipment.orderIds.includes(id) ? shipment.orderIds.filter((x) => x !== id) : [...shipment.orderIds, id] });
  const included = db.orders.filter((o) => shipment.orderIds.includes(o.id));
  const goodsEur = included.reduce((s, o) => s + orderTotalEur(o, db.settings), 0);
  const estCbm = included.reduce((s, o) => s + o.lines.reduce((t, l) => t + lineCbm(db.products.find((p) => p.id === l.productId), l.qty), 0), 0);
  const total = shipmentTotalEur(shipment, db.settings);
  const set = <K extends keyof Shipment>(k: K) => (v: Shipment[K]) => onChange({ ...shipment, [k]: v });

  return (
    <Modal title={exists ? `Expédition ${shipment.reference}` : 'Nouvelle expédition'} onClose={onClose} wide
      footer={<>{exists && <ConfirmButton label="Supprimer" onConfirm={() => { update((d) => removeShipmentFromDb(d, shipment.id)); onClose(); }} />}{exists && others.length > 0 && (mergeFrom ? (() => { const o = others.find((x) => x.id === mergeFrom); return o ? <span className="row-flex small" style={{ gap: 6 }}><span>Fusionner « {o.reference || o.id} » ici ? Elle sera supprimée après transfert de ses infos.</span><button className="btn small primary" onClick={() => { update((d) => mergeShipmentsInDb(d, shipment.id, o.id)); setMergeFrom(''); onClose(); }}>Oui, fusionner</button><button className="btn small" onClick={() => setMergeFrom('')}>Annuler</button></span> : null; })() : <select className="btn small" value="" title="Fusionner une autre expédition dans celle-ci : ses infos complètent les champs vides, ses commandes, emails et documents sont rapatriés, puis elle est supprimée" onChange={(e) => setMergeFrom(e.target.value)}><option value="">⇢ Fusionner une autre expédition ici…</option>{others.map((o) => <option key={o.id} value={o.id}>{o.reference || o.id}{o.trackingRef ? ` · ${o.trackingRef}` : ''} · {statusOf(SHIPMENT_STATUS, o.status).label}</option>)}</select>)}<span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Annuler</button><button className="btn primary" onClick={onSave}>Enregistrer</button></>}>
      <div className="form c4">
        <Field label="Référence" span={2}><Input value={shipment.reference} onChange={set('reference')} placeholder="Ex. : FCL 40HQ septembre" /></Field>
        <Field label="Importation" span={2}><Select value={shipment.projectId ?? ''} onChange={(v) => { const projectId = v || null; const projOrders = projectId ? db.orders.filter((o) => o.projectId === projectId).map((o) => o.id) : []; onChange({ ...shipment, projectId, orderIds: projectId && shipment.orderIds.length === 0 ? projOrders : shipment.orderIds }); }} options={[{ value: '', label: '— Aucune —' }, ...db.projects.filter((p) => p.status !== 'archive' || p.id === shipment.projectId).map((p) => ({ value: p.id, label: `${p.name}${p.container ? ` · ${p.container}` : ''}` }))]} /></Field>
        <Field label="Mode"><Select value={shipment.mode} onChange={set('mode')} options={(Object.keys(MODE_LABELS) as (keyof typeof MODE_LABELS)[]).map((m) => ({ value: m, label: MODE_LABELS[m] }))} /></Field>
        <Field label="Statut"><Select value={shipment.status} onChange={set('status')} options={SHIPMENT_STATUS.map((s) => ({ value: s.value, label: s.label }))} /></Field>
        <Field label="Transporteur"><Select value={shipment.partnerId ?? ''} onChange={(v) => onChange({ ...shipment, partnerId: v || null })} options={[{ value: '', label: '—' }, ...transporters.map((p) => ({ value: p.id, label: p.name }))]} /></Field>
        <Field label="Agent en Chine"><Select value={shipment.agentId ?? ''} onChange={(v) => onChange({ ...shipment, agentId: v || null })} options={[{ value: '', label: '—' }, ...agents.map((p) => ({ value: p.id, label: p.name }))]} /></Field>
        <Field label="Incoterm"><Select value={shipment.incoterm} onChange={set('incoterm')} options={['EXW', 'FOB', 'CIF', 'DDP'].map((v) => ({ value: v as 'EXW', label: v }))} /></Field>
        <Field label="N° de suivi / B/L"><Input value={shipment.trackingRef} onChange={set('trackingRef')} /></Field>
        <Field label="Départ (ETD)"><Input type="date" value={shipment.etd} onChange={set('etd')} /></Field>
        <Field label="Arrivée (ETA)"><Input type="date" value={shipment.eta} onChange={set('eta')} /></Field>
        <Field label="Volume"><NumberInput value={shipment.cbm} onChange={set('cbm')} unit="m³" placeholder={estCbm ? estCbm.toFixed(1) : ''} /></Field>
        <Field label="Poids"><NumberInput value={shipment.weightKg} onChange={set('weightKg')} unit="kg" /></Field>
      </div>

      <h3 className="mt">Commandes incluses</h3>
      {candidateOrders.length === 0 ? <div className="muted small">Aucune commande disponible.</div> : candidateOrders.map((o) => (
        <label key={o.id} className="check">
          <input type="checkbox" checked={shipment.orderIds.includes(o.id)} onChange={() => toggleOrder(o.id)} />
          <span><b>{o.reference || 'Commande'}</b> · {db.factories.find((f) => f.id === o.factoryId)?.name ?? ''} · {formatEur(orderTotalEur(o, db.settings))}<br /><span className="muted small">{o.lines.map((l) => `${l.qty} × ${l.isService ? (l.label || 'prestation') : db.products.find((p) => p.id === l.productId)?.name ?? '?'}`).join(', ')}</span></span>
        </label>
      ))}
      {estCbm > 0 && <div className="small muted mt">Volume estimé d'après le colisage des produits : {estCbm.toFixed(2)} m³.</div>}

      {exists && (
        <>
          <h3 className="mt">Documents de l'expédition <span className="muted small">({linkedDocs.length})</span></h3>
          {linkedDocs.length === 0 && pendingAttachments.length === 0 && <div className="muted small">Aucun document rattaché. Rattache des emails à cette expédition (onglet Emails) ou analyse un document en choisissant cette expédition.</div>}
          {linkedDocs.length > 0 && (
            <div style={{ overflowX: 'auto' }}><table className="tbl">
              <thead><tr><th>Document</th><th>Type</th><th>Reçu</th><th>Source</th><th></th></tr></thead>
              <tbody>{linkedDocs.map((d) => { const m = linkedMails.find((x) => x.attachments.some((a) => a.documentId === d.id)); return (
                <tr key={d.id}>
                  <td><a style={{ cursor: 'pointer' }} onClick={() => openDoc(d.id)}>📄 {d.fileName}</a>{d.summary ? <div className="small muted">{d.summary.slice(0, 120)}</div> : null}</td>
                  <td><Badge>{KIND_LABELS[d.kind] ?? d.kind}</Badge></td>
                  <td className="small">{fmtDate((m?.date ?? d.createdAt).slice(0, 10))}</td>
                  <td className="small muted">{m ? `Email · ${m.fromName || m.from}` : d.id === shipment.documentId ? 'Document de transport' : 'Documents'}</td>
                  <td className="num"><button className="btn ghost small" onClick={() => openDoc(d.id)}>Ouvrir</button></td>
                </tr>
              ); })}</tbody>
            </table></div>
          )}
          {pendingAttachments.length > 0 && (
            <div className="small mt"><span className="muted">Pièces jointes des emails pas encore importées : </span>
              {pendingAttachments.map(({ m, a }) => <button key={`${m.id}:${a.index}`} className="btn ghost small" disabled={importing === `${m.id}:${a.index}`} onClick={() => importAttachment(m, a.index)}>{importing === `${m.id}:${a.index}` ? '…' : `📎 ${a.filename}`}</button>)}
            </div>
          )}
        </>
      )}

      <h3 className="mt">Coûts logistiques</h3>
      <div className="form c4">
        <Field label="Fret principal"><NumberInput value={shipment.freightCost} onChange={set('freightCost')} /></Field>
        <Field label="Assurance"><NumberInput value={shipment.insuranceCost} onChange={set('insuranceCost')} /></Field>
        <Field label="Frais au départ"><NumberInput value={shipment.originFees} onChange={set('originFees')} /></Field>
        <Field label="Frais à l'arrivée"><NumberInput value={shipment.destinationFees} onChange={set('destinationFees')} /></Field>
        <Field label="Devise"><Select value={shipment.currency} onChange={set('currency')} options={CURRENCIES} /></Field>
        <Field label="Document (devis / facture transport)" span={2}><Select value={shipment.documentId ?? ''} onChange={(v) => onChange({ ...shipment, documentId: v || null })} options={[{ value: '', label: '— Aucun —' }, ...db.documents.map((d) => ({ value: d.id, label: d.fileName }))]} /></Field>
        <Field label="Total logistique"><div style={{ paddingTop: 8 }}><b>{formatEur(total)}</b>{goodsEur > 0 && <span className="muted small"> · {((total / goodsEur) * 100).toFixed(0)} % de la marchandise</span>}</div></Field>
        <Field label="Notes" span={4}><Textarea value={shipment.notes} onChange={set('notes')} placeholder="Frais au départ = camion usine → port, THC, documents. Frais à l'arrivée = THC, dédouanement, livraison finale." /></Field>
      </div>
      {(shipment.invoices ?? []).length > 0 && (
        <div className="small mt"><span className="muted">Factures de transport comptées dans ces coûts : </span>
          {(shipment.invoices ?? []).map((inv, i) => <span key={i} className="row-flex" style={{ display: 'inline-flex', gap: 4, marginRight: 8 }}><Badge>{inv.ref || 'facture'}{inv.label ? ` · ${inv.label}` : ''} · {formatMoney(inv.total, inv.currency)}</Badge><button className="btn ghost small" title="Retirer cette facture de la liste (les montants ne changent pas)" onClick={() => onChange({ ...shipment, invoices: (shipment.invoices ?? []).filter((_, j) => j !== i) })}>✕</button></span>)}
        </div>
      )}
      <div className="small muted mt">Marchandise : {formatEur(goodsEur)} · {formatMoney(shipment.freightCost + shipment.insuranceCost + shipment.originFees + shipment.destinationFees, shipment.currency)} de logistique. Ces coûts sont répartis entre les produits au prorata du volume dans Finance.</div>
    </Modal>
  );
}
