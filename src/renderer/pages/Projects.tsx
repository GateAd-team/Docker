/**
 * Importations : chaque importation (= un conteneur / un départ groupé) rassemble les commandes passées à différentes usines
 * qui partent dans le même conteneur (ou en même temps), avec leurs expéditions et documents.
 */
import React, { useEffect, useState } from 'react';
import { newId, today, useStore } from '../store';
import { useNav } from '../App';
import { useViewer } from '../components/Viewer';
import { Badge, ConfirmButton, Empty, Field, Input, Modal, NumberInput, Select, Stars, Tabs, Textarea, Timeline, fmtDate, daysUntil } from '../components/ui';
import { MODE_LABELS, ORDER_STATUS, PROJECT_STATUS, SHIPMENT_STATUS, statusOf } from '../labels';
import type { Database, DocumentRecord, ExtractionResult, Order, Product, Project, ProjectFlow, Shipment } from '../../shared/types';
import { FLOW_STATUS, FR, FlowGraph } from '../components/FlowGraph';
import { explodeNeeds, factoryLinePrice, generateFlows, includedInParentPrice, canonicalProductId, orderedQuantities, proposeContents, type ContentProposal } from '../../shared/importFlows';
import { effectiveComponents, formatEur, formatMoney, fromEur, lineCbm, orderTotalEur, shipmentTotalEur, toEur, unitCost } from '../../shared/finance';
import { OrderModal } from './Factories';
import { ShipmentModal } from './Logistics';
import { ReviewModal, removeDocument } from './Documents';
import { NegotiationTab } from './Negotiation';
import { api } from '../api';
import { KIND_LABELS } from '../../shared/extraction';
import { projectFinance, sellPriceHtForMargin, type ProjectFinance } from '../../shared/projectFinance';

const CONTAINERS = ['20GP', '40GP', '40HQ', 'LCL (groupage)', 'Aérien', 'Express'];

export function orderCbm(o: Order, db: Database): number {
  return o.lines.reduce((t, l) => t + lineCbm(db.products.find((p) => p.id === l.productId), l.qty), 0);
}

export function projectOrders(db: Database, projectId: string): Order[] {
  return db.orders.filter((o) => o.projectId === projectId).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

export function projectShipments(db: Database, projectId: string) {
  const orderIds = new Set(projectOrders(db, projectId).map((o) => o.id));
  return db.shipments.filter((s) => s.projectId === projectId || s.orderIds.some((id) => orderIds.has(id)));
}

/** Dates de transport d'une importation, lues sur ses expéditions (Logistique) : départ = première ETD, livraison = dernière ETA. */
export function projectTransit(db: Database, projectId: string): { etd: string; eta: string; status: Shipment['status'] | null; shipments: Shipment[] } {
  const ships = projectShipments(db, projectId);
  const etd = ships.map((s) => s.etd).filter(Boolean).sort()[0] ?? '';
  const eta = ships.map((s) => s.eta).filter(Boolean).sort().at(-1) ?? '';
  const order: Shipment['status'][] = ['planifiee', 'collectee', 'en_transit', 'dedouanement', 'livree'];
  const status = ships.length ? ships.map((s) => s.status).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] : null;
  return { etd, eta, status, shipments: ships };
}

