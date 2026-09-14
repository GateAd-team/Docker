/**
 * Onglet « Emails » de Logistique : synchronise la boîte Gmail (transporteurs, agents, mots-clés),
 * classe les échanges par partenaire, permet de lire, rattacher à une expédition et importer les pièces jointes.
 */
import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useNav } from '../App';
import { api } from '../api';
import { useViewer } from '../components/Viewer';
import { Badge, ConfirmButton, Empty, Modal, fmtDate } from '../components/ui';
import { newId } from '../store';
import type { MailAnalysis, MailMessage, Partner } from '../../shared/types';
import { SHIPMENT_STATUS, statusOf } from '../labels';
import { shipmentForMail, suggestShipmentUpdate } from '../../shared/mailAnalysis';

/** Trouve le transporteur / agent correspondant à une adresse (partenaire ou contact), sinon par nom. */
export function partnerForMail(m: MailMessage, partners: Partner[], contacts: { ownerType: string; ownerId: string; email: string }[]): string | null {
  const addr = m.from.toLowerCase();
  const domain = addr.split('@')[1] ?? '';
  const byEmail = partners.find((p) => p.email && p.email.toLowerCase() === addr) ?? contacts.find((c) => c.ownerType === 'partner' && c.email && c.email.toLowerCase() === addr);
  if (byEmail) return 'ownerId' in byEmail ? byEmail.ownerId : byEmail.id;
  if (domain && !/gmail|outlook|hotmail|yahoo|qq\.com|163\.com|126\.com/.test(domain)) {
    const byDomain = partners.find((p) => p.email && p.email.toLowerCase().endsWith(`@${domain}`)) ?? contacts.find((c) => c.ownerType === 'partner' && c.email && c.email.toLowerCase().endsWith(`@${domain}`));
    if (byDomain) return 'ownerId' in byDomain ? byDomain.ownerId : byDomain.id;
  }
  const hay = `${m.fromName} ${m.from} ${m.subject}`.toLowerCase();
  const byName = partners.find((p) => p.name && hay.includes(p.name.toLowerCase().split(' ')[0]) && p.name.split(' ')[0].length > 3);
  return byName?.id ?? null;
}

