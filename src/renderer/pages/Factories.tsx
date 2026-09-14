import React, { useEffect, useState } from 'react';
import { newId, today, useStore } from '../store';
import { useNav } from '../App';
import { useViewer } from '../components/Viewer';
import { api } from '../api';
import { Badge, ConfirmButton, Empty, Field, Input, Modal, NumberInput, Select, Stars, Tabs, Textarea, Timeline, fmtDate } from '../components/ui';
import { ORDER_STATUS, statusOf } from '../labels';
import type { Contact, Currency, Factory, FactoryComment, Order, Product, Quote } from '../../shared/types';
import { blankProduct, folderPath } from './Merchandise';
import { priceHistory, unitCost } from '../../shared/finance';
import { formatEur, formatMoney, orderTotalEur, toEur } from '../../shared/finance';

const CURRENCIES: { value: Currency; label: string }[] = [{ value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }, { value: 'CNY', label: 'CNY' }, { value: 'GBP', label: 'GBP' }];
const INCOTERMS = ['EXW', 'FOB', 'CIF', 'DDP'].map((v) => ({ value: v as 'EXW', label: v }));

export function FactoriesPage() {
  const { db, update } = useStore();
  const { nav, go } = useNav();
  const { open: openDoc } = useViewer();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Factory | null>(null);

  const selected = nav.id ? db.factories.find((f) => f.id === nav.id) : undefined;
  if (selected) return <FactoryDetail factory={selected} />;

  const list = db.factories.filter((f) => !q || `${f.name} ${f.city} ${f.specialties}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  const save = () => { if (!editing?.name.trim()) return; update((d) => ({ ...d, factories: [...d.factories, editing] })); setEditing(null); go('factories', editing.id); };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Usines</h1><div className="sub">Tes fournisseurs chinois : coordonnées, contacts, prix, commandes.</div></div>
        <div className="actions">
          <input className="search" placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" onClick={() => setEditing(blankFactory())}>+ Nouvelle usine</button>
        </div>
      </div>
      {list.length === 0 ? <div className="card"><Empty icon="⚙" title={q ? 'Aucun résultat' : 'Aucune usine'} text="Importe une facture ou un catalogue dans Documents : l'usine est créée automatiquement." /></div> : (
        <div className="factory-cards">
          {list.map((f) => <FactoryCard key={f.id} factory={f} />)}
        </div>
      )}
      {editing && <Modal title="Nouvelle usine" onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>Annuler</button><button className="btn primary" onClick={save}>Créer</button></>}><FactoryForm value={editing} onChange={setEditing} /></Modal>}
    </div>
  );
}

const blankFactory = (): Factory => ({ id: newId(), name: '', city: '', province: '', address: '', website: '', wechat: '', email: '', phone: '', specialties: '', rating: 0, notes: '', comments: [] });

/** Carte d'usine : note, chiffres clés, inventaire (catalogue) déroulant, dernier commentaire et ajout rapide. */
function FactoryCard({ factory: f }: { factory: Factory }) {
  const { db, update, toast } = useStore();
  const { go } = useNav();
  const [draft, setDraft] = useState('');
  const orders = db.orders.filter((o) => o.factoryId === f.id);
  const contacts = db.contacts.filter((c) => c.ownerType === 'factory' && c.ownerId === f.id);
  const inventory = db.products.filter((p) => p.factoryId === f.id || (p.isCurrentVersion && db.quotes.some((q) => q.factoryId === f.id && q.productId === p.id))).sort((a, b) => a.name.localeCompare(b.name));
  const multiVersion = (p: Product) => db.products.filter((x) => (x.familyId || x.id) === (p.familyId || p.id)).length > 1;
  const active = orders.filter((o) => !['livree', 'devis'].includes(o.status)).length;
  const lastComment = [...f.comments].sort((a, b) => b.date.localeCompare(a.date))[0];
  const setRating = (rating: number) => update((d) => ({ ...d, factories: d.factories.map((x) => (x.id === f.id ? { ...x, rating } : x)) }));
  const addComment = () => {
    const text = draft.trim(); if (!text) return;
    const c: FactoryComment = { id: newId(), date: today(), text, rating: 0 };
    update((d) => ({ ...d, factories: d.factories.map((x) => (x.id === f.id ? { ...x, comments: [c, ...x.comments] } : x)) }));
    setDraft(''); toast('Commentaire ajouté');
  };
  return (
    <div className="card factory-card" onClick={() => go('factories', f.id)}>
      <div className="fc-head">
        <div>
          <h2>{f.name}</h2>
          <div className="small muted">{[f.city, f.province].filter(Boolean).join(', ') || 'Ville inconnue'}{f.specialties ? ` · ${f.specialties}` : ''}</div>
        </div>
        <div onClick={(e) => e.stopPropagation()} title="Clique pour noter"><Stars value={f.rating} onChange={setRating} size={18} /></div>
      </div>
      <div className="fc-stats">
        <span><b>{orders.length}</b> commande{orders.length > 1 ? 's' : ''}{active ? ` (${active} en cours)` : ''}</span>
        <span><b>{formatEur(orders.reduce((t, o) => t + orderTotalEur(o, db.settings), 0), 0)}</b> commandés</span>
        <span><b>{contacts.length}</b> contact{contacts.length > 1 ? 's' : ''}</span>
        <span><b>{f.comments.length}</b> commentaire{f.comments.length > 1 ? 's' : ''}</span>
      </div>
      <div>
        <div className="small muted" style={{ marginBottom: 4 }}>Inventaire · {inventory.length} référence{inventory.length > 1 ? 's' : ''}</div>
        <div className="fc-inventory" onClick={(e) => e.stopPropagation()}>
          {inventory.length === 0 ? <div className="row muted">Aucune référence — importe une facture ou un catalogue.</div> : inventory.map((p) => {
            const last = priceHistory(db.quotes.filter((q) => q.factoryId === f.id), p.id, db.settings).at(-1);
            return <div key={p.id} className="row" style={{ cursor: 'pointer' }} onClick={() => go('merchandise', p.id)}><span className="n">{p.name}{multiVersion(p) ? <span className="muted"> {p.version}</span> : null}{p.sku ? <span className="muted"> · {p.sku}</span> : null}</span><span className="p">{last ? formatMoney(last.unitPrice, last.currency) : '—'}</span></div>;
          })}
        </div>
      </div>
      {lastComment && <div className="fc-comment" title={lastComment.text}>« {lastComment.text} » — {fmtDate(lastComment.date)}</div>}
      <div className="fc-foot" onClick={(e) => e.stopPropagation()}>
        <textarea value={draft} placeholder="Ajouter un commentaire (qualité, délais, échange…)" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); } }} />
        <button className="btn small" disabled={!draft.trim()} onClick={addComment}>Ajouter</button>
      </div>
    </div>
  );
}

function FactoryForm({ value, onChange }: { value: Factory; onChange: (f: Factory) => void }) {
  const set = (k: keyof Factory) => (v: string | number) => onChange({ ...value, [k]: v });
  return (
    <div className="form c3">
      <Field label="Nom" span={2}><Input value={value.name} onChange={set('name')} placeholder="Foshan … Co., Ltd" /></Field>
      <Field label="Note"><div style={{ paddingTop: 6 }}><Stars value={value.rating} onChange={set('rating')} size={20} /></div></Field>
      <Field label="Ville"><Input value={value.city} onChange={set('city')} /></Field>
      <Field label="Province"><Input value={value.province} onChange={set('province')} /></Field>
      <Field label="Site web"><Input value={value.website} onChange={set('website')} /></Field>
      <Field label="Adresse" span={3}><Input value={value.address} onChange={set('address')} /></Field>
      <Field label="Email"><Input value={value.email} onChange={set('email')} /></Field>
      <Field label="Téléphone"><Input value={value.phone} onChange={set('phone')} /></Field>
      <Field label="WeChat"><Input value={value.wechat} onChange={set('wechat')} /></Field>
      <Field label="Spécialités" span={3}><Input value={value.specialties} onChange={set('specialties')} placeholder="Ce qu'ils fabriquent bien" /></Field>
      <Field label="Notes" span={3}><Textarea value={value.notes} onChange={set('notes')} /></Field>
    </div>
  );
}

function FactoryDetail({ factory }: { factory: Factory }) {
  const { db, update, toast } = useStore();
  const { nav, go } = useNav();
  const { open: openDoc } = useViewer();
  const [tab, setTab] = useState<'catalogue' | 'commandes' | 'prix' | 'contacts' | 'documents'>('catalogue');
  const [newProduct, setNewProduct] = useState<Product | null>(null);
  const [edit, setEdit] = useState<Factory | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentRating, setCommentRating] = useState(0);
  const addComment = () => {
    const text = commentDraft.trim(); if (!text) return;
    const c: FactoryComment = { id: newId(), date: today(), text, rating: commentRating };
    update((d) => ({ ...d, factories: d.factories.map((x) => (x.id === factory.id ? { ...x, comments: [c, ...x.comments] } : x)) }));
    setCommentDraft(''); setCommentRating(0); toast('Commentaire ajouté');
  };

  useEffect(() => { if (nav.sub) { const o = db.orders.find((x) => x.id === nav.sub); if (o) setOrder(o); } }, [nav.sub]); // eslint-disable-line react-hooks/exhaustive-deps

  const orders = db.orders.filter((o) => o.factoryId === factory.id).sort((a, b) => b.date.localeCompare(a.date));
  const quotes = db.quotes.filter((q) => q.factoryId === factory.id).sort((a, b) => b.date.localeCompare(a.date));
  const contacts = db.contacts.filter((c) => c.ownerType === 'factory' && c.ownerId === factory.id);
  const docs = db.documents.filter((d) => d.linkedTo.some((l) => l.type === 'factory' && l.id === factory.id));
  const catalogues = docs.filter((d) => d.kind === 'catalogue');
  // Catalogue de l'usine : les références qu'elle fabrique + celles pour lesquelles elle a fait un prix.
  const catalogProducts = db.products.filter((p) => p.factoryId === factory.id || db.quotes.some((q) => q.factoryId === factory.id && q.productId === p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const saveNewProduct = () => {
    if (!newProduct?.name.trim()) return;
    update((d) => ({ ...d, products: [...d.products, newProduct] }));
    setNewProduct(null); toast('Référence ajoutée au catalogue');
  };

  const saveFactory = () => { if (!edit) return; update((d) => ({ ...d, factories: d.factories.map((f) => (f.id === edit.id ? edit : f)) })); setEdit(null); };
  const saveContact = () => { if (!contact?.name.trim()) return; update((d) => ({ ...d, contacts: d.contacts.some((c) => c.id === contact.id) ? d.contacts.map((c) => (c.id === contact.id ? contact : c)) : [...d.contacts, contact] })); setContact(null); };
  const saveQuote = () => { if (!quote?.productId) return; update((d) => ({ ...d, quotes: d.quotes.some((x) => x.id === quote.id) ? d.quotes.map((x) => (x.id === quote.id ? quote : x)) : [...d.quotes, quote] })); setQuote(null); toast('Prix enregistré dans l\'historique'); };
  const saveOrder = () => {
    if (!order) return;
    update((d) => ({ ...d, orders: d.orders.some((x) => x.id === order.id) ? d.orders.map((x) => (x.id === order.id ? order : x)) : [...d.orders, order] }));
    setOrder(null); toast('Commande enregistrée');
  };

  const blankOrder = (): Order => ({ id: newId(), projectId: db.projects.find((x) => x.status !== 'archive' && x.status !== 'vente')?.id ?? '', factoryId: factory.id, reference: '', date: today(), status: 'devis', lines: [], depositPct: 30, depositPaid: false, balancePaid: false, productionDays: 30, expectedReadyDate: '', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null, notes: '' });

  return (
    <div className="page">
      <div className="breadcrumb"><a onClick={() => go('factories')}>Usines</a> › {factory.name}</div>
      <div className="page-head">
        <div><h1>{factory.name} <Stars value={factory.rating} size={20} onChange={(rating) => update((d) => ({ ...d, factories: d.factories.map((x) => (x.id === factory.id ? { ...x, rating } : x)) }))} /></h1><div className="sub">{[factory.city, factory.province, 'Chine'].filter(Boolean).join(', ')}{factory.specialties ? ` · ${factory.specialties}` : ''}</div></div>
        <div className="actions">
          <button className="btn" onClick={() => setEdit(factory)}>Modifier</button>
          <button className="btn primary" onClick={() => setOrder(blankOrder())}>+ Commande</button>
        </div>
      </div>

      <div className="grid c3 mb">
        <div className="card">
          <h3>Coordonnées</h3>
          <div className="kv">
            <span className="k">Adresse</span><span>{factory.address || '—'}</span>
            <span className="k">Email</span><span>{factory.email ? <a href={`mailto:${factory.email}`}>{factory.email}</a> : '—'}</span>
            <span className="k">Téléphone</span><span>{factory.phone || '—'}</span>
            <span className="k">WeChat</span><span>{factory.wechat || '—'}</span>
            <span className="k">Site</span><span>{factory.website || '—'}</span>
          </div>
        </div>
        <div className="card">
          <h3>Contacts</h3>
          {contacts.length === 0 ? <div className="muted small">Aucun contact.</div> : contacts.map((c) => (
            <div key={c.id} className="small" style={{ marginBottom: 6, cursor: 'pointer' }} onClick={() => setContact(c)}>
              <b>{c.name}</b>{c.role ? ` · ${c.role}` : ''}<br /><span className="muted">{[c.email, c.phone, c.wechat && `WeChat ${c.wechat}`, c.whatsapp && `WhatsApp ${c.whatsapp}`].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
          <button className="btn small mt" onClick={() => setContact({ id: newId(), ownerType: 'factory', ownerId: factory.id, name: '', role: '', email: '', phone: '', wechat: '', whatsapp: '' })}>+ Contact</button>
        </div>
        <div className="card">
          <h3>Commentaires ({factory.comments.length})</h3>
          <div style={{ maxHeight: 160, overflowY: 'auto' }}>
            {factory.comments.length === 0 && <div className="muted small">Aucun commentaire. Note ici tes retours : qualité, délais, communication…</div>}
            {[...factory.comments].sort((a, b) => b.date.localeCompare(a.date)).map((c) => (
              <div key={c.id} className="comment">
                <div className="meta">{fmtDate(c.date)}{c.rating ? <Stars value={c.rating} size={11} /> : null}<span style={{ flex: 1 }} /><button className="btn ghost small" title="Supprimer" onClick={() => update((d) => ({ ...d, factories: d.factories.map((x) => (x.id === factory.id ? { ...x, comments: x.comments.filter((y) => y.id !== c.id) } : x)) }))}>✕</button></div>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.text}</div>
              </div>
            ))}
          </div>
          <div className="row-flex mt" style={{ alignItems: 'flex-start' }}>
            <textarea value={commentDraft} placeholder="Nouveau commentaire…" onChange={(e) => setCommentDraft(e.target.value)} style={{ flex: 1, minHeight: 36, fontSize: 12 }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); } }} />
            <div><Stars value={commentRating} onChange={setCommentRating} size={14} /><br /><button className="btn small mt" disabled={!commentDraft.trim()} onClick={addComment}>Ajouter</button></div>
          </div>
          {(catalogues.length > 0 || factory.notes) && <div className="small mt" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            {catalogues.map((d) => <div key={d.id}>📄 <a onClick={() => openDoc(d.id)} style={{ cursor: 'pointer' }}>{d.fileName}</a></div>)}
            {factory.notes && <div className="muted mt">{factory.notes}</div>}
          </div>}
        </div>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'catalogue', label: `Catalogue (${catalogProducts.length})` }, { value: 'commandes', label: `Commandes (${orders.length})` }, { value: 'prix', label: `Historique des prix (${quotes.length})` }, { value: 'documents', label: `Documents (${docs.length})` }]} />

      {tab === 'commandes' && (
        orders.length === 0 ? <div className="card"><Empty icon="⚙" title="Aucune commande" text="Crée une commande ou importe une facture / proforma." /></div> : orders.map((o) => {
          const os = statusOf(ORDER_STATUS, o.status);
          const project = db.projects.find((p) => p.id === o.projectId);
          return (
            <div className="card" key={o.id} style={{ cursor: 'pointer' }} onClick={() => setOrder(o)}>
              <div className="card-head">
                <h2>{o.reference || 'Commande sans référence'} <span className="muted small">· {fmtDate(o.date)}{project ? <> · <a style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); go('projects', project.id); }}>{project.name}</a></> : ''}</span></h2>
                <div className="row-flex"><Badge tone={os.tone}>{os.label}</Badge><b>{formatEur(orderTotalEur(o, db.settings))}</b></div>
              </div>
              <Timeline steps={ORDER_STATUS} current={o.status} />
              <div className="small muted mt">
                {o.lines.map((l) => `${l.qty} × ${l.isService ? `🔧 ${l.label || 'prestation'}` : db.products.find((p) => p.id === l.productId)?.name ?? l.label ?? '?'} à ${formatMoney(l.unitPrice, l.currency)}`).join(' · ') || 'Aucune ligne'}
                {o.expectedReadyDate && ` · prête le ${fmtDate(o.expectedReadyDate)}`}
                {` · acompte ${o.depositPct} % ${o.depositPaid ? 'payé' : 'à payer'}`}{o.balancePaid ? ' · solde payé' : ''}
              </div>
            </div>
          );
        })
      )}

      {tab === 'catalogue' && (
        <>
          <div className="card pad0">
            <div className="card-head" style={{ padding: '14px 20px 0' }}><h2>Références fabriquées par cette usine</h2><button className="btn primary small" onClick={() => setNewProduct({ ...blankProduct(db.settings.defaultDutyRatePct, null), factoryId: factory.id })}>+ Référence</button></div>
            {catalogProducts.length === 0 ? <Empty icon="▦" title="Catalogue vide" text="Ajoute les références que cette usine fabrique, ou importe une facture / un catalogue : elles s'ajoutent toutes seules." /> : (
              <table className="tbl">
                <thead><tr><th>Référence</th><th>Libellé usine</th><th>Dossier</th><th className="num">Dernier prix</th><th className="num">Coût de revient</th><th></th></tr></thead>
                <tbody>{catalogProducts.map((p) => {
                  const last = priceHistory(db.quotes.filter((qq) => qq.factoryId === factory.id), p.id, db.settings).at(-1);
                  const cost = unitCost(p.id, db);
                  return (
                    <tr key={p.id} className="click" onClick={() => go('merchandise', p.id)}>
                      <td className="strong">{p.name}{p.sku && <span className="muted small"> · {p.sku}</span>}{p.factoryId !== factory.id && <Badge>prix reçu, fabriquée ailleurs</Badge>}</td>
                      <td className="small muted">{p.supplierName || '—'}</td>
                      <td className="small">{folderPath(db.folders, p.folderId) || <span className="muted">—</span>}</td>
                      <td className="num">{last ? <>{formatMoney(last.unitPrice, last.currency)}<div className="small muted">{fmtDate(last.date)}{last.moq ? ` · MOQ ${last.moq}` : ''}</div></> : <span className="muted">—</span>}</td>
                      <td className="num">{cost ? formatEur(cost.costEur) : <span className="muted">—</span>}</td>
                      <td className="right"><button className="btn ghost small" title="Ajouter un prix" onClick={(e) => { e.stopPropagation(); setQuote({ id: newId(), productId: p.id, factoryId: factory.id, date: today(), unitPrice: last?.unitPrice ?? 0, currency: last?.currency ?? 'USD', moq: last?.moq ?? 0, incoterm: last?.incoterm ?? 'FOB', leadTimeDays: last?.leadTimeDays ?? 30, documentId: null, notes: '' }); }}>+ prix</button></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>Catalogues PDF de l'usine</h2><span className="small muted">Importe-les dans Documents : ils sont reconnus et rattachés ici.</span></div>
            {catalogues.length === 0 ? <div className="muted small">Aucun catalogue importé.</div> : (
              <div className="pill-row">{catalogues.map((d) => <button key={d.id} className="btn small" onClick={() => openDoc(d.id)}>📄 {d.fileName}</button>)}</div>
            )}
          </div>
        </>
      )}

      {tab === 'prix' && (
        <div className="card pad0">
          <div className="card-head" style={{ padding: '14px 20px 0' }}><h2>Prix proposés par cette usine</h2><button className="btn small" onClick={() => setQuote({ id: newId(), productId: db.products[0]?.id ?? '', factoryId: factory.id, date: today(), unitPrice: 0, currency: 'USD', moq: 0, incoterm: 'FOB', leadTimeDays: 30, documentId: null, notes: '' })}>+ Prix</button></div>
          {quotes.length === 0 ? <Empty icon="€" title="Aucun prix" text="Chaque devis, PI ou facture alimente l'historique des prix." /> : (
            <table className="tbl">
              <thead><tr><th>Date</th><th>Produit</th><th className="num">Prix unitaire</th><th className="num">En EUR</th><th className="num">MOQ</th><th>Incoterm</th><th className="num">Délai</th><th>Note</th></tr></thead>
              <tbody>{quotes.map((q) => (
                <tr key={q.id} className="click" onClick={() => setQuote(q)}>
                  <td>{fmtDate(q.date)}</td><td className="strong">{db.products.find((p) => p.id === q.productId)?.name ?? '?'}</td>
                  <td className="num">{formatMoney(q.unitPrice, q.currency)}</td><td className="num">{formatEur(toEur(q.unitPrice, q.currency, db.settings))}</td>
                  <td className="num">{q.moq || '—'}</td><td>{q.incoterm}</td><td className="num">{q.leadTimeDays ? `${q.leadTimeDays} j` : '—'}</td><td className="small muted">{q.notes}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'documents' && (
        <div className="card pad0">
          {docs.length === 0 ? <Empty icon="⇩" title="Aucun document" /> : (
            <table className="tbl"><thead><tr><th>Fichier</th><th>Type</th><th>Résumé</th><th></th></tr></thead>
              <tbody>{docs.map((d) => <tr key={d.id}><td className="strong">{d.fileName}</td><td><Badge>{d.kind}</Badge></td><td className="small">{d.summary}</td><td className="right"><button className="btn small" onClick={() => openDoc(d.id)}>Ouvrir</button></td></tr>)}</tbody></table>
          )}
        </div>
      )}

      {edit && <Modal title="Modifier l'usine" onClose={() => setEdit(null)} footer={<><ConfirmButton label="Supprimer l'usine" onConfirm={() => { update((d) => ({ ...d, factories: d.factories.filter((f) => f.id !== factory.id) })); go('factories'); }} /><span style={{ flex: 1 }} /><button className="btn" onClick={() => setEdit(null)}>Annuler</button><button className="btn primary" onClick={saveFactory}>Enregistrer</button></>}><FactoryForm value={edit} onChange={setEdit} /></Modal>}

      {contact && (
        <Modal title="Contact" onClose={() => setContact(null)} footer={<>{db.contacts.some((c) => c.id === contact.id) && <ConfirmButton label="Supprimer" onConfirm={() => { update((d) => ({ ...d, contacts: d.contacts.filter((c) => c.id !== contact.id) })); setContact(null); }} />}<span style={{ flex: 1 }} /><button className="btn" onClick={() => setContact(null)}>Annuler</button><button className="btn primary" onClick={saveContact}>Enregistrer</button></>}>
          <div className="form c2">
            <Field label="Nom"><Input value={contact.name} onChange={(v) => setContact({ ...contact, name: v })} /></Field>
            <Field label="Rôle"><Input value={contact.role} onChange={(v) => setContact({ ...contact, role: v })} placeholder="Sales, boss, ingénieur…" /></Field>
            <Field label="Email"><Input value={contact.email} onChange={(v) => setContact({ ...contact, email: v })} /></Field>
            <Field label="Téléphone"><Input value={contact.phone} onChange={(v) => setContact({ ...contact, phone: v })} /></Field>
            <Field label="WeChat"><Input value={contact.wechat} onChange={(v) => setContact({ ...contact, wechat: v })} /></Field>
            <Field label="WhatsApp"><Input value={contact.whatsapp} onChange={(v) => setContact({ ...contact, whatsapp: v })} /></Field>
          </div>
        </Modal>
      )}

      {quote && (
        <Modal title="Prix proposé" onClose={() => setQuote(null)} footer={<>{db.quotes.some((x) => x.id === quote.id) && <ConfirmButton label="Supprimer" onConfirm={() => { update((d) => ({ ...d, quotes: d.quotes.filter((x) => x.id !== quote.id) })); setQuote(null); }} />}<span style={{ flex: 1 }} /><button className="btn" onClick={() => setQuote(null)}>Annuler</button><button className="btn primary" onClick={saveQuote}>Enregistrer</button></>}>
          <div className="form c3">
            <Field label="Produit" span={2}><Select value={quote.productId} onChange={(v) => setQuote({ ...quote, productId: v })} options={[{ value: '', label: '— Choisir —' }, ...db.products.map((p) => ({ value: p.id, label: p.name }))]} /></Field>
            <Field label="Date"><Input type="date" value={quote.date} onChange={(v) => setQuote({ ...quote, date: v })} /></Field>
            <Field label="Prix unitaire"><NumberInput value={quote.unitPrice} onChange={(v) => setQuote({ ...quote, unitPrice: v })} /></Field>
            <Field label="Devise"><Select value={quote.currency} onChange={(v) => setQuote({ ...quote, currency: v })} options={CURRENCIES} /></Field>
            <Field label="Incoterm"><Select value={quote.incoterm} onChange={(v) => setQuote({ ...quote, incoterm: v })} options={INCOTERMS} /></Field>
            <Field label="MOQ"><NumberInput value={quote.moq} onChange={(v) => setQuote({ ...quote, moq: v })} unit="pcs" /></Field>
            <Field label="Délai de production"><NumberInput value={quote.leadTimeDays} onChange={(v) => setQuote({ ...quote, leadTimeDays: v })} unit="jours" /></Field>
            <Field label="Note"><Input value={quote.notes} onChange={(v) => setQuote({ ...quote, notes: v })} /></Field>
          </div>
        </Modal>
      )}

      {newProduct && (
        <Modal title={`Nouvelle référence fabriquée par ${factory.name}`} onClose={() => setNewProduct(null)} footer={<><button className="btn" onClick={() => setNewProduct(null)}>Annuler</button><button className="btn primary" onClick={saveNewProduct}>Créer</button></>}>
          <div className="form c3">
            <Field label="Nom interne" span={2}><Input value={newProduct.name} onChange={(v) => setNewProduct({ ...newProduct, name: v })} placeholder="Ex. : Grand cadre aluminium 2000×1000" /></Field>
            <Field label="Réf. interne"><Input value={newProduct.sku} onChange={(v) => setNewProduct({ ...newProduct, sku: v })} /></Field>
            <Field label="Libellé chez l'usine" span={3}><Input value={newProduct.supplierName} onChange={(v) => setNewProduct({ ...newProduct, supplierName: v })} placeholder="Tel qu'il apparaît sur ses factures / son catalogue" /></Field>
            <Field label="Description" span={3}><Textarea value={newProduct.description} onChange={(v) => setNewProduct({ ...newProduct, description: v })} /></Field>
            <Field label="Code douanier (SH)"><Input value={newProduct.hsCode} onChange={(v) => setNewProduct({ ...newProduct, hsCode: v })} /></Field>
            <Field label="Droits de douane"><NumberInput value={newProduct.dutyRatePct} onChange={(v) => setNewProduct({ ...newProduct, dutyRatePct: v })} unit="%" /></Field>
          </div>
          <div className="small muted mt">Tu pourras compléter le reste (dossier, colisage, composition, prix) depuis sa fiche dans Marchandise.</div>
        </Modal>
      )}

      {order && <OrderModal order={order} onChange={setOrder} onClose={() => setOrder(null)} onSave={saveOrder} />}
    </div>
  );
}

export function OrderModal({ order, onChange, onClose, onSave }: { order: Order; onChange: (o: Order) => void; onClose: () => void; onSave: () => void }) {
  const { db, update } = useStore();
  const exists = db.orders.some((x) => x.id === order.id);
  const products = [...db.products].filter((p) => p.isCurrentVersion || order.lines.some((l) => l.productId === p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const setLine = (i: number, patch: Partial<Order['lines'][number]>) => onChange({ ...order, lines: order.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const total = orderTotalEur(order, db.settings);
  const docOptions = [{ value: '', label: '— Aucun —' }, ...db.documents.map((d) => ({ value: d.id, label: d.fileName }))];

  return (
    <Modal title={exists ? `Commande ${order.reference || ''}` : 'Nouvelle commande'} onClose={onClose} wide
      footer={<>{exists && <ConfirmButton label="Supprimer" onConfirm={() => { update((d) => ({ ...d, orders: d.orders.filter((x) => x.id !== order.id) })); onClose(); }} />}<span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Annuler</button><button className="btn primary" onClick={onSave}>Enregistrer</button></>}>
      <div className="form c4">
        <Field label="Usine"><Select value={order.factoryId} onChange={(v) => onChange({ ...order, factoryId: v })} options={db.factories.map((f) => ({ value: f.id, label: f.name }))} /></Field>
        <Field label="Importation"><Select value={order.projectId} onChange={(v) => onChange({ ...order, projectId: v })} options={[{ value: '', label: '— Aucun —' }, ...db.projects.map((p) => ({ value: p.id, label: p.name }))]} /></Field>
        <Field label="Référence (PI / facture)"><Input value={order.reference} onChange={(v) => onChange({ ...order, reference: v })} /></Field>
        <Field label="Date"><Input type="date" value={order.date} onChange={(v) => onChange({ ...order, date: v })} /></Field>
        <Field label="Statut"><Select value={order.status} onChange={(v) => onChange({ ...order, status: v })} options={ORDER_STATUS.map((s) => ({ value: s.value, label: s.label }))} /></Field>
      </div>
      <h3 className="mt">Lignes</h3>
      <table className="tbl">
        <thead><tr><th>Produit</th><th className="num">Quantité</th><th className="num">Prix unitaire</th><th>Devise</th><th className="num">Total</th><th></th></tr></thead>
        <tbody>
          {order.lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select value={l.isService ? 'service' : l.productId} onChange={(e) => (e.target.value === 'service' ? setLine(i, { productId: '', isService: true }) : setLine(i, { productId: e.target.value, isService: false }))} style={{ width: '100%' }}><option value="">— Produit —</option><option value="service">🔧 Prestation (confection, assemblage…)</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                {l.isService && <input value={l.label ?? ''} placeholder="Libellé de la prestation" onChange={(e) => setLine(i, { label: e.target.value })} style={{ width: '100%', marginTop: 4 }} />}
              </td>
              <td className="num"><input type="number" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} style={{ width: 90, textAlign: 'right' }} /></td>
              <td className="num"><input type="number" step="any" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })} style={{ width: 100, textAlign: 'right' }} /></td>
              <td><select value={l.currency} onChange={(e) => setLine(i, { currency: e.target.value as Currency })}>{CURRENCIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></td>
              <td className="num">{formatEur(toEur(l.unitPrice * l.qty, l.currency, db.settings))}</td>
              <td><button className="btn ghost small" onClick={() => onChange({ ...order, lines: order.lines.filter((_, j) => j !== i) })}>✕</button></td>
            </tr>
          ))}
          <tr className="total"><td colSpan={4}>Total marchandise</td><td className="num">{formatEur(total)}</td><td /></tr>
        </tbody>
      </table>
      <button className="btn small mt" onClick={() => onChange({ ...order, lines: [...order.lines, { productId: products[0]?.id ?? '', qty: 1, unitPrice: 0, currency: 'USD' }] })}>+ Ligne</button>
      <div className="form c4 mt">
        <Field label="Acompte"><NumberInput value={order.depositPct} onChange={(v) => onChange({ ...order, depositPct: v })} unit="%" /></Field>
        <Field label="Paiements"><div className="row-flex" style={{ paddingTop: 6 }}><label className="small"><input type="checkbox" checked={order.depositPaid} onChange={(e) => onChange({ ...order, depositPaid: e.target.checked })} /> acompte payé</label><label className="small"><input type="checkbox" checked={order.balancePaid} onChange={(e) => onChange({ ...order, balancePaid: e.target.checked })} /> solde payé</label></div></Field>
        <Field label="Délai de production"><NumberInput value={order.productionDays} onChange={(v) => onChange({ ...order, productionDays: v })} unit="jours" /></Field>
        <Field label="Date de fin prévue"><Input type="date" value={order.expectedReadyDate} onChange={(v) => onChange({ ...order, expectedReadyDate: v })} /></Field>
        <Field label="Proforma (PI)"><Select value={order.proformaDocumentId ?? ''} onChange={(v) => onChange({ ...order, proformaDocumentId: v || null })} options={docOptions} /></Field>
        <Field label="Facture"><Select value={order.invoiceDocumentId ?? ''} onChange={(v) => onChange({ ...order, invoiceDocumentId: v || null })} options={docOptions} /></Field>
        <Field label="Packing list" span={2}><Select value={order.packingListDocumentId ?? ''} onChange={(v) => onChange({ ...order, packingListDocumentId: v || null })} options={docOptions} /></Field>
        <Field label="Notes (incoterm, frais annexes, colisage…)" span={3}><Textarea value={order.notes} onChange={(v) => onChange({ ...order, notes: v })} /></Field>
      </div>
      {order.expectedReadyDate === '' && order.productionDays > 0 && order.date && (
        <div className="small muted mt">Astuce : date de fin estimée = {fmtDate(addDays(order.date, order.productionDays))} <button className="btn small" onClick={() => onChange({ ...order, expectedReadyDate: addDays(order.date, order.productionDays) })}>Utiliser</button></div>
      )}
    </Modal>
  );
}

function addDays(date: string, days: number): string {
  const d = new Date(date); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10);
}