const blankProject = (): Project => ({ id: newId(), name: '', description: '', status: 'sourcing', targetDate: '', container: '40HQ', notes: '', flows: [], layout: {}, contents: [], consolidatorFactoryId: null, docLinks: [], negotiations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

export function ProjectsPage() {
  const { db, update, toast } = useStore();
  const { nav, go } = useNav();
  const [edit, setEdit] = useState<Project | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const save = () => {
    if (!edit?.name.trim()) return;
    const p = { ...edit, updatedAt: new Date().toISOString() };
    update((d) => ({ ...d, projects: d.projects.some((x) => x.id === p.id) ? d.projects.map((x) => (x.id === p.id ? p : x)) : [...d.projects, p] }));
    setEdit(null); toast('Importation enregistrée');
  };

  if (nav.id) {
    const project = db.projects.find((p) => p.id === nav.id);
    if (project) return <ProjectDetail project={project} onEdit={() => setEdit(project)} edit={edit} setEdit={setEdit} onSave={save} />;
  }

  const projects = [...db.projects].filter((p) => showArchived || p.status !== 'archive').sort((a, b) => (b.targetDate || b.createdAt).localeCompare(a.targetDate || a.createdAt));

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Importations</h1><div className="sub">Une importation = un conteneur ou un départ groupé : toutes les commandes, de toutes les usines, qui partent ensemble.</div></div>
        <div className="actions">
          <label className="small muted"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> voir les archivés</label>
          <button className="btn primary" onClick={() => setEdit(blankProject())}>+ Importation</button>
        </div>
      </div>

      {projects.length === 0 ? <div className="card"><Empty icon="▣" title="Aucune importation" text="Crée une importation par conteneur (ex. « Conteneur 40HQ — octobre 2026 ») puis rattache-lui les commandes des différentes usines. À la lecture d'une facture ou d'une proforma, Bao te la proposera directement." /></div> : (
        <div className="grid c2">
          {projects.map((p) => {
            const orders = projectOrders(db, p.id);
            const factories = [...new Set(orders.map((o) => o.factoryId))].map((id) => db.factories.find((f) => f.id === id)?.name).filter(Boolean);
            const total = orders.reduce((t, o) => t + orderTotalEur(o, db.settings), 0);
            const cbm = orders.reduce((t, o) => t + orderCbm(o, db), 0);
            const transit = projectTransit(db, p.id);
            const ships = transit.shipments;
            const ps = statusOf(PROJECT_STATUS, p.status);
            const ss = transit.status ? statusOf(SHIPMENT_STATUS, transit.status) : null;
            const ready = orders.filter((o) => ['prete', 'expediee', 'livree'].includes(o.status)).length;
            const lastReady = orders.map((o) => o.expectedReadyDate).filter(Boolean).sort().at(-1);
            const etdDays = daysUntil(transit.etd); const etaDays = daysUntil(transit.eta);
            const carrier = ships.map((s) => db.partners.find((x) => x.id === s.partnerId)?.name).filter(Boolean)[0];
            const logistics = ships.reduce((t, s) => t + shipmentTotalEur(s, db.settings), 0);
            return (
              <div key={p.id} className="card click" style={{ cursor: 'pointer' }} onClick={() => go('projects', p.id)}>
                <div className="card-head">
                  <h2>{p.name}</h2>
                  <div className="row-flex"><Badge tone={ps.tone}>{ps.label}</Badge>{p.container && <Badge>{p.container}</Badge>}{ss && <Badge tone={ss.tone}>⛴ {ss.label}</Badge>}</div>
                </div>
                {p.description && <div className="small muted mb">{p.description}</div>}
                <div className="grid c3 stats-sm">
                  <div className="stat"><div className="label">Commandes</div><div className="value">{orders.length}</div><div className="hint">{factories.length ? `${factories.length} usine${factories.length > 1 ? 's' : ''} · ${ready}/${orders.length} prête${ready > 1 ? 's' : ''}` : 'aucune usine'}</div></div>
                  <div className="stat"><div className="label">Marchandise</div><div className="value">{formatEur(total, 0)}</div><div className="hint">{cbm > 0 ? `${cbm.toFixed(1)} m³` : 'volume inconnu'}</div></div>
                  <div className="stat"><div className="label">Transport</div><div className="value">{logistics ? formatEur(logistics, 0) : '—'}</div><div className="hint">{ships.length ? `${ships.length} expédition${ships.length > 1 ? 's' : ''}` : 'aucune expédition'}</div></div>
                  <div className="stat"><div className="label">Total</div><div className="value">{formatEur(total + logistics, 0)}</div><div className="hint">{total > 0 && logistics > 0 ? `transport ${Math.round((logistics / (total + logistics)) * 100)} %` : 'marchandise + transport'}</div></div>
                  <div className="stat"><div className="label">{transit.etd ? 'Expédition' : 'Départ visé'}</div><div className="value">{transit.etd ? fmtDate(transit.etd) : p.targetDate ? fmtDate(p.targetDate) : '—'}</div><div className="hint">{transit.etd ? (etdDays != null && etdDays > 0 ? `dans ${etdDays} j${carrier ? ` · ${carrier}` : ''}` : carrier || 'parti') : ships.length ? `${ships.length} expédition${ships.length > 1 ? 's' : ''} sans date` : lastReady ? `production finie le ${fmtDate(lastReady)}` : 'pas encore réservé'}</div></div>
                  <div className="stat"><div className="label">Livraison</div><div className="value">{transit.eta ? fmtDate(transit.eta) : '—'}</div><div className="hint">{transit.eta ? (transit.status === 'livree' ? 'livré' : etaDays != null ? (etaDays < 0 ? `retard ${-etaDays} j` : `dans ${etaDays} j`) : '') : ships.length ? 'ETA inconnue' : 'aucune expédition'}</div></div>
                </div>
                <FinanceStrip project={p} />
                {factories.length > 0 && <div className="small muted mt">{factories.join(' · ')}</div>}
              </div>
            );
          })}
        </div>
      )}


      {edit && <ProjectModal project={edit} onChange={setEdit} onClose={() => setEdit(null)} onSave={save} />}
    </div>
  );
}

function ProjectModal({ project, onChange, onClose, onSave }: { project: Project; onChange: (p: Project) => void; onClose: () => void; onSave: () => void }) {
  const { db, update } = useStore();
  const { go } = useNav();
  const exists = db.projects.some((x) => x.id === project.id);
  const remove = () => {
    update((d) => ({ ...d, projects: d.projects.filter((x) => x.id !== project.id), orders: d.orders.map((o) => (o.projectId === project.id ? { ...o, projectId: '' } : o)), shipments: d.shipments.map((s) => (s.projectId === project.id ? { ...s, projectId: null } : s)) }));
    onClose(); go('projects');
  };
  return (
    <Modal title={exists ? "Modifier l'importation" : 'Nouvelle importation'} onClose={onClose}
      footer={<>{exists && <ConfirmButton label="Supprimer l'importation" onConfirm={remove} />}<span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Annuler</button><button className="btn primary" disabled={!project.name.trim()} onClick={onSave}>Enregistrer</button></>}>
      <div className="form c2">
        <Field label="Nom" span={2}><Input value={project.name} onChange={(v) => onChange({ ...project, name: v })} placeholder="ex. Conteneur 40HQ — octobre 2026" /></Field>
        <Field label="Statut"><Select value={project.status} onChange={(v) => onChange({ ...project, status: v })} options={PROJECT_STATUS.map((s) => ({ value: s.value, label: s.label }))} /></Field>
        <Field label="Départ visé"><Input type="date" value={project.targetDate} onChange={(v) => onChange({ ...project, targetDate: v })} /></Field>
        <Field label="Conteneur / mode"><input list="container-types" value={project.container} onChange={(e) => onChange({ ...project, container: e.target.value })} placeholder="40HQ, 20GP, LCL…" /><datalist id="container-types">{CONTAINERS.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Usine qui charge le conteneur (groupage)" span={2}><Select value={project.consolidatorFactoryId ?? ''} onChange={(v) => onChange({ ...project, consolidatorFactoryId: v || null })} options={[{ value: '', label: '— Chaque usine expédie directement vers la France —' }, ...db.factories.map((f) => ({ value: f.id, label: f.name }))]} /></Field>
        <Field label="Description" span={2}><Textarea value={project.description} onChange={(v) => onChange({ ...project, description: v })} /></Field>
        <Field label="Notes" span={2}><Textarea value={project.notes} onChange={(v) => onChange({ ...project, notes: v })} /></Field>
      </div>
      {exists && <div className="small muted mt">Supprimer l'importation ne supprime pas les commandes : elles redeviennent « sans importation ».</div>}
    </Modal>
  );
}

function ProjectDetail({ project, onEdit, edit, setEdit, onSave }: { project: Project; onEdit: () => void; edit: Project | null; setEdit: (p: Project | null) => void; onSave: () => void }) {
  const { db, update, toast } = useStore();
  const { go } = useNav();
  const { open: openDoc } = useViewer();
  const [order, setOrder] = useState<Order | null>(null);
  const [tab, setTab] = useState<'flux' | 'negociation' | 'commandes' | 'expeditions' | 'documents' | 'finance'>('flux');
  const [flow, setFlow] = useState<ProjectFlow | null>(null);
  const [linkDocs, setLinkDocs] = useState<string | null>(null);
  const [shipmentEdit, setShipmentEdit] = useState<Shipment | null>(null);
  /** Lecture IA des documents depuis l'onglet Documents de l'importation : l'importation est pré-sélectionnée dans la validation. */
  const [docReview, setDocReview] = useState<{ doc: DocumentRecord; result: ExtractionResult } | null>(null);
  const [docQueue, setDocQueue] = useState<string[]>([]);
  const [docBusy, setDocBusy] = useState<string | null>(null);
  const analyseDoc = async (doc: DocumentRecord): Promise<boolean> => {
    setDocBusy(doc.id);
    try {
      const raw = await api.extractDocument(doc.id);
      const result = raw.kind === 'facture' && (raw.data as { isProforma?: boolean }).isProforma ? { ...raw, kind: 'proforma' as const } : raw;
      setDocReview({ doc, result }); return true;
    } catch (e) { toast((e as Error).message, true); return false; } finally { setDocBusy(null); }
  };
  const analyseDocs = async (ids: string[], all: DocumentRecord[]) => {
    const list = ids.map((id) => all.find((d) => d.id === id)).filter((d): d is DocumentRecord => !!d);
    if (!list.length) return;
    setDocQueue(list.slice(1).map((d) => d.id));
    await analyseDoc(list[0]);
  };
  const nextDoc = async () => {
    let rest = [...docQueue];
    while (rest.length) { const id = rest.shift()!; setDocQueue(rest); const doc = db.documents.find((d) => d.id === id); if (doc && (await analyseDoc(doc))) return; }
    setDocQueue([]);
  };
  const [contentsEdit, setContentsEdit] = useState<{ lines: (ContentProposal | { productId: string; qty: number; kind: 'manual'; reason: string })[]; fromProposal: boolean } | null>(null);
  useEffect(() => { setOrder(null); }, [project.id]);

  const orders = projectOrders(db, project.id);
  const ships = projectShipments(db, project.id);
  const total = orders.reduce((t, o) => t + orderTotalEur(o, db.settings), 0);
  const cbm = orders.reduce((t, o) => t + orderCbm(o, db), 0);
  const logistics = ships.reduce((t, s) => t + shipmentTotalEur(s, db.settings), 0);
  const ps = statusOf(PROJECT_STATUS, project.status);
  const byFactory = [...new Set(orders.map((o) => o.factoryId))].map((fid) => ({ factory: db.factories.find((f) => f.id === fid), orders: orders.filter((o) => o.factoryId === fid) }));
  const docIds = new Set<string>();
  for (const o of orders) for (const id of [o.proformaDocumentId, o.invoiceDocumentId, o.packingListDocumentId]) if (id) docIds.add(id);
  for (const s of ships) if (s.documentId) docIds.add(s.documentId);
  const docs = db.documents.filter((d) => docIds.has(d.id) || d.linkedTo.some((l) => l.type === 'project' && l.id === project.id) || project.docLinks.some((l) => l.documentId === d.id));
  const lastReady = orders.map((o) => o.expectedReadyDate).filter(Boolean).sort().at(-1);
  const candidates = db.orders.filter((o) => o.projectId !== project.id);

  const saveOrder = () => {
    if (!order) return;
    update((d) => ({ ...d, orders: d.orders.some((x) => x.id === order.id) ? d.orders.map((x) => (x.id === order.id ? order : x)) : [...d.orders, order] }));
    setOrder(null); toast('Commande enregistrée');
  };
  const blankFlow = (from?: string): ProjectFlow => ({ id: newId(), fromFactoryId: from ?? byFactory[0]?.factory?.id ?? db.factories[0]?.id ?? '', to: FR, lines: [], date: '', status: 'prevu', note: '' });
  const saveFlow = (f: ProjectFlow) => {
    update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, flows: p.flows.some((x) => x.id === f.id) ? p.flows.map((x) => (x.id === f.id ? f : x)) : [...p.flows, f] } : p)) }));
    setFlow(null); toast('Flux enregistré');
  };
  const saveContents = (lines: { productId: string; qty: number }[], andGenerate: boolean) => {
    const contents = lines.filter((l) => l.productId && l.qty > 0).map((l) => ({ productId: l.productId, qty: l.qty }));
    update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, contents, flows: andGenerate ? generateFlows(d, { ...p, contents }, contents, newId, today()) : p.flows } : p)) }));
    setContentsEdit(null); toast(andGenerate ? 'Contenu enregistré et arborescence générée' : 'Contenu enregistré');
  };
  const regenerateFlows = () => {
    update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, flows: generateFlows(d, p, p.contents, newId, today()) } : p)) }));
    toast('Arborescence régénérée depuis les compositions');
  };
  const deleteFlow = (id: string) => { update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, flows: p.flows.filter((x) => x.id !== id) } : p)) })); setFlow(null); };
  const detach = (o: Order) => { update((d) => ({ ...d, orders: d.orders.map((x) => (x.id === o.id ? { ...x, projectId: '' } : x)) })); toast('Commande retirée de l\'importation'); };
  const attach = (id: string) => { update((d) => ({ ...d, orders: d.orders.map((x) => (x.id === id ? { ...x, projectId: project.id } : x)) })); toast('Commande ajoutée à l\'importation'); };
  const otherShips = db.shipments.filter((s) => !ships.some((x) => x.id === s.id));
  const newShipment = () => setShipmentEdit({ id: newId(), projectId: project.id, reference: project.container ? `${project.name} · ${project.container}` : project.name, orderIds: orders.map((o) => o.id), partnerId: db.partners.find((p) => p.type === 'transporteur')?.id ?? null, agentId: null, mode: 'mer', incoterm: 'FOB', status: 'planifiee', etd: project.targetDate || '', eta: '', cbm: Math.round(cbm * 100) / 100, weightKg: 0, freightCost: 0, insuranceCost: 0, originFees: 0, destinationFees: 0, currency: 'USD', trackingRef: '', documentId: null, notes: '' });
  const saveShipment = () => {
    if (!shipmentEdit) return;
    const s = { ...shipmentEdit, projectId: shipmentEdit.projectId ?? project.id };
    update((d) => ({ ...d, shipments: d.shipments.some((x) => x.id === s.id) ? d.shipments.map((x) => (x.id === s.id ? s : x)) : [...d.shipments, s] }));
    setShipmentEdit(null); toast('Expédition enregistrée');
  };
  const attachShipment = (id: string) => { update((d) => ({ ...d, shipments: d.shipments.map((s) => (s.id === id ? { ...s, projectId: project.id, orderIds: s.orderIds.length ? s.orderIds : orders.map((o) => o.id) } : s)) })); toast('Expédition rattachée à l\'importation'); };
  const detachShipment = (id: string) => { update((d) => ({ ...d, shipments: d.shipments.map((s) => (s.id === id ? { ...s, projectId: null, orderIds: s.orderIds.filter((oid) => !orders.some((o) => o.id === oid)) } : s)) })); toast('Expédition retirée de l\'importation'); };
  const newOrder = (factoryId: string) => setOrder({ id: newId(), projectId: project.id, factoryId, reference: '', date: today(), status: 'devis', lines: [], depositPct: 30, depositPaid: false, balancePaid: false, productionDays: 30, expectedReadyDate: '', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null, notes: '' });

  const docChip = (id: string | null, label: string) => {
    const d = id ? db.documents.find((x) => x.id === id) : null;
    return d ? <span key={label} className="badge" style={{ cursor: 'pointer', marginRight: 4 }} title={d.fileName} onClick={(e) => { e.stopPropagation(); openDoc(d.id); }}>📄 {label}</span> : null;
  };

  return (
    <div className="page">
      <div className="breadcrumb"><a onClick={() => go('projects')}>Importations</a> › {project.name}</div>
      <div className="page-head">
        <div>
          <h1>{project.name} <Badge tone={ps.tone}>{ps.label}</Badge> {project.container && <Badge>{project.container}</Badge>}</h1>
          <div className="sub">{project.description || 'Toutes les commandes qui partent ensemble.'}</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={onEdit}>Modifier</button>
          <button className="btn primary" onClick={() => newOrder(db.factories[0]?.id ?? '')} disabled={!db.factories.length}>+ Commande</button>
        </div>
      </div>

      <div className="grid c4 mb">
        <div className="stat"><div className="label">Marchandise</div><div className="value">{formatEur(total, 0)}</div><div className="hint">{orders.length} commande{orders.length > 1 ? 's' : ''} · {byFactory.length} usine{byFactory.length > 1 ? 's' : ''}</div></div>
        <div className="stat"><div className="label">Volume</div><div className="value">{cbm > 0 ? `${cbm.toFixed(1)} m³` : '—'}</div><div className="hint">{project.container === '40HQ' ? `${Math.round((cbm / 68) * 100)} % d'un 40HQ` : project.container === '20GP' ? `${Math.round((cbm / 28) * 100)} % d'un 20GP` : project.container === '40GP' ? `${Math.round((cbm / 58) * 100)} % d'un 40GP` : 'd\'après le colisage des références'}</div></div>
        <div className="stat"><div className="label">Logistique</div><div className="value">{ships.length ? formatEur(logistics, 0) : '—'}</div><div className="hint">{ships.length ? `${ships.length} expédition${ships.length > 1 ? 's' : ''}` : 'aucune expédition'}</div></div>
        {(() => { const t = projectTransit(db, project.id); const dd = daysUntil(t.etd || project.targetDate); const ed = daysUntil(t.eta); return (
          <div className="stat"><div className="label">{t.etd ? 'Expédition → Livraison' : 'Départ visé'}</div><div className="value">{t.etd ? <>{fmtDate(t.etd)} <span className="muted">→</span> {t.eta ? fmtDate(t.eta) : '?'}</> : project.targetDate ? fmtDate(project.targetDate) : '—'}</div><div className="hint">{t.etd ? (t.status === 'livree' ? 'livré' : ed != null ? (ed < 0 ? `livraison en retard de ${-ed} j` : `livraison dans ${ed} j`) : dd != null && dd > 0 ? `départ dans ${dd} j` : 'en cours') : project.targetDate && dd != null ? (dd >= 0 ? `dans ${dd} j` : `il y a ${-dd} j`) : lastReady ? `production finie le ${fmtDate(lastReady)}` : ''}</div></div>
        ); })()}
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'flux', label: `Arborescence des flux (${project.flows.length})` }, { value: 'negociation', label: `Négociation${project.negotiations.length ? ` (${project.negotiations.filter((n) => n.status === 'accord').length}/${project.negotiations.length})` : ''}` }, { value: 'commandes', label: `Commandes (${orders.length})` }, { value: 'expeditions', label: `Expéditions (${ships.length})` }, { value: 'documents', label: `Documents (${docs.length})` }, { value: 'finance', label: '€ Analyse financière' }]} />

      {tab === 'flux' && (
        <div className="card">
          <div className="card-head">
            <div><h2>Liste de courses</h2><div className="small muted">Ce que tu veux recevoir en France (produits finis, quantités). Bao en déduit tous les composants à commander chez chaque usine et dessine l'arborescence.</div></div>
            <div className="row-flex">
              <button className="btn primary small" onClick={() => setContentsEdit({ lines: project.contents.map((l) => ({ ...l, kind: 'manual' as const, reason: '' })), fromProposal: false })}>{project.contents.length ? '✎ Modifier la liste' : '+ Faire ma liste'}</button>
              <button className="btn small" disabled={orders.length === 0} title="Construit la liste à partir des commandes rattachées à cette importation (proformas, factures, packing lists lus dans Documents) et des compositions des marchandises" onClick={() => {
                const props = proposeContents(db, project);
                if (!props.length) { toast('Rien à déduire : aucune commande rattachée, ou aucune composition ne relie les marchandises commandées', true); return; }
                // Les propositions priment (un tissu déjà dans la liste mais reconnu comme composant repasse à 0) ; les lignes saisies sans équivalent sont conservées.
                const merged = props.map((x) => { const prev = project.contents.find((l) => l.productId === x.productId); return prev && x.kind !== 'component' ? { ...x, qty: prev.qty, reason: `${x.reason} · déjà dans ta liste (${prev.qty})` } : prev ? { ...x, reason: `${x.reason} · était dans ta liste (${prev.qty}) → retiré du conteneur` } : x; });
                const kept = project.contents.filter((l) => !props.some((x) => x.productId === l.productId)).map((l) => ({ ...l, kind: 'manual' as const, reason: 'déjà dans ta liste' }));
                setContentsEdit({ lines: [...merged, ...kept], fromProposal: true });
              }}>⇣ Déduire des documents ({orders.length} cde{orders.length > 1 ? 's' : ''})</button>
              <button className="btn small" disabled={project.contents.length === 0} onClick={regenerateFlows} title="Recalcule les flèches entre usines à partir de la liste et des compositions">⟳ Regénérer l'arborescence</button>
              {project.flows.length > 0 && <ConfirmButton label="🗑 Effacer l'arborescence" className="btn small" onConfirm={() => { update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, flows: [], layout: {} } : p)) })); toast('Arborescence effacée — la liste de courses est conservée'); }} />}
            </div>
          </div>
          {project.consolidatorFactoryId && <div className="small muted mb">Groupage chez <b>{db.factories.find((f) => f.id === project.consolidatorFactoryId)?.name}</b> : tout converge vers cette usine, qui charge le conteneur (modifiable via « Modifier »).</div>}
          {project.contents.length === 0 ? (
            <div className="dup-banner warn">Commence par ta liste de courses : clique <b>+ Faire ma liste</b> pour la saisir à la main, ou <b>⇣ Déduire des documents</b> pour la construire depuis les commandes rattachées à cette importation (proformas, factures, packing lists). Choisis les produits finis et les quantités. Bao calcule ensuite tous les composants nécessaires (cadres, EPP, tissu, housses…), l'usine qui fabrique chacun, et dessine l'arborescence des flux jusqu'au conteneur.</div>
          ) : (
            <div className="contents-chips">{project.contents.map((l) => { const p = db.products.find((x) => x.id === l.productId); return <span key={l.productId} className="badge" style={{ cursor: 'pointer' }} onClick={() => p && go('merchandise', p.id)}><b>{l.qty}</b> × {p?.name ?? '?'}{p?.components.length ? <span className="muted"> · {p.components.length} sous-réf.</span> : null}</span>; })}</div>
          )}
          {project.contents.length > 0 && project.needsHidden && <div className="small mt"><button className="btn small" onClick={() => update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, needsHidden: false } : p)) }))}>▸ Afficher la marchandise de l'importation</button></div>}
          {project.contents.length > 0 && !project.needsHidden && <NeedsTable project={project} onCreateOrder={(factoryId, lines) => setOrder({ id: newId(), projectId: project.id, factoryId, reference: '', date: today(), status: 'devis', lines, depositPct: 30, depositPaid: false, balancePaid: false, productionDays: 30, expectedReadyDate: '', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null, notes: `Brouillon généré depuis la liste de courses de « ${project.name} ».` })} />}
          <div className="card-head mt" style={{ marginBottom: 6 }}>
            <div><h2>Arborescence de commande</h2><div className="small muted">Construite uniquement depuis ta liste de courses, la composition des marchandises et l'usine qui fabrique chaque pièce : chaque composant rejoint l'usine qui assemble, le produit fini part vers la France.</div></div>
            <button className="btn small" onClick={() => setFlow(blankFlow())}>+ Flux manuel</button>
          </div>
          <FlowGraph project={project} needs={explodeNeeds(db, project.contents)} onEditFlow={setFlow} onAddFlow={(from) => setFlow(blankFlow(from))} onLinkDocs={setLinkDocs} onLayout={(layout) => update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, layout } : p)) }))} />
        </div>
      )}

      {tab === 'negociation' && <NegotiationTab project={project} onCreateOrder={(factoryId, lines) => setOrder({ id: newId(), projectId: project.id, factoryId, reference: '', date: today(), status: 'devis', lines, depositPct: 30, depositPaid: false, balancePaid: false, productionDays: 30, expectedReadyDate: '', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null, notes: `Commande aux prix négociés — importation « ${project.name} ».` })} />}

      {tab === 'commandes' && (
        <>
          {byFactory.length === 0 && <div className="card"><Empty icon="⚙" title="Aucune commande dans cette importation" text="Ajoute une commande existante ci-dessous, crée-en une, ou lis une proforma / facture : Bao proposera cette importation." /></div>}
          <div className="import-factories">
          {byFactory.map(({ factory, orders: fo }) => (
            <div className="card import-factory" key={factory?.id ?? 'none'}>
              <div className="fc-head">
                <div>
                  <h2 style={{ cursor: factory ? 'pointer' : undefined, margin: 0 }} onClick={() => factory && go('factories', factory.id)}>{factory?.name ?? 'Usine inconnue'}</h2>
                  {factory && <div style={{ marginTop: 2 }}><Stars value={factory.rating} size={13} /></div>}
                </div>
                <div className="row-flex"><b>{formatEur(fo.reduce((t, o) => t + orderTotalEur(o, db.settings), 0))}</b>{factory && <button className="btn small" title={`Nouvelle commande chez ${factory.name}`} onClick={() => newOrder(factory.id)}>+ Commande</button>}</div>
              </div>
              {fo.map((o) => {
                const os = statusOf(ORDER_STATUS, o.status);
                return (
                  <div key={o.id} className="import-order" onClick={() => setOrder(o)}>
                    <div className="row-flex">
                      <b>{o.reference || 'Sans référence'}</b><span className="muted small">{fmtDate(o.date)}</span>
                      <Badge tone={os.tone}>{os.label}</Badge>
                      <span style={{ flex: 1 }} />
                      {docChip(o.proformaDocumentId, 'PI')}{docChip(o.invoiceDocumentId, 'Facture')}{docChip(o.packingListDocumentId, 'PL')}
                      <span className="small">{formatEur(orderTotalEur(o, db.settings))}</span>
                      <button className="btn ghost small" title="Retirer de l'importation" onClick={(e) => { e.stopPropagation(); detach(o); }}>✕</button>
                    </div>
                    <Timeline steps={ORDER_STATUS} current={o.status} />
                  </div>
                );
              })}
              <PurchasedTree orders={fo} factoryId={factory?.id ?? null} />
            </div>
          ))}
          </div>
          {candidates.length > 0 && (
            <div className="row-flex mt small">
              <span className="muted">Ajouter une commande existante :</span>
              <select value="" onChange={(e) => { if (e.target.value) attach(e.target.value); }}>
                <option value="">— Choisir —</option>
                {candidates.map((o) => { const pr = db.projects.find((p) => p.id === o.projectId); return <option key={o.id} value={o.id}>{o.reference || 'sans réf.'} · {db.factories.find((f) => f.id === o.factoryId)?.name ?? '?'} · {fmtDate(o.date)}{pr ? ` (actuellement : ${pr.name})` : ''}</option>; })}
              </select>
            </div>
          )}
        </>
      )}

      {tab === 'expeditions' && (
        <>
          <div className="row-flex mb" style={{ justifyContent: 'flex-end', gap: 8 }}>
            {otherShips.length > 0 && (
              <Select value="" onChange={(id) => { if (id) attachShipment(id); }} options={[{ value: '', label: 'Rattacher une expédition existante…' }, ...otherShips.map((s) => ({ value: s.id, label: `${s.reference || 'Expédition'} · ${statusOf(SHIPMENT_STATUS, s.status).label}${s.etd ? ` · ETD ${fmtDate(s.etd)}` : ''}` }))]} />
            )}
            <button className="btn primary" onClick={newShipment}>+ Expédition</button>
          </div>
          {ships.length === 0 ? <div className="card"><Empty icon="⛴" title="Aucune expédition" text="Crée l'expédition de ce conteneur ici (bouton + Expédition) ou rattache une expédition déjà saisie dans Logistique : toutes ses informations (transporteur, dates, coûts, emails) s'afficheront ici." /></div> : ships.map((s) => {
            const ss = statusOf(SHIPMENT_STATUS, s.status);
            const partner = db.partners.find((p) => p.id === s.partnerId);
            const agent = db.partners.find((p) => p.id === s.agentId);
            const eta = daysUntil(s.eta);
            const etd = daysUntil(s.etd);
            const sOrders = db.orders.filter((o) => s.orderIds.includes(o.id));
            const mails = db.mails.filter((m) => m.shipmentId === s.id).sort((a, b) => b.date.localeCompare(a.date));
            const doc = s.documentId ? db.documents.find((d) => d.id === s.documentId) : null;
            const contacts = db.contacts.filter((c) => c.ownerType === 'partner' && (c.ownerId === s.partnerId || c.ownerId === s.agentId));
            const money = (n: number) => formatMoney(n, s.currency);
            const costs = [['Fret', s.freightCost], ['Assurance', s.insuranceCost], ['Frais départ', s.originFees], ['Frais arrivée', s.destinationFees]] as const;
            return (
              <div key={s.id} className="card">
                <div className="card-head">
                  <h2>{s.reference || 'Expédition'} <span className="muted small">· {MODE_LABELS[s.mode]} · {s.incoterm}{s.trackingRef ? ` · ${s.trackingRef}` : ''}</span></h2>
                  <div className="row-flex">
                    <Badge tone={ss.tone}>{ss.label}</Badge><b>{formatEur(shipmentTotalEur(s, db.settings))}</b>
                    <button className="btn small" onClick={() => setShipmentEdit(s)}>Modifier</button>
                    <button className="btn ghost small" title="Retirer de cette importation (l'expédition reste dans Logistique)" onClick={() => detachShipment(s.id)}>✕</button>
                  </div>
                </div>
                <Timeline steps={SHIPMENT_STATUS} current={s.status} />
                <div className="grid c4 mt small">
                  <div><span className="muted">Départ (ETD)</span><br /><b>{fmtDate(s.etd) || '—'}</b>{etd != null && s.status === 'planifiee' ? <span className="muted"> ({etd < 0 ? `il y a ${-etd} j` : `dans ${etd} j`})</span> : null}</div>
                  <div><span className="muted">Arrivée prévue (ETA)</span><br /><b>{fmtDate(s.eta) || '—'}</b>{eta != null && s.status !== 'livree' ? <span className="muted"> ({eta < 0 ? `retard ${-eta} j` : `dans ${eta} j`})</span> : null}</div>
                  <div><span className="muted">Transporteur</span><br />{partner ? <b>{partner.name}</b> : '—'}{partner?.city ? <span className="muted"> · {partner.city}</span> : null}{agent ? <><br /><span className="muted">Agent : </span>{agent.name}</> : null}{contacts.map((c) => <div key={c.id} className="muted">👤 {c.name}{c.email ? ` · ${c.email}` : ''}{c.phone ? ` · ${c.phone}` : ''}</div>)}</div>
                  <div><span className="muted">Volume / poids</span><br /><b>{s.cbm ? `${s.cbm} m³` : '—'}</b>{s.weightKg ? ` · ${s.weightKg} kg` : ''}{project.container ? <><br /><span className="muted">Conteneur : </span>{project.container}</> : null}</div>
                </div>
                <div className="grid c2 mt small">
                  <div>
                    <div className="muted">Coûts de transport ({s.currency})</div>
                    <table className="tbl compact"><tbody>
                      {costs.map(([l, v]) => <tr key={l}><td>{l}</td><td className="right">{v ? money(v) : <span className="muted">—</span>}</td></tr>)}
                      <tr><td className="strong">Total</td><td className="right strong">{money(s.freightCost + s.insuranceCost + s.originFees + s.destinationFees)}{s.currency !== 'EUR' ? <span className="muted"> ≈ {formatEur(shipmentTotalEur(s, db.settings))}</span> : null}</td></tr>
                    </tbody></table>
                  </div>
                  <div>
                    <div className="muted">Commandes embarquées ({sOrders.length})</div>
                    {sOrders.length === 0 ? <div className="muted">Aucune commande rattachée.</div> : sOrders.map((o) => <div key={o.id} className="click" style={{ cursor: 'pointer' }} onClick={() => setOrder(o)}>📦 {o.reference || 'Commande'} <span className="muted">· {db.factories.find((f) => f.id === o.factoryId)?.name ?? '?'} · {formatEur(orderTotalEur(o, db.settings))}{orderCbm(o, db) ? ` · ${orderCbm(o, db).toFixed(2)} m³` : ''}</span></div>)}
                    {doc && <div className="mt">📄 <a style={{ cursor: 'pointer' }} onClick={() => openDoc(doc.id)}>{doc.fileName}</a></div>}
                    {s.notes && <div className="mt muted" style={{ whiteSpace: 'pre-wrap' }}>{s.notes}</div>}
                  </div>
                </div>
                {mails.length > 0 && (
                  <div className="mt small">
                    <div className="muted">Emails liés ({mails.length})</div>
                    {mails.slice(0, 6).map((m) => <div key={m.id} className="click" style={{ cursor: 'pointer' }} onClick={() => go('logistics', undefined, 'emails')}>✉️ <span className="muted">{fmtDate(m.date.slice(0, 10))} · {m.fromName || m.from}</span> — {m.subject}{m.attachments.length ? <span className="muted"> 📎 {m.attachments.length}</span> : null}</div>)}
                    {mails.length > 6 && <a className="muted" style={{ cursor: 'pointer' }} onClick={() => go('logistics', undefined, 'emails')}>… et {mails.length - 6} autres dans Logistique › Emails</a>}
                  </div>
                )}
              </div>
            );
          })}
          {shipmentEdit && <ShipmentModal shipment={shipmentEdit} onChange={setShipmentEdit} onClose={() => setShipmentEdit(null)} onSave={saveShipment} />}
        </>
      )}

      {docReview && <ReviewModal doc={docReview.doc} result={docReview.result} remaining={docQueue.length} batch={{ projectId: project.id, newProjectName: '' }} onClose={() => { setDocReview(null); setDocQueue([]); }} onSaved={() => { setDocReview(null); toast('Fiches mises à jour'); if (docQueue.length) nextDoc(); }} />}
      {tab === 'finance' && <FinanceTab project={project} />}

      {tab === 'documents' && (
        <div className="card">
          <div className="card-head"><h2>Documents de l'importation</h2><button className="btn small" onClick={async () => { const added = await api.importFiles(); if (added.length) { update((d) => ({ ...d, documents: [...added, ...d.documents], projects: d.projects.map((p) => (p.id === project.id ? { ...p, docLinks: [...p.docLinks, ...added.map((x) => ({ documentId: x.id, factoryId: FR }))] } : p)) })); toast(`${added.length} document${added.length > 1 ? 's' : ''} importé${added.length > 1 ? 's' : ''} — lecture en cours…`); analyseDocs(added.map((x) => x.id), added); } }}>+ Importer des PDF</button></div>
          <div className="small muted mb">Les documents importés ici sont lus par Bao avec cette importation pré-sélectionnée : les commandes créées s'y rattachent, et « ⇣ Déduire des documents » peut ensuite construire la liste de courses.{docs.some((d) => !d.extracted) ? <> <button className="btn small" disabled={!!docBusy} onClick={() => analyseDocs(docs.filter((d) => !d.extracted).map((d) => d.id), db.documents)}>✦ Analyser les {docs.filter((d) => !d.extracted).length} non lus</button></> : null}</div>
          {docs.length === 0 ? <Empty icon="⇩" title="Aucun document" text="Les proformas, factures et packing lists des commandes de cette importation apparaîtront ici, ainsi que les PDF liés aux cartes de l'arborescence (bouton 📎)." /> : (
            <table className="tbl">
              <thead><tr><th>Document</th><th>Type</th><th>Rattaché à</th><th>Résumé</th><th></th></tr></thead>
              <tbody>{docs.map((d) => {
                const o = orders.find((x) => x.proformaDocumentId === d.id || x.invoiceDocumentId === d.id || x.packingListDocumentId === d.id);
                const links = project.docLinks.filter((l) => l.documentId === d.id);
                const where = [o ? `Cde ${o.reference || 'sans réf.'}` : '', ...links.map((l) => (l.factoryId === FR ? '🇫🇷 France' : db.factories.find((f) => f.id === l.factoryId)?.name?.split(' ').slice(0, 2).join(' ') ?? '?'))].filter(Boolean).join(' · ');
                return (
                  <tr key={d.id} className="click" onClick={() => openDoc(d.id)}>
                    <td className="strong">{d.fileName}</td>
                    <td><Badge>{KIND_LABELS[d.kind] ?? d.kind}</Badge></td>
                    <td className="small">{where || <span className="muted">importation</span>}</td>
                    <td className="small muted">{d.summary}</td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      <button className="btn small" disabled={docBusy === d.id} onClick={() => analyseDocs([d.id], db.documents)}>{docBusy === d.id ? <><span className="spinner" /> Lecture…</> : d.extracted ? 'Relire' : '✦ Analyser'}</button>{' '}
                      {links.length > 0 && <button className="btn ghost small" title="Détacher de cette importation (le document reste dans Documents)" onClick={() => update((x) => ({ ...x, projects: x.projects.map((p) => (p.id === project.id ? { ...p, docLinks: p.docLinks.filter((l) => l.documentId !== d.id) } : p)) }))}>✕ Détacher</button>}
                      <ConfirmButton label="🗑" className="btn ghost small" onConfirm={() => { update((x) => removeDocument(x, d.id)); toast('Document supprimé'); }} />
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
      )}

      {project.notes && <div className="card mt"><h3>Notes</h3><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{project.notes}</div></div>}

      {order && <OrderModal order={order} onChange={setOrder} onClose={() => setOrder(null)} onSave={saveOrder} />}
      {linkDocs && <DocLinkModal project={project} factoryId={linkDocs} onClose={() => setLinkDocs(null)} />}
      {contentsEdit && <ContentsModal project={project} lines={contentsEdit.lines} fromProposal={contentsEdit.fromProposal} onChange={(lines) => setContentsEdit({ ...contentsEdit, lines })} onClose={() => setContentsEdit(null)} onSave={(gen) => saveContents(contentsEdit.lines, gen)} />}
      {flow && <FlowModal project={project} flow={flow} onChange={setFlow} onClose={() => setFlow(null)} onSave={() => saveFlow(flow)} onDelete={() => deleteFlow(flow.id)} />}
      {edit && <ProjectModal project={edit} onChange={setEdit} onClose={() => setEdit(null)} onSave={onSave} />}
    </div>
  );
}

/**
 * Arborescence des produits achetés chez une usine dans cette importation :
 * chaque produit commandé, puis ses sous-références (composition) avec l'usine qui les fabrique.
 */
function PurchasedTree({ orders, factoryId }: { orders: Order[]; factoryId: string | null }) {
  const { db } = useStore();
  const { go } = useNav();
  const [open, setOpen] = useState(true);
  // Agrégation des lignes : produit → quantité totale et dernier prix.
  const bought = new Map<string, { qty: number; unitPrice: number; currency: Order['lines'][number]['currency'] }>();
  for (const o of orders) for (const l of o.lines) {
    if (!l.productId || l.isService) continue;
    const cur = bought.get(l.productId);
    bought.set(l.productId, { qty: (cur?.qty ?? 0) + l.qty, unitPrice: l.unitPrice || cur?.unitPrice || 0, currency: l.currency });
  }
  if (bought.size === 0) return null;
  const factoryName = (id: string | null) => (id ? db.factories.find((f) => f.id === id)?.name?.replace(/\s*(Co\.,?\s*Ltd\.?|Technology|Furniture)\s*/gi, ' ').trim() : '');

  const Node = ({ product, qty, price, depth, seen }: { product: Product; qty: number; price?: { unitPrice: number; currency: Order['lines'][number]['currency'] }; depth: number; seen: Set<string> }) => {
    const comps = effectiveComponents(product, {}).filter((c) => !seen.has(c.productId));
    const sameFactory = product.factoryId === factoryId;
    const cost = unitCost(product.id, db);
    return (
      <>
        <div className="ptree-row" style={{ paddingLeft: 10 + depth * 22 }} onClick={() => go('merchandise', product.id)}>
          <span className="ptree-branch">{depth > 0 ? '└' : '•'}</span>
          <span className="ptree-name">{product.name}{product.version !== 'V1' ? <span className="muted"> {product.version}</span> : null}{product.sku ? <span className="muted small"> · {product.sku}</span> : null}</span>
          <span className="ptree-qty">{Number.isInteger(qty) ? qty : qty.toFixed(1)}</span>
          <span className="ptree-fac">{product.factoryId ? <Badge tone={sameFactory ? 'blue' : ''}>{sameFactory ? 'cette usine' : factoryName(product.factoryId)}</Badge> : <Badge>assemblé</Badge>}</span>
          <span className="ptree-price">{price && price.unitPrice ? formatMoney(price.unitPrice, price.currency) : cost ? <span className="muted">{formatEur(cost.costEur)}</span> : '—'}</span>
        </div>
        {comps.map((c) => {
          const sub = db.products.find((x) => x.id === c.productId);
          if (!sub || depth > 5) return null;
          return <Node key={c.productId} product={sub} qty={qty * c.qty} depth={depth + 1} seen={new Set([...seen, product.id])} />;
        })}
      </>
    );
  };

  return (
    <div className="mt" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <div className="row-flex small" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}><b>{open ? '▾' : '▸'} Produits achetés ({bought.size})</b></div>
      {open && (
        <div className="ptree">
          <div className="ptree-row head"><span className="ptree-branch" /><span className="ptree-name">Référence</span><span className="ptree-qty">Qté</span><span className="ptree-fac">Usine</span><span className="ptree-price">Prix / coût</span></div>
          {[...bought.entries()].map(([pid, b]) => {
            const p = db.products.find((x) => x.id === pid);
            return p ? <Node key={pid} product={p} qty={b.qty} price={b} depth={0} seen={new Set()} /> : null;
          })}
        </div>
      )}
    </div>
  );
}

function FlowModal({ project, flow, onChange, onClose, onSave, onDelete }: { project: Project; flow: ProjectFlow; onChange: (f: ProjectFlow) => void; onClose: () => void; onSave: () => void; onDelete: () => void }) {
  const { db } = useStore();
  const exists = project.flows.some((x) => x.id === flow.id);
  const factoryOptions = db.factories.map((f) => ({ value: f.id, label: f.name }));
  const products = [...db.products].sort((a, b) => a.name.localeCompare(b.name));
  const setLine = (i: number, patch: Partial<ProjectFlow['lines'][number]>) => onChange({ ...flow, lines: flow.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  /** Ce que l'usine « from » a sous la main dans cette importation : ce qu'elle fabrique (commandes) + ce qu'elle a reçu (flux entrants). */
  const available = (() => {
    const m = new Map<string, number>();
    for (const o of db.orders.filter((o) => o.projectId === project.id && o.factoryId === flow.fromFactoryId)) for (const l of o.lines) m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty);
    for (const f of project.flows.filter((f) => f.to === flow.fromFactoryId && f.id !== flow.id)) for (const l of f.lines) m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty);
    return [...m.entries()].map(([productId, qty]) => ({ productId, qty }));
  })();
  const fromName = db.factories.find((f) => f.id === flow.fromFactoryId)?.name ?? 'cette usine';
  return (
    <Modal title={exists ? 'Modifier le flux' : 'Nouveau flux entre usines'} onClose={onClose} wide
      footer={<>{exists && <ConfirmButton label="Supprimer" onConfirm={onDelete} />}<span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Annuler</button><button className="btn primary" disabled={!flow.fromFactoryId || !flow.to || flow.fromFactoryId === flow.to} onClick={onSave}>Enregistrer</button></>}>
      <div className="form c4">
        <Field label="Depuis l'usine" span={2}><Select value={flow.fromFactoryId} onChange={(v) => onChange({ ...flow, fromFactoryId: v })} options={[{ value: '', label: '— Choisir —' }, ...factoryOptions]} /></Field>
        <Field label="Vers" span={2}><Select value={flow.to} onChange={(v) => onChange({ ...flow, to: v })} options={[{ value: FR, label: '🇫🇷 France (conteneur)' }, ...factoryOptions.filter((o) => o.value !== flow.fromFactoryId)]} /></Field>
        <Field label="Statut"><Select value={flow.status} onChange={(v) => onChange({ ...flow, status: v })} options={FLOW_STATUS.map((s) => ({ value: s.value, label: s.label }))} /></Field>
        <Field label="Date d'envoi"><Input type="date" value={flow.date} onChange={(v) => onChange({ ...flow, date: v })} /></Field>
        <Field label="Note (transport, coût, contact…)" span={2}><Input value={flow.note} onChange={(v) => onChange({ ...flow, note: v })} placeholder="ex. camion 67 USD, à la charge de l'usine" /></Field>
      </div>
      <div className="card-head mt"><h3 style={{ margin: 0 }}>Marchandise envoyée</h3>
        {available.length > 0 && <button className="btn small" onClick={() => onChange({ ...flow, lines: available.filter((a) => !flow.lines.some((l) => l.productId === a.productId)).concat(flow.lines) })}>Tout ce que {fromName.split(' ')[0]} a dans cette importation ({available.length})</button>}
      </div>
      {flow.lines.length === 0 ? <div className="muted small">Aucune ligne : ajoute les produits envoyés, ou laisse vide et décris dans la note.</div> : (
        <table className="tbl">
          <thead><tr><th>Produit</th><th className="num">Quantité</th><th></th></tr></thead>
          <tbody>{flow.lines.map((l, i) => (
            <tr key={i}>
              <td><select value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })} style={{ width: '100%' }}><option value="">— Produit —</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.version !== 'V1' ? ` (${p.version})` : ''}</option>)}</select></td>
              <td className="num"><input type="number" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} style={{ width: 100, textAlign: 'right' }} /></td>
              <td><button className="btn ghost small" onClick={() => onChange({ ...flow, lines: flow.lines.filter((_, j) => j !== i) })}>✕</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <button className="btn small mt" onClick={() => onChange({ ...flow, lines: [...flow.lines, { productId: available[0]?.productId ?? products[0]?.id ?? '', qty: available[0]?.qty ?? 1 }] })}>+ Ligne</button>
    </Modal>
  );
}

type ContentLine = { productId: string; qty: number; kind: 'assembled' | 'ordered' | 'component' | 'manual'; reason: string };

function ContentsModal({ project, lines, fromProposal, onChange, onClose, onSave }: { project: Project; lines: ContentLine[]; fromProposal: boolean; onChange: (l: ContentLine[]) => void; onClose: () => void; onSave: (generate: boolean) => void }) {
  const { db, update, toast } = useStore();
  // Produits finaux d'abord (case « produit final » de la fiche), puis le reste.
  const products = [...db.products].filter((p) => p.isCurrentVersion || lines.some((l) => l.productId === p.id)).sort((a, b) => Number(!!b.isFinished) - Number(!!a.isFinished) || a.name.localeCompare(b.name));
  /** Déclaration rapide d'une composition depuis la liste : « ce produit est fait avec… ». */
  const [compose, setCompose] = useState<{ productId: string; componentId: string; qty: number } | null>(null);
  const ordered = orderedQuantities(db, project.id);
  const hasComposition = (pid: string) => (db.products.find((x) => x.id === pid)?.components.length ?? 0) > 0;
  const startCompose = (productId: string) => {
    const others = [...ordered.keys()].filter((id) => id !== productId && !lines.some((l) => l.productId === id && l.kind === 'assembled'));
    const componentId = others.find((id) => !hasComposition(id)) ?? others[0] ?? '';
    const qty = componentId && ordered.get(productId) ? Math.round(((ordered.get(componentId) ?? 0) / ordered.get(productId)!) * 100) / 100 : 1;
    setCompose({ productId, componentId, qty: qty || 1 });
  };
  const saveCompose = () => {
    if (!compose || !compose.componentId || !(compose.qty > 0)) return;
    let next: Database | null = null;
    update((d) => {
      next = { ...d, products: d.products.map((x) => (x.id === compose.productId ? { ...x, components: [...x.components.filter((c) => c.productId !== compose.componentId), { productId: compose.componentId, qty: compose.qty, role: 'base' as const, optionGroup: '', isDefault: false }] } : x)) };
      return next;
    });
    if (next) {
      const props = proposeContents(next, project);
      const manual = lines.filter((l) => l.kind === 'manual' && l.productId && !props.some((x) => x.productId === l.productId));
      onChange([...manual, ...props]);
    }
    setCompose(null);
    toast(`Composition enregistrée sur la fiche « ${db.products.find((x) => x.id === compose.productId)?.name ?? ''} »`);
  };
  /** Diagnostic : composants déclarés sur la fiche mais absents des factures de l'importation — souvent une autre fiche (doublon) pour la même marchandise. */
  const words = (s: string) => new Set(s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['les', 'des', 'pour', 'avec', 'the', 'and'].includes(w)));
  const similar = (a: string, b: string) => { const wa = words(a), wb = words(b); const common = [...wa].filter((w) => wb.has(w)).length; return common >= 1 && common / Math.min(wa.size || 1, wb.size || 1) >= 0.5; };
  const diagnose = (pid: string) => {
    const p = db.products.find((x) => x.id === pid);
    if (!p || !p.components.length) return [];
    const orderedIds = [...ordered.keys()];
    return effectiveComponents(p, {}).map((c) => {
      const comp = db.products.find((x) => x.id === c.productId);
      const invoiced = orderedIds.includes(canonicalProductId(db, c.productId));
      const lookalike = !invoiced && comp ? orderedIds.filter((id) => id !== pid).map((id) => db.products.find((x) => x.id === id)!).filter((x) => x && similar(x.name, comp.name))[0] : undefined;
      return { component: comp, qty: c.qty, invoiced, lookalike };
    });
  };
  const relink = (pid: string, fromId: string, toId: string) => {
    let next: Database | null = null;
    update((d) => { next = { ...d, products: d.products.map((x) => (x.id === pid ? { ...x, components: x.components.map((c) => (c.productId === fromId ? { ...c, productId: toId } : c)) } : x)) }; return next; });
    if (next) { const props = proposeContents(next, project); const manual = lines.filter((l) => l.kind === 'manual' && l.productId && !props.some((x) => x.productId === l.productId)); onChange([...manual, ...props]); }
    toast('Composition reliée à la fiche facturée');
  };
  const setLine = (i: number, patch: Partial<ContentLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const factoryOf = (pid: string) => { const p = db.products.find((x) => x.id === pid); return p?.factoryId ? db.factories.find((f) => f.id === p.factoryId)?.name?.split(' ')[0] ?? '' : 'assemblé en France'; };
  return (
    <Modal title={fromProposal ? 'Liste de courses — déduite des commandes, à vérifier' : 'Liste de courses'} onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Annuler</button><span style={{ flex: 1 }} /><button className="btn" onClick={() => onSave(false)}>Enregistrer</button><button className="btn primary" onClick={() => onSave(true)}>Enregistrer et générer l'arborescence</button></>}>
      {fromProposal ? <div className="small muted mb">D'après ce qui a été commandé chez chaque usine et les compositions des marchandises. Une marchandise facturée mais qui entre dans la composition d'un autre produit de la liste (le tissu des paravents, l'EPP des Wall…) est marquée <b>composant · non chargé</b> avec une quantité 0 : elle reste chez l'usine qui assemble. Mets une quantité si tu veux quand même en charger une partie. Corrige les quantités, retire ou ajoute des lignes.</div> : <div className="small muted mb">Les produits finis que tu veux recevoir en France, avec les quantités. Bao éclate ensuite chaque produit en composants (d'après sa composition) pour te dire quoi commander chez qui.</div>}
      {lines.length === 0 && <div className="muted small mb">{fromProposal ? 'Aucune proposition : aucune marchandise commandée dans cette importation, ou aucune composition ne les relie.' : 'Liste vide.'} Ajoute des lignes ci-dessous.</div>}
      <table className="tbl">
        <thead><tr><th>Marchandise chargée</th><th className="num">Quantité</th><th>Fabriquée / assemblée chez</th><th>Pourquoi</th><th></th></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i} style={l.kind === 'component' ? { opacity: 0.6 } : undefined}>
            <td><select value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value, kind: 'manual', reason: '' })} style={{ width: '100%' }}><option value="">— Choisir —</option>{products.some((p) => p.isFinished) ? <><optgroup label="Produits finaux">{products.filter((p) => p.isFinished).map((p) => <option key={p.id} value={p.id}>{p.name}{p.components.length ? ` (${p.components.length} sous-réf.)` : ''}</option>)}</optgroup><optgroup label="Composants et matières">{products.filter((p) => !p.isFinished).map((p) => <option key={p.id} value={p.id}>{p.name}{p.components.length ? ` (${p.components.length} sous-réf.)` : ''}</option>)}</optgroup></> : products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.components.length ? ` (${p.components.length} sous-réf.)` : ''}</option>)}</select></td>
            <td className="num"><input type="number" step="any" value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} style={{ width: 100, textAlign: 'right' }} /></td>
            <td className="small">{l.productId ? factoryOf(l.productId) : '—'}</td>
            <td className="small">{l.kind === 'assembled' ? <Badge tone="green">produit fini</Badge> : l.kind === 'ordered' ? <Badge>tel quel</Badge> : l.kind === 'component' ? <Badge tone="amber">composant · non chargé</Badge> : <Badge tone="blue">saisi</Badge>} <span className="muted">{l.reason}</span>
              {fromProposal && (l.kind === 'ordered' || l.kind === 'manual') && l.productId && ordered.has(l.productId) && !hasComposition(l.productId) && ordered.size > 1 && (compose?.productId !== l.productId) && <button className="btn ghost small" style={{ marginLeft: 6 }} title="Déclarer de quoi ce produit est fait : ses composants facturés à part ne monteront plus dans le conteneur" onClick={() => startCompose(l.productId)}>⚙ Composé de…</button>}
              {fromProposal && (l.kind === 'ordered' || l.kind === 'manual') && l.productId && ordered.has(l.productId) && hasComposition(l.productId) && (() => { const diag = diagnose(l.productId); const missing = diag.filter((x) => !x.invoiced); return (
                <div className="muted" style={{ marginTop: 4 }}>
                  composé de : {diag.map((x, k) => <span key={k}>{k ? ', ' : ''}{x.component?.name ?? '?'} × {x.qty}{x.invoiced ? ' ✓' : ''}</span>)}
                  {missing.map((x, k) => <div key={k} style={{ color: 'var(--warn)' }}>⚠ « {x.component?.name ?? '?'} » n'est pas facturé dans cette importation{x.lookalike ? <> — mais « <b>{x.lookalike.name}</b> » l'est : c'est sûrement la même marchandise sur une autre fiche. <button className="btn small" onClick={() => relink(l.productId, x.component!.id, x.lookalike!.id)}>Relier la composition à « {x.lookalike.name}»</button></> : <> — vérifie que sa facture est bien rattachée à cette importation, ou que la composition pointe vers la bonne fiche.</>}</div>)}
                </div>
              ); })()}
              {compose?.productId === l.productId && (
                <div className="row-flex mt" style={{ gap: 6, flexWrap: 'wrap', background: 'var(--accent-soft)', padding: 6, borderRadius: 8 }}>
                  <span>fait avec</span>
                  <select value={compose.componentId} onChange={(e) => setCompose({ ...compose, componentId: e.target.value, qty: ordered.get(e.target.value) && ordered.get(l.productId) ? Math.round(((ordered.get(e.target.value) ?? 0) / ordered.get(l.productId)!) * 100) / 100 : compose.qty })}>{products.filter((p) => p.id !== l.productId).map((p) => <option key={p.id} value={p.id}>{p.name}{ordered.has(p.id) ? ` (${ordered.get(p.id)} commandés)` : ''}</option>)}</select>
                  <span>×</span><input type="number" step="any" value={compose.qty} onChange={(e) => setCompose({ ...compose, qty: Number(e.target.value) })} style={{ width: 80 }} /><span>par unité</span>
                  <button className="btn primary small" onClick={saveCompose}>Enregistrer la composition</button>
                  <button className="btn ghost small" onClick={() => setCompose(null)}>Annuler</button>
                  <div className="muted" style={{ width: '100%' }}>Quantité suggérée = quantité facturée du composant ÷ quantité facturée du produit. La composition est enregistrée sur la fiche Marchandise (modifiable là-bas).</div>
                </div>
              )}</td>
            <td><button className="btn ghost small" onClick={() => onChange(lines.filter((_, j) => j !== i))}>✕</button></td>
          </tr>
        ))}</tbody>
      </table>
      <button className="btn small mt" onClick={() => onChange([...lines, { productId: '', qty: 1, kind: 'manual', reason: '' }])}>+ Ligne</button>
    </Modal>
  );
}