export function MailsTab() {
  const { db, update, toast } = useStore();
  const { go } = useNav();
  const { open: openDoc } = useViewer();
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<{ result: MailAnalysis; keep: Record<string, boolean> } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const gmail = db.settings.gmail;
  const configured = gmail.mode === 'oauth' ? !!gmail.refreshToken : !!gmail.email && !!gmail.appPassword;
  const [over, setOver] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const importEmlFiles = async (files: File[]) => {
    const eml = files.filter((f) => /\.eml$/i.test(f.name));
    if (!eml.length) { toast('Dépose des fichiers .eml (Gmail : ⋮ → « Télécharger le message »)', true); return; }
    const payloads = await Promise.all(eml.map(async (f) => { const buf = new Uint8Array(await f.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return { name: f.name, base64: btoa(bin) }; }));
    const msgs = await api.mailImportEml(payloads);
    if (!msgs.length) { toast(api.isDemo ? 'Mode démo : import .eml indisponible' : 'Aucun message lisible', true); return; }
    const tagged = msgs.map((m) => ({ ...m, partnerId: partnerForMail(m, db.partners, db.contacts), shipmentId: m.shipmentId ?? shipmentForMail(m, db.shipments) }));
    update((d) => { let next = { ...d, mails: [...tagged.filter((t) => !d.mails.some((m) => m.id === t.id)), ...d.mails] }; for (const id of new Set(tagged.map((t) => t.shipmentId).filter(Boolean) as string[])) next = refreshFromMails(next, id).db; return next; });
    toast(`${tagged.length} email${tagged.length > 1 ? 's' : ''} importé${tagged.length > 1 ? 's' : ''} depuis les fichiers .eml`);
  };

  const sync = async () => {
    setBusy(true);
    try {
      const senders = [...new Set([...db.partners.map((p) => p.email), ...db.contacts.filter((c) => c.ownerType === 'partner').map((c) => c.email)].filter(Boolean))];
      const keywords = gmail.keywords.split(',').map((k) => k.trim()).filter(Boolean);
      // On relit toujours tout l'historique demandé (Réglages) : les emails déjà récupérés ou supprimés sont ignorés grâce à leur identifiant.
      const sinceDays = Math.max(1, gmail.historyDays || 730);
      const r = await api.mailSync({ senders, keywords, sinceDays, knownIds: [...db.mails.map((m) => m.id), ...(gmail.skipIds ?? [])] });
      const tagged = r.messages.map((m) => ({ ...m, partnerId: partnerForMail(m, db.partners, db.contacts), shipmentId: m.shipmentId ?? shipmentForMail(m, db.shipments) }));
      update((d) => { let next = { ...d, mails: [...tagged, ...d.mails.filter((m) => !tagged.some((t) => t.id === m.id))], settings: { ...d.settings, gmail: { ...d.settings.gmail, lastSync: new Date().toISOString() } } }; for (const id of new Set(tagged.map((t) => t.shipmentId).filter(Boolean) as string[])) next = refreshFromMails(next, id).db; return next; });
      const more = r.remaining > 0 ? ` — encore ${r.remaining} à récupérer, relance la synchronisation` : '';
      toast(tagged.length ? `${tagged.length} nouvel${tagged.length > 1 ? 's' : ''} email${tagged.length > 1 ? 's' : ''} récupéré${tagged.length > 1 ? 's' : ''} sur ${r.scanned} trouvé${r.scanned > 1 ? 's' : ''} dans Gmail (${sinceDays} derniers jours)${more}` : `Rien de nouveau : les ${r.scanned} emails trouvés dans Gmail (${sinceDays} derniers jours) sont déjà dans Docker`);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const setMail = (id: string, patch: Partial<MailMessage>) => update((d) => ({ ...d, mails: d.mails.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const importAttachment = async (m: MailMessage, index: number) => {
    setImporting(`${m.id}:${index}`);
    try {
      const doc = await api.mailAttachment(m.id, index);
      if (!doc) { toast(api.isDemo ? 'Mode démo : import des pièces jointes indisponible' : 'Pièce jointe introuvable', true); return; }
      const linked = [...doc.linkedTo, ...(m.partnerId ? [{ type: 'partner' as const, id: m.partnerId }] : []), ...(m.shipmentId ? [{ type: 'shipment' as const, id: m.shipmentId }] : [])];
      update((d) => ({ ...d, documents: [{ ...doc, linkedTo: linked }, ...d.documents], mails: d.mails.map((x) => (x.id === m.id ? { ...x, attachments: x.attachments.map((a) => (a.index === index ? { ...a, documentId: doc.id } : a)) } : x)) }));
      toast(`« ${doc.fileName} » ajouté aux Documents — tu peux l'analyser (devis, facture de fret…)`);
    } catch (e) { toast((e as Error).message, true); } finally { setImporting(null); }
  };

  /** ✨ Analyse IA des emails affichés : transporteurs, contacts, expéditions, bilan, actions → propositions à valider. */
  const analyze = async () => {
    const ids = mails.map((m) => m.id);
    if (!ids.length) { toast('Aucun email à analyser', true); return; }
    setAnalyzing(true);
    try {
      const result = await api.mailAnalyze(ids.slice(0, 60));
      const keep: Record<string, boolean> = {};
      result.partners.forEach((_, i) => { keep[`p${i}`] = true; });
      result.shipments.forEach((_, i) => { keep[`s${i}`] = true; });
      setAnalysis({ result, keep });
      if (ids.length > 60) toast('Analyse limitée aux 60 emails les plus récents du filtre — relance sur un autre filtre pour le reste');
    } catch (e) { toast((e as Error).message, true); } finally { setAnalyzing(false); }
  };
  const applyAnalysis = () => {
    if (!analysis) return;
    const { result, keep } = analysis;
    const now = new Date().toISOString();
    update((d) => {
      let partners = [...d.partners]; let contacts = [...d.contacts]; let shipments = [...d.shipments]; let mailsNext = [...d.mails];
      const partnerIdByName = new Map<string, string>();
      result.partners.forEach((p, i) => {
        if (!keep[`p${i}`]) return;
        const existing = (p.existingId && partners.find((x) => x.id === p.existingId)) || partners.find((x) => x.name.toLowerCase() === p.name.toLowerCase()) || (p.email && partners.find((x) => x.email && x.email.toLowerCase() === p.email.toLowerCase()));
        const actions = (p.actions ?? []).map((a) => ({ id: newId(), text: a.text, done: false, dueDate: a.dueDate ?? '', mailId: a.mailId ?? null }));
        let id: string;
        if (existing) {
          id = existing.id;
          const prevActions = existing.insights.actions.filter((a) => a.done || !actions.some((n) => n.text.toLowerCase() === a.text.toLowerCase()));
          partners = partners.map((x) => (x.id === id ? { ...x, email: x.email || p.email || '', phone: x.phone || p.phone || '', wechat: x.wechat || p.wechat || '', city: x.city || p.city || '', services: x.services || p.services || '', insights: { summary: p.summary || x.insights.summary, actions: [...prevActions, ...actions], analyzedAt: now } } : x));
        } else {
          id = newId();
          partners.push({ id, type: p.type === 'agent' ? 'agent' : 'transporteur', name: p.name, city: p.city ?? '', email: p.email ?? '', phone: p.phone ?? '', wechat: p.wechat ?? '', services: p.services ?? '', notes: '', insights: { summary: p.summary ?? '', actions, analyzedAt: now } });
        }
        partnerIdByName.set(p.name.toLowerCase(), id);
        if (p.contactName && !contacts.some((c) => c.ownerType === 'partner' && c.ownerId === id && (c.name.toLowerCase().includes(p.contactName.toLowerCase().split(' ')[0]) || (p.email && c.email && c.email.toLowerCase() === p.email.toLowerCase())))) contacts.push({ id: newId(), ownerType: 'partner', ownerId: id, name: p.contactName, role: p.contactRole ?? '', email: p.email ?? '', phone: p.phone ?? '', wechat: p.wechat ?? '', whatsapp: '' });
        for (const mid of p.mailIds ?? []) mailsNext = mailsNext.map((m) => (m.id === mid && !m.partnerId ? { ...m, partnerId: id } : m));
      });
      result.shipments.forEach((sh, i) => {
        if (!keep[`s${i}`]) return;
        const partnerId = partnerIdByName.get((sh.partnerName ?? '').toLowerCase()) ?? partners.find((x) => x.name.toLowerCase() === (sh.partnerName ?? '').toLowerCase())?.id ?? null;
        const nk = (s: string | undefined | null) => (s ?? '').toLowerCase().replace(/[\s\-_./]/g, '');
        const linkedId = (sh.mailIds ?? []).map((mid) => mailsNext.find((m) => m.id === mid)?.shipmentId).find(Boolean);
        const existing = (sh.existingId && shipments.find((x) => x.id === sh.existingId))
          || (linkedId && shipments.find((x) => x.id === linkedId))
          || shipments.find((x) => (nk(sh.containerNo) && nk(sh.containerNo).length >= 6 && (nk(x.trackingRef) === nk(sh.containerNo) || nk(x.notes).includes(nk(sh.containerNo)))) || (nk(sh.trackingRef) && nk(sh.trackingRef).length >= 6 && nk(x.trackingRef) === nk(sh.trackingRef)) || (nk(sh.reference) && nk(x.reference) === nk(sh.reference)));
        let id: string;
        if (existing) {
          id = existing.id;
          shipments = shipments.map((x) => (x.id === id ? { ...x, partnerId: x.partnerId ?? partnerId, etd: sh.etd || x.etd, eta: sh.eta || x.eta, status: sh.status || x.status, trackingRef: x.trackingRef || sh.trackingRef || sh.containerNo || '', cbm: x.cbm || sh.cbm || 0, weightKg: x.weightKg || sh.weightKg || 0, freightCost: x.freightCost || sh.freightCost || 0, insuranceCost: x.insuranceCost || sh.insuranceCost || 0, originFees: x.originFees || sh.originFees || 0, destinationFees: x.destinationFees || sh.destinationFees || 0, notes: sh.notes && !x.notes.includes(sh.notes) ? [x.notes, sh.notes].filter(Boolean).join(' ') : x.notes } : x));
        } else {
          id = newId();
          shipments.push({ id, projectId: null, reference: sh.reference, orderIds: [], partnerId, agentId: null, mode: sh.mode ?? 'mer', incoterm: sh.incoterm ?? 'FOB', status: sh.status, etd: sh.etd ?? '', eta: sh.eta ?? '', cbm: sh.cbm ?? 0, weightKg: sh.weightKg ?? 0, freightCost: sh.freightCost ?? 0, insuranceCost: sh.insuranceCost ?? 0, originFees: sh.originFees ?? 0, destinationFees: sh.destinationFees ?? 0, currency: sh.currency ?? 'USD', trackingRef: sh.trackingRef || sh.containerNo || '', documentId: null, notes: [sh.origin && sh.destination ? `${sh.origin} → ${sh.destination}.` : '', sh.containerNo ? `Conteneur ${sh.containerNo}.` : '', sh.notes].filter(Boolean).join(' ') });
        }
        for (const mid of sh.mailIds ?? []) mailsNext = mailsNext.map((m) => (m.id === mid && !m.shipmentId ? { ...m, shipmentId: id } : m));
      });
      return { ...d, partners, contacts, shipments, mails: mailsNext };
    });
    setAnalysis(null); toast('Transporteurs, expéditions et actions mis à jour');
  };

  const mails = useMemo(() => [...db.mails].sort((a, b) => b.date.localeCompare(a.date)).filter((m) => (filter === 'archived' ? !!m.archived : !m.archived && (filter === 'all' || (filter === 'none' ? !m.partnerId : filter.startsWith('ship:') ? m.shipmentId === filter.slice(5) : m.partnerId === filter))) && (!q || `${m.subject} ${m.fromName} ${m.from} ${m.text}`.toLowerCase().includes(q.toLowerCase()))), [db.mails, filter, q]);
  const active = db.mails.filter((m) => !m.archived);
  const counts = (id: string | null) => active.filter((m) => (id === null ? !m.partnerId : m.partnerId === id)).length;
  const archivedCount = db.mails.length - active.length;
  const unread = active.filter((m) => !m.read).length;
  const selected = mails.filter((m) => sel.has(m.id));
  const targets = selected.length ? selected : mails;
  const targetIds = new Set(targets.map((m) => m.id));
  const allSelected = mails.length > 0 && mails.every((m) => sel.has(m.id));
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(mails.map((m) => m.id)));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const bulk = (patch: Partial<MailMessage>, msg: string) => { update((d) => ({ ...d, mails: d.mails.map((m) => (targetIds.has(m.id) ? { ...m, ...patch } : m)) })); setSel(new Set()); toast(`${targets.length} email${targets.length > 1 ? 's' : ''} ${msg}`); };
  const bulkDelete = () => { update((d) => ({ ...d, mails: d.mails.filter((m) => !targetIds.has(m.id)), settings: { ...d.settings, gmail: { ...d.settings.gmail, skipIds: [...new Set([...(d.settings.gmail.skipIds ?? []), ...targetIds])] } } })); setSel(new Set()); toast(`${targets.length} email${targets.length > 1 ? 's' : ''} supprimé${targets.length > 1 ? 's' : ''}`); };
  const shipCount = (id: string) => active.filter((m) => m.shipmentId === id).length;
  /** Met à jour une expédition à partir des emails qui lui sont rattachés (statut qui avance, ETD/ETA lues dans les emails, du plus ancien au plus récent). */
  const refreshFromMails = (d: typeof db, shipmentId: string): { db: typeof db; changed: string[] } => {
    let s = d.shipments.find((x) => x.id === shipmentId);
    if (!s) return { db: d, changed: [] };
    const changed: string[] = [];
    for (const m of d.mails.filter((x) => x.shipmentId === shipmentId).sort((a, b) => a.date.localeCompare(b.date))) {
      const sug = suggestShipmentUpdate(m, s);
      if (sug.status) { changed.push(`statut → ${statusOf(SHIPMENT_STATUS, sug.status).label}`); s = { ...s, status: sug.status }; }
      if (sug.etd) { changed.push(`ETD ${fmtDate(sug.etd)}`); s = { ...s, etd: sug.etd }; }
      if (sug.eta) { changed.push(`ETA ${fmtDate(sug.eta)}`); s = { ...s, eta: sug.eta }; }
    }
    const final = s;
    return { db: changed.length ? { ...d, shipments: d.shipments.map((x) => (x.id === shipmentId ? final : x)) } : d, changed };
  };
  const linkToShipment = (shipmentId: string | null) => {
    let changed: string[] = [];
    update((d) => { const next = { ...d, mails: d.mails.map((m) => (targetIds.has(m.id) ? { ...m, shipmentId } : m)) }; if (!shipmentId) return next; const r = refreshFromMails(next, shipmentId); changed = r.changed; return r.db; });
    setSel(new Set());
    const n = targets.length;
    toast(shipmentId ? `${n} email${n > 1 ? 's' : ''} rattaché${n > 1 ? 's' : ''} à l'expédition${changed.length ? ` — mise à jour : ${[...new Set(changed)].join(', ')}` : ''}` : `${n} email${n > 1 ? 's' : ''} détaché${n > 1 ? 's' : ''}`);
  };
  const autoLink = () => { let n = 0; update((d) => { const touched = new Set<string>(); let next = { ...d, mails: d.mails.map((m) => { if (m.shipmentId) return m; const id = shipmentForMail(m, d.shipments); if (id) { n++; touched.add(id); } return id ? { ...m, shipmentId: id } : m; }) }; for (const id of touched) next = refreshFromMails(next, id).db; return next; }); toast(n ? `${n} email${n > 1 ? 's' : ''} rattaché${n > 1 ? 's' : ''} automatiquement (n° de conteneur / suivi trouvé dans l'email)` : 'Aucun email ne mentionne un n° de conteneur, de suivi ou une référence d\'expédition connue'); };
  const applySuggestion = (shipmentId: string, sug: { status: string | null; etd: string; eta: string }) => { update((d) => ({ ...d, shipments: d.shipments.map((s) => (s.id === shipmentId ? { ...s, status: (sug.status as typeof s.status) ?? s.status, etd: sug.etd || s.etd, eta: sug.eta || s.eta } : s)) })); toast('Expédition mise à jour'); };
  const scope = selected.length ? `${selected.length} sélectionné${selected.length > 1 ? 's' : ''}` : `les ${mails.length} affichés`;

  return (
    <div className="card">
      <div className="card-head">
        <div><h2>Emails transporteurs & agents</h2><div className="small muted">{configured ? <>Boîte <b>{gmail.email}</b>{gmail.label ? <> · libellé <b>{gmail.label}</b></> : ''}{gmail.lastSync ? ` · dernière synchro ${new Date(gmail.lastSync).toLocaleString('fr-FR')}` : ''} · {db.mails.length} email{db.mails.length > 1 ? 's' : ''}{unread ? ` · ${unread} non lu${unread > 1 ? 's' : ''}` : ''}</> : <>Connecte ta boîte Gmail dans <a style={{ cursor: 'pointer' }} onClick={() => go('settings')}>Réglages</a> pour récupérer automatiquement les échanges avec tes transporteurs et agents.</>}</div></div>
        <div className="row-flex">
          <input className="search" placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.accept = '.eml'; input.onchange = () => importEmlFiles([...(input.files ?? [])]); input.click(); }} title="Sans connexion : dans Gmail, ⋮ → Télécharger le message, puis dépose les fichiers .eml ici">⇩ Importer des .eml</button>
          <button className="btn primary" disabled={busy || (!configured && !api.isDemo)} onClick={sync}>{busy ? <><span className="spinner" /> Synchronisation…</> : '↻ Synchroniser Gmail'}</button>
          <button className="btn primary" disabled={analyzing || db.mails.length === 0} onClick={analyze} title="L'IA lit les emails affichés et en tire : transporteurs et agents (coordonnées, contacts), expéditions (conteneur, ETD/ETA, coûts), bilan par partenaire et choses à faire">{analyzing ? <><span className="spinner" /> Analyse…</> : '✨ Analyser les emails'}</button>
        </div>
      </div>
      <div className={`dropzone mb${over ? ' over' : ''}`} style={{ padding: 10 }} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); importEmlFiles([...e.dataTransfer.files]); }}>
        <span className="small muted">Sans connexion Gmail : dans Gmail, ouvre un mail → ⋮ → « Télécharger le message », puis glisse les fichiers .eml ici (pièces jointes incluses).</span>
      </div>

      {db.mails.length > 0 && (
        <div className="row-flex mb" style={{ flexWrap: 'wrap', gap: 6 }}>
          <button className={`chip${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>Tous ({active.length})</button>
          {db.partners.filter((p) => counts(p.id) > 0).map((p) => <button key={p.id} className={`chip${filter === p.id ? ' on' : ''}`} onClick={() => setFilter(p.id)}>{p.type === 'agent' ? '🧑‍💼' : '⛴'} {p.name} ({counts(p.id)})</button>)}
          {counts(null) > 0 && <button className={`chip${filter === 'none' ? ' on' : ''}`} onClick={() => setFilter('none')}>Non attribués ({counts(null)})</button>}
          {db.shipments.filter((s) => shipCount(s.id) > 0).map((s) => <button key={s.id} className={`chip${filter === `ship:${s.id}` ? ' on' : ''}`} onClick={() => setFilter(`ship:${s.id}`)}>📦 {s.reference || 'Expédition'} ({shipCount(s.id)})</button>)}
          {archivedCount > 0 && <button className={`chip${filter === 'archived' ? ' on' : ''}`} onClick={() => setFilter('archived')}>🗄 Archivés ({archivedCount})</button>}
        </div>
      )}
      {mails.length > 0 && (
        <div className="row-flex mb small" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <label className="row-flex" style={{ gap: 6, cursor: 'pointer' }}><input type="checkbox" checked={allSelected} onChange={toggleAll} /> Tout sélectionner</label>
          <span className="muted">· Action sur {scope} :</span>
          {targets.some((m) => !m.read) ? <button className="btn small" onClick={() => bulk({ read: true }, 'marqués lus')}>✓ Marquer comme lus</button> : <button className="btn small" onClick={() => bulk({ read: false }, 'marqués non lus')}>Marquer non lus</button>}
          {filter === 'archived' ? <button className="btn small" onClick={() => bulk({ archived: false }, 'désarchivés')}>↩ Désarchiver</button> : <button className="btn small" onClick={() => bulk({ archived: true, read: true }, 'archivés')}>🗄 Archiver</button>}
          {db.shipments.length > 0 && <select className="btn small" value="" onChange={(e) => { if (e.target.value === '-') linkToShipment(null); else if (e.target.value) linkToShipment(e.target.value); }}><option value="">📦 Rattacher à une expédition…</option>{db.shipments.map((s) => <option key={s.id} value={s.id}>{s.reference || s.id}{s.trackingRef ? ` · ${s.trackingRef}` : ''}</option>)}<option value="-">— Détacher —</option></select>}
          <button className="btn small" onClick={autoLink} title="Cherche dans chaque email un n° de conteneur, de suivi ou une référence d'expédition connue">🔗 Associer automatiquement</button>
          <ConfirmButton label={`🗑 Supprimer${selected.length ? ` (${selected.length})` : ''}`} className="btn small danger" onConfirm={bulkDelete} />
        </div>
      )}

      {filter !== 'all' && filter !== 'none' && (() => { const p = db.partners.find((x) => x.id === filter); if (!p || (!p.insights.summary && !p.insights.actions.length)) return null; return (
        <div className="insights mb">
          <div className="row-flex"><b>Bilan {p.name}</b><span className="muted small">analysé le {fmtDate(p.insights.analyzedAt.slice(0, 10))}</span></div>
          {p.insights.summary && <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{p.insights.summary}</div>}
          {p.insights.actions.length > 0 && <div className="mt small"><b>À faire</b>{p.insights.actions.map((a) => <label key={a.id} className="check" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={a.done} onChange={(e) => update((d) => ({ ...d, partners: d.partners.map((x) => (x.id === p.id ? { ...x, insights: { ...x.insights, actions: x.insights.actions.map((y) => (y.id === a.id ? { ...y, done: e.target.checked } : y)) } } : x)) }))} /><span style={a.done ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{a.text}{a.dueDate ? <span className="muted"> · {fmtDate(a.dueDate)}</span> : null}{a.mailId && <a style={{ cursor: 'pointer', marginLeft: 6 }} onClick={() => setOpenId(a.mailId)}>voir l'email</a>}</span></label>)}</div>}
        </div>
      ); })()}
      {db.mails.length === 0 ? (
        <Empty icon="✉" title="Aucun email récupéré" text={configured || api.isDemo ? gmail.label ? `Clique « Synchroniser Gmail » : Docker lit tous les emails du libellé « ${gmail.label} ».` : 'Clique « Synchroniser Gmail » : Docker cherche les échanges avec tes transporteurs et agents (adresses de Logistique) et les objets contenant tes mots-clés (fret, booking, ETA…). Astuce : dans Réglages, indique un libellé Gmail pour lui dire exactement où chercher.' : 'Renseigne d\'abord ton adresse Gmail et un mot de passe d\'application dans Réglages.'} />
      ) : mails.length === 0 ? <div className="muted small">Aucun email pour ce filtre.</div> : (
        <div className="mail-list">
          {mails.map((m) => {
            const partner = db.partners.find((p) => p.id === m.partnerId);
            const shipment = db.shipments.find((s) => s.id === m.shipmentId);
            const open = openId === m.id;
            return (
              <div key={m.id} className={`mail-row${open ? ' open' : ''}${m.read ? '' : ' unread'}`}>
                <div className="mail-head" onClick={() => { setOpenId(open ? null : m.id); if (!m.read) setMail(m.id, { read: true }); }}>
                  <input type="checkbox" checked={sel.has(m.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(m.id)} style={{ margin: 0 }} />
                  <span className="mail-date">{fmtDate(m.date.slice(0, 10))}</span>
                  <span className="mail-from" title={m.from}>{m.fromName || m.from}</span>
                  <span className="mail-subject">{m.subject}</span>
                  <span className="mail-tags">
                    {partner ? <Badge tone="blue">{partner.name}</Badge> : <Badge>non attribué</Badge>}
                    {shipment && <Badge tone="green">{shipment.reference}</Badge>}
                    {m.attachments.length > 0 && <span className="muted small">📎 {m.attachments.length}</span>}
                  </span>
                </div>
                {open && (
                  <div className="mail-body">
                    <div className="row-flex small mb" style={{ flexWrap: 'wrap' }}>
                      <label className="muted">Transporteur / agent</label>
                      <select value={m.partnerId ?? ''} onChange={(e) => setMail(m.id, { partnerId: e.target.value || null })}><option value="">— Non attribué —</option>{db.partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                      <label className="muted">Expédition</label>
                      <select value={m.shipmentId ?? ''} onChange={(e) => { const sid = e.target.value || null; let changed: string[] = []; update((d) => { const next = { ...d, mails: d.mails.map((x) => (x.id === m.id ? { ...x, shipmentId: sid } : x)) }; if (!sid) return next; const r = refreshFromMails(next, sid); changed = r.changed; return r.db; }); if (changed.length) toast(`Expédition mise à jour : ${[...new Set(changed)].join(', ')}`); }}><option value="">— Aucune —</option>{db.shipments.map((s) => <option key={s.id} value={s.id}>{s.reference || s.id}</option>)}</select>
                      <span style={{ flex: 1 }} />
                      <span className="muted">à : {m.to}</span>
                      <ConfirmButton label="🗑" className="btn ghost small" onConfirm={() => update((d) => ({ ...d, mails: d.mails.filter((x) => x.id !== m.id), settings: { ...d.settings, gmail: { ...d.settings.gmail, skipIds: [...new Set([...(d.settings.gmail.skipIds ?? []), m.id])] } } }))} />
                    </div>
                    {shipment && (() => { const sug = suggestShipmentUpdate(m, shipment); const st = statusOf(SHIPMENT_STATUS, shipment.status); const has = sug.status || sug.etd || sug.eta; return (
                      <div className="insights small mb" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <span>📦 <b>{shipment.reference || 'Expédition'}</b> · statut actuel <Badge tone={st.tone}>{st.label}</Badge>{shipment.etd ? ` · ETD ${fmtDate(shipment.etd)}` : ''}{shipment.eta ? ` · ETA ${fmtDate(shipment.eta)}` : ''}</span>
                        <span style={{ flex: 1 }} />
                        {has ? <>
                          <span>Cet email indique :{sug.status ? <> statut → <b>{statusOf(SHIPMENT_STATUS, sug.status).label}</b>{sug.evidence ? <span className="muted"> (« {sug.evidence} »)</span> : null}</> : null}{sug.etd ? <> · ETD <b>{fmtDate(sug.etd)}</b></> : null}{sug.eta ? <> · ETA <b>{fmtDate(sug.eta)}</b></> : null}</span>
                          <button className="btn primary small" onClick={() => applySuggestion(shipment.id, sug)}>✓ Appliquer à l'expédition</button>
                        </> : <span className="muted">Rien de nouveau détecté pour le statut.</span>}
                        <label className="muted">Changer :</label>
                        <select value={shipment.status} onChange={(e) => { update((d) => ({ ...d, shipments: d.shipments.map((s) => (s.id === shipment.id ? { ...s, status: e.target.value as typeof s.status } : s)) })); toast('Statut de l\'expédition mis à jour'); }}>{SHIPMENT_STATUS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
                        <a style={{ cursor: 'pointer' }} onClick={() => go('logistics', shipment.id)}>ouvrir</a>
                      </div>
                    ); })()}
                    {m.attachments.length > 0 && (
                      <div className="row-flex mb" style={{ flexWrap: 'wrap', gap: 6 }}>
                        {m.attachments.map((a) => a.documentId ? (
                          <button key={a.index} className="btn small" onClick={() => openDoc(a.documentId!)}>📄 {a.filename} <span className="muted">(importé)</span></button>
                        ) : (
                          <button key={a.index} className="btn small" disabled={importing === `${m.id}:${a.index}`} onClick={() => importAttachment(m, a.index)}>{importing === `${m.id}:${a.index}` ? <><span className="spinner" /> Import…</> : <>⇩ {a.filename} <span className="muted">({Math.round(a.size / 1024)} Ko)</span></>}</button>
                        ))}
                      </div>
                    )}
                    <pre className="mail-text">{m.text || '(pas de texte)'}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {analysis && (
        <Modal title="Ce que l'IA a compris de tes emails" onClose={() => setAnalysis(null)} wide footer={<><button className="btn" onClick={() => setAnalysis(null)}>Annuler</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={applyAnalysis}>Enregistrer ce qui est coché</button></>}>
          {analysis.result.overview && <div className="dup-banner" style={{ whiteSpace: 'pre-wrap' }}><b>Vue d'ensemble</b><br />{analysis.result.overview}</div>}
          <h3 className="mt">Transporteurs & agents ({analysis.result.partners.length})</h3>
          {analysis.result.partners.length === 0 && <div className="muted small">Aucun partenaire identifié.</div>}
          {analysis.result.partners.map((p, i) => { const ex = p.existingId ? db.partners.find((x) => x.id === p.existingId) : null; return (
            <label key={i} className="check" style={{ alignItems: 'flex-start', display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <input type="checkbox" checked={analysis.keep[`p${i}`] ?? true} onChange={(e) => setAnalysis({ ...analysis, keep: { ...analysis.keep, [`p${i}`]: e.target.checked } })} />
              <span style={{ flex: 1 }}>
                <b>{p.name}</b> <Badge tone={p.type === 'agent' ? 'amber' : 'blue'}>{p.type}</Badge> {ex ? <Badge tone="green">met à jour « {ex.name} »</Badge> : <Badge>nouveau</Badge>}
                <div className="small muted">{[p.contactName && `${p.contactName}${p.contactRole ? ` (${p.contactRole})` : ''}`, p.email, p.phone, p.wechat && `WeChat ${p.wechat}`, p.city, p.services].filter(Boolean).join(' · ')}</div>
                {p.summary && <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{p.summary}</div>}
                {p.actions?.length > 0 && <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>{p.actions.map((a, j) => <li key={j}>☐ {a.text}{a.dueDate ? <span className="muted"> · {fmtDate(a.dueDate)}</span> : null}</li>)}</ul>}
                <div className="muted" style={{ fontSize: 11 }}>{p.mailIds?.length ?? 0} email{(p.mailIds?.length ?? 0) > 1 ? 's' : ''} rattaché{(p.mailIds?.length ?? 0) > 1 ? 's' : ''}</div>
              </span>
            </label>
          ); })}
          <h3 className="mt">Expéditions ({analysis.result.shipments.length})</h3>
          {analysis.result.shipments.length === 0 && <div className="muted small">Aucune expédition identifiée.</div>}
          {analysis.result.shipments.map((sh, i) => { const ex = sh.existingId ? db.shipments.find((x) => x.id === sh.existingId) : null; const st = statusOf(SHIPMENT_STATUS, sh.status); return (
            <label key={i} className="check" style={{ alignItems: 'flex-start', display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <input type="checkbox" checked={analysis.keep[`s${i}`] ?? true} onChange={(e) => setAnalysis({ ...analysis, keep: { ...analysis.keep, [`s${i}`]: e.target.checked } })} />
              <span style={{ flex: 1 }}>
                <b>{sh.reference}</b> <Badge tone={st.tone}>{st.label}</Badge> {ex ? <Badge tone="green">met à jour « {ex.reference} »</Badge> : <Badge>nouvelle</Badge>}
                <div className="small muted">{[sh.partnerName, sh.containerNo && `conteneur ${sh.containerNo}`, sh.origin && sh.destination && `${sh.origin} → ${sh.destination}`, sh.etd && `ETD ${fmtDate(sh.etd)}`, sh.eta && `ETA ${fmtDate(sh.eta)}`, sh.freightCost != null && `fret ${sh.freightCost} ${sh.currency}`, sh.cbm != null && `${sh.cbm} m³`].filter(Boolean).join(' · ')}</div>
                {sh.notes && <div className="small" style={{ marginTop: 2 }}>{sh.notes}</div>}
              </span>
            </label>
          ); })}
        </Modal>
      )}
    </div>
  );
}