/** Besoins par usine : éclatement de la liste de courses en composants, avec le prix facturé par chaque usine (sans double compte). */
function NeedsTable({ project, onCreateOrder }: { project: Project; onCreateOrder: (factoryId: string, lines: Order['lines']) => void }) {
  const { db, update, toast } = useStore();
  const { go } = useNav();
  const [open, setOpen] = useState(true);
  const launched = new Set(project.launchedFactoryIds ?? []);
  const setLaunched = (factoryId: string, on: boolean) => update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, launchedFactoryIds: on ? [...new Set([...(p.launchedFactoryIds ?? []), factoryId])] : (p.launchedFactoryIds ?? []).filter((x) => x !== factoryId) } : p)) }));
  const hasOrder = (factoryId: string) => db.orders.some((o) => o.projectId === project.id && o.factoryId === factoryId && o.status !== 'devis');
  const needs = explodeNeeds(db, project.contents);
  /** Ce qui a réellement été commandé / payé dans cette importation, par (usine, produit) : quantité et prix moyen en USD. */
  const bought = new Map<string, { qty: number; usd: number; refs: string[] }>();
  for (const o of db.orders.filter((o) => o.projectId === project.id)) for (const l of o.lines) {
    if (!l.productId || l.isService || !(l.qty > 0)) continue;
    const key = `${o.factoryId}|${canonicalProductId(db, l.productId)}`;
    const cur = bought.get(key) ?? { qty: 0, usd: 0, refs: [] };
    const unitUsd = l.currency === 'USD' ? l.unitPrice : fromEur(toEur(l.unitPrice, l.currency, db.settings), 'USD', db.settings);
    cur.usd = (cur.usd * cur.qty + unitUsd * l.qty) / (cur.qty + l.qty); cur.qty += l.qty; if (o.reference && !cur.refs.includes(o.reference)) cur.refs.push(o.reference);
    bought.set(key, cur);
  }
  const byFactory = new Map<string | null, typeof needs>();
  for (const n of needs) byFactory.set(n.factoryId, [...(byFactory.get(n.factoryId) ?? []), n]);
  const groups = [...byFactory.entries()].sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : 0));
  let grandTotal = 0;
  return (
    <div className="mt">
      <div className="row-flex small"><span style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}><b>{open ? '▾' : '▸'} Marchandise de l'importation</b> <span className="muted">— par usine, d'après la liste de courses et les compositions · une pièce fabriquée par l'usine qui assemble est comprise dans le prix du produit (pas comptée deux fois)</span></span><span style={{ flex: 1 }} /><button className="btn ghost small" title="Masquer ce tableau (réaffichable via le bouton « Afficher la marchandise »)" onClick={() => { update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, needsHidden: true } : p)) })); toast('Tableau masqué'); }}>✕ Effacer</button></div>
      {open && groups.map(([factoryId, rows]) => {
        const factory = factoryId ? db.factories.find((f) => f.id === factoryId) : null;
        // Ordre arborescent : chaque sous-marchandise fabriquée ici juste sous sa marchandise parente.
        const inGroup = new Set(rows.map((r) => r.productId));
        const ordered: typeof rows = [];
        const visit = (r: (typeof rows)[number]) => { if (ordered.includes(r)) return; ordered.push(r); for (const c of rows.filter((x) => x.parentId === r.productId)) visit(c); };
        for (const r of rows.filter((r) => !r.parentId || !inGroup.has(r.parentId))) visit(r);
        for (const r of rows) visit(r);
        // Si la marchandise a été commandée chez cette usine pour cette importation, on affiche ce qui a été payé (quantité et prix réels), pas le besoin théorique.
        const lines = ordered.map((n) => {
          const b = factoryId ? bought.get(`${factoryId}|${n.productId}`) : undefined;
          const theo = factoryId ? factoryLinePrice(db, n.productId, factoryId) : null;
          const price = b ? { eur: toEur(b.usd, 'USD', db.settings), source: 'prix' as const, unitPrice: Math.round(b.usd * 100) / 100, currency: 'USD' as const, detail: `Prix payé (commande ${b.refs.join(', ') || 'sans réf.'})` } : theo;
          return { n, included: includedInParentPrice(db, n), price, bought: b, need: n.qty };
        });
        const usd = (eur: number) => fromEur(eur, 'USD', db.settings);
        const unitUsd = (pr: NonNullable<(typeof lines)[number]['price']>) => (pr.currency === 'USD' ? pr.unitPrice : usd(pr.eur));
        const billed = lines.filter((l) => !l.included);
        const orderLines: Order['lines'] = billed.map(({ n, price }) => ({ productId: n.productId, qty: n.qty, unitPrice: price ? Math.round(unitUsd(price) * 100) / 100 : 0, currency: 'USD' }));
        const totalUsd = billed.reduce((t, { n, price, bought: b }) => t + (price ? unitUsd(price) * (b ? b.qty : n.qty) : 0), 0);
        const unknown = billed.filter((l) => !l.price).length;
        grandTotal += totalUsd;
        const localDepth = (n: (typeof rows)[number]) => { let d = 0; let cur = n; while (cur.parentId && inGroup.has(cur.parentId)) { d++; cur = rows.find((x) => x.productId === cur.parentId)!; } return d; };
        return (
          <div key={factoryId ?? 'fr'} className="needs-group">
            <div className="row-flex">
              <b style={{ cursor: factory ? 'pointer' : undefined }} onClick={() => factory && go('factories', factory.id)}>{factory ? factory.name : '🇫🇷 Assemblé en France (rien à commander pour ces lignes)'}</b>
              {factory && <Stars value={factory.rating} size={11} />}
              {factory && <label className="small row-flex" style={{ gap: 6, marginLeft: 8, cursor: 'pointer' }} title={hasOrder(factory.id) ? 'Une commande (hors devis) existe déjà pour cette usine dans cette importation' : 'Coche quand la commande a été passée à cette usine'}><input type="checkbox" checked={launched.has(factory.id) || hasOrder(factory.id)} onChange={(e) => setLaunched(factory.id, e.target.checked)} /> {launched.has(factory.id) || hasOrder(factory.id) ? <Badge tone="green">commande lancée</Badge> : <span className="muted">commande à lancer</span>}</label>}
              <span style={{ flex: 1 }} />
              {factory && <><span className="small muted"><b>{formatMoney(totalUsd, 'USD')}</b>{unknown ? ` · ${unknown} prix inconnu${unknown > 1 ? 's' : ''}` : ''}</span><button className="btn small" onClick={() => onCreateOrder(factory.id, orderLines)}>📝 Créer la commande (brouillon)</button></>}
            </div>
            <table className="tbl small">
              <thead><tr><th>Référence</th><th>Pour</th><th className="num">Quantité</th><th className="num">Prix unitaire (USD)</th><th className="num">Total (USD)</th></tr></thead>
              <tbody>{lines.flatMap(({ n, included, price, bought: b }) => { const p = db.products.find((x) => x.id === n.productId); const parent = n.parentId ? db.products.find((x) => x.id === n.parentId) : null; const d = localDepth(n); const diff = b ? Math.round((b.qty - n.qty) * 100) / 100 : 0; const main = (
                <tr key={`${n.productId}|${n.parentId ?? ''}`} className="click" onClick={() => go('merchandise', n.productId)} style={included ? { opacity: 0.65 } : undefined}>
                  <td style={{ paddingLeft: 8 + d * 22 }}>{d > 0 ? <span className="muted">└ </span> : null}<b>{p?.name ?? '?'}</b>{p && p.version !== 'V1' ? <span className="muted"> {p.version}</span> : null}{p?.sku ? <span className="muted"> · {p.sku}</span> : null}{included && <span className="muted"> — {n.inPrice ? `fourni par l'usine de ${parent?.name} (compris dans son prix)` : `compris dans le prix de ${parent?.name}`}</span>}</td>
                  <td className="muted">{n.forProductId !== n.productId ? db.products.find((x) => x.id === n.forProductId)?.name : 'produit fini'}</td>
                  <td className="num">{b ? <span title={`Commandé / payé : ${b.qty} (commande ${b.refs.join(', ') || 'sans réf.'}) · besoin calculé d'après les compositions : ${n.qty}`}>{b.qty}{diff !== 0 && <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{diff > 0 ? `besoin ${n.qty} · +${diff} de marge / perte` : `⚠ besoin ${n.qty} · manque ${-diff}`}</div>}</span> : n.qty}</td>
                  <td className="num" title={price ? price.detail : "Aucun prix connu chez cette usine et rien à composer : ajoute un prix dans la fiche marchandise (onglet Prix) ou des coûts additionnels"}>{included ? <span className="muted">inclus</span> : price ? <span>{price.source === 'composition' || price.currency !== 'USD' ? '≈ ' : ''}{formatMoney(unitUsd(price), 'USD')}{price.source === 'composition' ? <span className="muted small"> (composé)</span> : b ? <span className="muted small"> (payé)</span> : null}</span> : <span className="muted">—</span>}</td>
                  <td className="num">{included ? '' : price ? formatMoney(unitUsd(price) * (b ? b.qty : n.qty), 'USD') : ''}</td>
                </tr>
              );
              // Sous-références fabriquées ailleurs, juste sous leur parent (commandées dans le bloc de leur usine).
              const crossRows = needs.filter((x) => x.parentId === n.productId && x.factoryId !== factoryId).map((x) => {
                const cp = db.products.find((y) => y.id === x.productId); const cf = x.factoryId ? db.factories.find((f) => f.id === x.factoryId) : null; const d = localDepth(n) + 1;
                return (
                  <tr key={`x-${x.productId}|${x.parentId}`} className="click" style={{ opacity: 0.6, fontStyle: 'italic' }} onClick={() => go('merchandise', x.productId)}>
                    <td style={{ paddingLeft: 8 + d * 22 }}><span className="muted">└ </span>{cp?.name ?? '?'} <span className="muted">— {x.inPrice ? `fourni par ${factory?.name ?? 'cette usine'} (compris dans le prix)` : cf ? `fabriqué chez ${cf.name} → à commander là-bas, puis envoyé ici` : 'usine inconnue'}</span></td>
                    <td className="muted">{db.products.find((y) => y.id === n.productId)?.name}</td>
                    <td className="num">{x.qty}</td><td className="num muted">{x.inPrice ? 'inclus' : '↓'}</td><td />
                  </tr>
                );
              });
              return [main, ...crossRows]; })}</tbody>
            </table>
          </div>
        );
      })}
      {open && groups.length > 1 && <div className="small mt">Marchandise toutes usines : <b>{formatMoney(grandTotal, 'USD')}</b> <span className="muted">(≈ {formatEur(toEur(grandTotal, 'USD', db.settings), 0)} · dernier prix connu chez chaque usine, ou sous-références + coûts additionnels quand il n'y a pas de prix · hors logistique et douane)</span></div>}
    </div>
  );
}

/** Fenêtre « 📎 » d'une carte : coche les documents à rattacher, ou importe de nouveaux PDF directement liés. */
function DocLinkModal({ project, factoryId, onClose }: { project: Project; factoryId: string; onClose: () => void }) {
  const { db, update, toast } = useStore();
  const { open: openDoc } = useViewer();
  const [q, setQ] = useState('');
  const name = factoryId === FR ? '🇫🇷 France (conteneur)' : db.factories.find((f) => f.id === factoryId)?.name ?? 'Usine';
  const linked = new Set(project.docLinks.filter((l) => l.factoryId === factoryId).map((l) => l.documentId));
  const setLinked = (documentId: string, on: boolean) => update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === project.id ? { ...p, docLinks: on ? [...p.docLinks.filter((l) => !(l.documentId === documentId && l.factoryId === factoryId)), { documentId, factoryId }] : p.docLinks.filter((l) => !(l.documentId === documentId && l.factoryId === factoryId)) } : p)) }));
  const docs = [...db.documents].filter((d) => !q || `${d.fileName} ${d.summary} ${d.kind}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => (linked.has(b.id) ? 1 : 0) - (linked.has(a.id) ? 1 : 0) || b.createdAt.localeCompare(a.createdAt));
  const importNew = async () => {
    const added = await api.importFiles();
    if (!added.length) return;
    update((d) => ({ ...d, documents: [...added, ...d.documents], projects: d.projects.map((p) => (p.id === project.id ? { ...p, docLinks: [...p.docLinks, ...added.map((x) => ({ documentId: x.id, factoryId }))] } : p)) }));
    toast(`${added.length} document${added.length > 1 ? 's' : ''} importé${added.length > 1 ? 's' : ''} et lié${added.length > 1 ? 's' : ''} à ${name}`);
  };
  return (
    <Modal title={`Documents liés à ${name}`} onClose={onClose} footer={<><button className="btn" onClick={importNew}>+ Importer des PDF / photos</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={onClose}>Fermer</button></>}>
      <div className="row-flex mb"><input className="search" placeholder="Rechercher un document…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} /><span className="small muted">{linked.size} lié{linked.size > 1 ? 's' : ''}</span></div>
      {docs.length === 0 ? <div className="muted small">Aucun document. Importe des PDF avec le bouton ci-dessous : ils seront directement liés à cette carte.</div> : (
        <div className="doclink-list">
          {docs.map((d) => (
            <label key={d.id} className="doclink-row">
              <input type="checkbox" checked={linked.has(d.id)} onChange={(e) => setLinked(d.id, e.target.checked)} />
              <span className="name" title={d.fileName}>{d.fileName}<span className="muted small"> · {fmtDate(d.createdAt.slice(0, 10))}{d.summary ? ` · ${d.summary.slice(0, 60)}${d.summary.length > 60 ? '…' : ''}` : ''}</span></span>
              <Badge>{KIND_LABELS[d.kind] ?? d.kind}</Badge>
              <button className="btn ghost small" title="Ouvrir" onClick={(e) => { e.preventDefault(); openDoc(d.id); }}>👁</button>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}


/** Résumé financier sur la carte d'une importation : CA net, bénéfice sans / avec transport. */
function FinanceStrip({ project }: { project: Project }) {
  const { db } = useStore();
  if (!project.contents.length) return <div className="small muted mt">Analyse financière : fais d'abord la liste de courses de l'importation.</div>;
  const f = projectFinance(db, project);
  const tone = (n: number) => (n > 0 ? 'green' : n < 0 ? 'red' : '') as 'green' | 'red' | '';
  return (
    <div className="mt" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <div className="row-flex small" style={{ flexWrap: 'wrap', gap: 12 }}>
        <span><span className="muted">CA net HT</span> <b>{formatEur(f.revenueEur, 0)}</b></span>
        <span><span className="muted">Bénéfice sans transport</span> <Badge tone={tone(f.profitNoTransportEur)}>{formatEur(f.profitNoTransportEur, 0)}</Badge></span>
        <span><span className="muted">avec transport</span> <Badge tone={tone(f.profitEur)}>{formatEur(f.profitEur, 0)}</Badge>{f.marginPct != null && <span className="muted"> · marge {f.marginPct.toFixed(0)} %</span>}</span>
        {f.missingPrices.length > 0 && <span className="muted">⚠ {f.missingPrices.length} sans prix de vente</span>}
      </div>
    </div>
  );
}

/** Onglet Analyse financière d'une importation. */
function FinanceTab({ project }: { project: Project }) {
  const { db, update, toast } = useStore();
  const { go } = useNav();
  const [target, setTarget] = useState(40);
  const [quick, setQuick] = useState<Record<string, string>>({});
  if (!project.contents.length) return <div className="card"><Empty icon="€" title="Pas encore d'analyse" text="L'analyse se base sur la liste de courses (ce qui arrive en France). Commence par la faire dans l'onglet Arborescence des flux." /></div>;
  const f: ProjectFinance = projectFinance(db, project);
  const tone = (n: number | null) => (n == null ? '' : n > 0 ? 'green' : n < 0 ? 'red' : '') as 'green' | 'red' | '';
  const savePrice = (productId: string) => {
    const v = Number(String(quick[productId] ?? '').replace(',', '.'));
    if (!(v > 0)) return;
    const existing = db.marketPrices.find((m) => m.productId === productId && m.market === 'FR');
    // Saisie en HT : stockée en TTC avec la TVA du marché FR (comme sur la fiche Marchandise).
    const vat = existing?.vatPct ?? db.settings.defaultVat.FR;
    const ttc = Math.round(v * (1 + vat / 100) * 100) / 100;
    update((d) => ({ ...d, marketPrices: existing ? d.marketPrices.map((m) => (m.id === existing.id ? { ...m, sellPrice: ttc, currency: 'EUR', date: today() } : m)) : [...d.marketPrices, { id: newId(), productId, market: 'FR', sellPrice: ttc, currency: 'EUR', vatPct: vat, platformFeePct: 0, lastMileCost: 0, date: today() }] }));
    setQuick({ ...quick, [productId]: '' }); toast('Prix de vente HT enregistré sur la fiche Marchandise');
  };
  return (
    <>
      <div className="grid c4 mb">
        <div className="stat"><div className="label">Coût marchandise</div><div className="value">{formatEur(f.goodsEur, 0)}</div><div className="hint">{f.missingCosts.length ? `⚠ ${f.missingCosts.length} coût${f.missingCosts.length > 1 ? 's' : ''} inconnu${f.missingCosts.length > 1 ? 's' : ''}` : 'prix payés ou derniers prix connus'}</div></div>
        <div className="stat"><div className="label">Transport + douane</div><div className="value">{formatEur(f.transportEur + f.dutyEur, 0)}</div><div className="hint">{f.shipments ? `${f.shipments} expédition${f.shipments > 1 ? 's' : ''} · réparti au volume (${f.totalCbm.toFixed(1)} m³)` : 'aucune expédition rattachée'}{f.dutyEur ? ` · douane ${formatEur(f.dutyEur, 0)}` : ''}</div></div>
        <div className="stat"><div className="label">Chiffre d'affaires net HT</div><div className="value">{formatEur(f.revenueEur, 0)}</div><div className="hint">après TVA, commissions et livraison client{f.missingPrices.length ? ` · ⚠ ${f.missingPrices.length} sans prix de vente` : ''}</div></div>
        <div className="stat"><div className="label">Bénéfice</div><div className="value" style={{ color: f.profitEur < 0 ? 'var(--bad)' : 'var(--ok)' }}>{formatEur(f.profitEur, 0)}</div><div className="hint">sans transport : {formatEur(f.profitNoTransportEur, 0)}{f.marginPct != null ? ` · marge ${f.marginPct.toFixed(0)} %` : ''}</div></div>
      </div>
      <div className="card">
        <div className="card-head">
          <div><h2>Par marchandise</h2><div className="small muted">Coût d'achat = prix payés dans les commandes de l'importation (sinon dernier prix connu / composition). Transport = coûts des expéditions rattachées, répartis au prorata du volume (colisage des fiches), sinon de la valeur. Prix de vente HT = fiche Marchandise › onglet Prix (marché France) ; le net HT déduit en plus la commission et la livraison client.</div></div>
          <label className="small row-flex" style={{ gap: 6 }}>Marge cible <input type="number" value={target} onChange={(e) => setTarget(Number(e.target.value))} style={{ width: 60 }} /> %</label>
        </div>
        <table className="tbl small">
          <thead><tr><th>Marchandise</th><th className="num">Qté</th><th className="num">Achat / u</th><th className="num">Transport / u</th><th className="num">Revient / u</th><th className="num">Vente HT / u</th><th className="num">Net HT / u</th><th className="num">Bénéf. sans transport</th><th className="num">Bénéf. avec transport</th><th className="num">Marge</th></tr></thead>
          <tbody>
            {f.lines.map((l) => {
              const landedUnit = l.qty > 0 ? (l.goodsEur + l.transportEur + l.dutyEur) / l.qty : 0;
              return (
                <tr key={l.productId}>
                  <td className="strong" style={{ cursor: 'pointer' }} onClick={() => go('merchandise', l.productId)} title={l.costDetail}>{l.name}{l.shareBasis === 'valeur' ? <span className="muted small" title="Pas de colisage sur la fiche : transport réparti à la valeur"> · transport à la valeur</span> : l.shareBasis === 'aucune' && f.transportEur ? <span className="muted small"> · pas de transport affecté</span> : null}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num" title={l.costDetail}>{formatEur(l.goodsUnitEur)}</td>
                  <td className="num">{formatEur(l.transportUnitEur)}{l.cbm ? <div className="muted" style={{ fontSize: 11 }}>{l.cbm.toFixed(2)} m³</div> : null}</td>
                  <td className="num">{formatEur(landedUnit)}</td>
                  <td className="num">{l.sellHtEur != null ? <span title={`TTC ${formatEur(l.sellTtcEur ?? 0)}`}>{formatEur(l.sellHtEur)}</span> : (
                    <span className="row-flex" style={{ gap: 4, justifyContent: 'flex-end' }}><input type="number" step="any" placeholder={`HT ex. ${Math.ceil(sellPriceHtForMargin(l, target, db))}`} value={quick[l.productId] ?? ''} onChange={(e) => setQuick({ ...quick, [l.productId]: e.target.value })} style={{ width: 90, textAlign: 'right' }} onKeyDown={(e) => { if (e.key === 'Enter') savePrice(l.productId); }} /><button className="btn small" onClick={() => savePrice(l.productId)}>OK</button></span>
                  )}</td>
                  <td className="num">{l.netUnitEur != null ? formatEur(l.netUnitEur) : <span className="muted">—</span>}</td>
                  <td className="num">{l.profitNoTransportEur != null ? <Badge tone={tone(l.profitNoTransportEur)}>{formatEur(l.profitNoTransportEur, 0)}</Badge> : <span className="muted">—</span>}</td>
                  <td className="num">{l.profitEur != null ? <Badge tone={tone(l.profitEur)}>{formatEur(l.profitEur, 0)}</Badge> : <span className="muted">—</span>}</td>
                  <td className="num">{l.marginPct != null ? `${l.marginPct.toFixed(0)} %` : <span className="muted" title={`Prix HT conseillé pour ${target} % de marge`}>→ {formatEur(sellPriceHtForMargin(l, target, db), 0)} HT</span>}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr className="total"><td>Total</td><td className="num">{f.lines.reduce((t, l) => t + l.qty, 0)}</td><td className="num">{formatEur(f.goodsEur, 0)}</td><td className="num">{formatEur(f.transportEur, 0)}</td><td className="num">{formatEur(f.costEur, 0)}</td><td /><td className="num">{formatEur(f.revenueEur, 0)}</td><td className="num">{formatEur(f.profitNoTransportEur, 0)}</td><td className="num">{formatEur(f.profitEur, 0)}</td><td className="num">{f.marginPct != null ? `${f.marginPct.toFixed(0)} %` : '—'}</td></tr></tfoot>
        </table>
        {f.missingPrices.length > 0 && <div className="small muted mt">Sans prix de vente : {f.missingPrices.map((x) => x.name).join(', ')} — saisis un prix HT directement dans la colonne « Vente HT / u » (le prix suggéré vise la marge cible), ou dans la fiche Marchandise › onglet Prix pour régler TVA, commission et livraison.</div>}
      </div>
    </>
  );
}
