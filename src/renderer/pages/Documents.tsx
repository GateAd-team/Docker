import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useNav } from '../App';
import { DocumentPreview, useViewer } from '../components/Viewer';
import { api, fileToPayload } from '../api';
import { Badge, ConfirmButton, Empty, Field, Modal, Select, fmtDate, Th, useColumnWidths, useSort } from '../components/ui';
import { KIND_LABELS } from '../../shared/extraction';
import type { Database, DocumentKind, DocumentRecord, ExtractionResult } from '../../shared/types';
import { applyProposal, buildProposal, defaultChoices, findMatchingOrders, findMatchingShipment, findProduct, mapLinesToOrder, type Choices, type Proposal } from '../applyExtraction';
import { ORDER_STATUS, SHIPMENT_STATUS, statusOf } from '../labels';
import { FolderSelect } from './Merchandise';
import { currentVersion, familyVersions, formatMoney, nextVersionLabel } from '../../shared/finance';

/** Supprime un document et toutes les références qui pointaient vers lui. */
export function removeDocument(db: Database, id: string): Database {
  return {
    ...db,
    documents: db.documents.filter((d) => d.id !== id),
    orders: db.orders.map((o) => ({ ...o, invoiceDocumentId: o.invoiceDocumentId === id ? null : o.invoiceDocumentId, proformaDocumentId: o.proformaDocumentId === id ? null : o.proformaDocumentId, packingListDocumentId: o.packingListDocumentId === id ? null : o.packingListDocumentId })),
    shipments: db.shipments.map((s) => (s.documentId === id ? { ...s, documentId: null } : s)),
    drawings: db.drawings.map((x) => (x.documentId === id ? { ...x, documentId: null } : x)),
    quotes: db.quotes.map((q) => (q.documentId === id ? { ...q, documentId: null } : q)),
    projects: db.projects.map((p) => ({ ...p, docLinks: p.docLinks.filter((l) => l.documentId !== id) })),
  };
}

export function DocumentsPage() {
  const { db, update, toast } = useStore();
  const { go } = useNav();
  const { open: openDoc } = useViewer();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<{ doc: DocumentRecord; result: ExtractionResult } | null>(null);
  const [filter, setFilter] = useState<'tous' | 'a_traiter' | 'traites'>('tous');
  const [queue, setQueue] = useState<string[]>([]);
  /** Analyse groupée : tous les documents de la file appartiennent à la même importation. */
  const [batch, setBatch] = useState<{ projectId: string; newProjectName: string } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [batchSetup, setBatchSetup] = useState<{ projectId: string; newProjectName: string } | null>(null);

  const addDocs = (docs: DocumentRecord[]) => {
    if (!docs.length) return;
    update((d) => ({ ...d, documents: [...docs, ...d.documents] }));
    toast(`${docs.length} document${docs.length > 1 ? 's' : ''} importé${docs.length > 1 ? 's' : ''}`);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type === 'application/pdf' || f.type.startsWith('image/') || f.name.toLowerCase().endsWith('.pdf'));
    if (!files.length) { toast('Formats acceptés : PDF, PNG, JPG, WebP', true); return; }
    addDocs(await api.importDropped(await Promise.all(files.map(fileToPayload))));
  };

  // Coller une capture d'écran (Cmd/Ctrl+V)
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []).filter((i) => i.type.startsWith('image/'));
      if (!items.length) return;
      const files = items.map((i) => i.getAsFile()).filter((f): f is File => !!f);
      const payloads = await Promise.all(files.map(async (f, i) => ({ ...(await fileToPayload(f)), name: `capture-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}${files.length > 1 ? `-${i + 1}` : ''}.png` })));
      addDocs(await api.importDropped(payloads));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Document déjà analysé rencontré dans une file : on demande quoi faire au lieu de relancer l'IA. */
  const [already, setAlready] = useState<DocumentRecord | null>(null);
  const analyse = async (doc: DocumentRecord, opts: { force?: boolean; reuse?: boolean; inQueue?: boolean } = {}): Promise<boolean> => {
    if (doc.extracted && opts.reuse) {
      setReview({ doc, result: { kind: doc.kind, summary: doc.summary, confidence: 1, data: doc.extracted } });
      return true;
    }
    if (doc.extracted && !opts.force && opts.inQueue) { setAlready(doc); return true; }
    setBusy(doc.id);
    try {
      const raw = await api.extractDocument(doc.id);
      // Une facture marquée « proforma » par l'IA est traitée comme une proforma (même commande, statut PI reçue).
      const result = raw.kind === 'facture' && (raw.data as { isProforma?: boolean }).isProforma ? { ...raw, kind: 'proforma' as const } : raw;
      setReview({ doc, result });
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    } finally { setBusy(null); }
  };

  /** Enchaîne toutes les factures / documents « à traiter » : lecture, validation, suivant. */
  const analyseAll = () => {
    const pending = db.documents.filter((d) => !d.extracted).map((d) => d.id);
    if (!pending.length) { toast('Aucun document à traiter'); return; }
    setBatch(null);
    setQueue(pending.slice(1));
    const first = db.documents.find((d) => d.id === pending[0])!;
    analyse(first);
  };
  /** Analyse les documents cochés comme un même dossier : même importation proposée pour chacun. */
  const analyseSelection = (ctx: { projectId: string; newProjectName: string }) => {
    const ids = db.documents.filter((d) => sel.has(d.id)).map((d) => d.id);
    if (!ids.length) return;
    setBatch(ctx); setBatchSetup(null); setSel(new Set());
    setQueue(ids.slice(1));
    analyse(db.documents.find((d) => d.id === ids[0])!, { inQueue: true });
  };
  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const nextInQueue = async () => {
    let rest = [...queue];
    while (rest.length) {
      const id = rest.shift()!;
      setQueue(rest);
      const doc = db.documents.find((d) => d.id === id);
      if (doc && (await analyse(doc, { inQueue: true }))) return;
    }
    setQueue([]);
  };

  const [kindFilter, setKindFilter] = useState<'tous' | DocumentKind>('tous');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [byProject, setByProject] = useState(true);
  /** Importation à laquelle un document se rattache : via sa commande, via les liens de l'arborescence, ou via linkedTo. */
  const projectOf = (d: DocumentRecord): string | null => {
    const o = db.orders.find((x) => x.proformaDocumentId === d.id || x.invoiceDocumentId === d.id || x.packingListDocumentId === d.id);
    if (o?.projectId && db.projects.some((p) => p.id === o.projectId)) return o.projectId;
    const s = db.shipments.find((x) => x.documentId === d.id);
    if (s?.projectId) return s.projectId;
    const viaLink = d.linkedTo.find((l) => l.type === 'project')?.id;
    if (viaLink && db.projects.some((p) => p.id === viaLink)) return viaLink;
    const viaTree = db.projects.find((p) => p.docLinks.some((l) => l.documentId === d.id));
    return viaTree?.id ?? null;
  };
  const docs = db.documents
    .filter((d) => !(d.extracted as { photo?: boolean } | null)?.photo) // les photos de marchandises vivent sur leur fiche
    .filter((d) => filter === 'tous' || (filter === 'a_traiter' ? !d.extracted : !!d.extracted))
    .filter((d) => kindFilter === 'tous' || d.kind === kindFilter)
    .filter((d) => !q || `${d.fileName} ${d.summary}`.toLowerCase().includes(q.toLowerCase()));
  const sorter = useSort('documents', { key: 'date', dir: 'desc' });
  const cols = useColumnWidths('documents');
  const sortDocs = (rows: typeof docs) => sorter.apply(rows, { name: (d) => d.fileName, kind: (d) => (d.extracted ? KIND_LABELS[d.kind] : 'zzz à traiter'), summary: (d) => d.summary, date: (d) => d.createdAt });
  const [paneW, setPaneW] = useState<number>(() => { try { return Number(localStorage.getItem('docs:paneW')) || 0; } catch { return 0; } });
  const startSplit = (e: React.MouseEvent) => {
    e.preventDefault(); const startX = e.clientX; const startW = paneW || (document.querySelector('.doc-pane') as HTMLElement | null)?.getBoundingClientRect().width || 520;
    const move = (ev: MouseEvent) => setPaneW(Math.min(window.innerWidth - 420, Math.max(320, startW - (ev.clientX - startX))));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; setPaneW((w) => { try { localStorage.setItem('docs:paneW', String(w)); } catch { /* ignore */ } return w; }); };
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  const selected = db.documents.find((d) => d.id === selectedId) ?? null;
  useEffect(() => { if (!selectedId && docs.length) setSelectedId(docs[0].id); }, [docs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const kindCounts = db.documents.reduce<Record<string, number>>((acc, d) => { acc[d.kind] = (acc[d.kind] ?? 0) + 1; return acc; }, {});
  const setKind = (id: string, kind: DocumentKind) => update((d) => ({ ...d, documents: d.documents.map((x) => (x.id === id ? { ...x, kind } : x)) }));

  // Navigation clavier dans la liste : ↑ / ↓
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (review || (e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const i = docs.findIndex((d) => d.id === selectedId);
      const n = e.key === 'ArrowDown' ? Math.min(docs.length - 1, i + 1) : Math.max(0, i - 1);
      if (docs[n]) { setSelectedId(docs[n].id); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docs, selectedId, review]);

  return (
    <div className="page" style={{ maxWidth: 'none' }}>
      <div className="page-head">
        <div><h1>Documents</h1><div className="sub">Dépose factures, packing lists, plans, devis, captures d'écran : Bao les lit et remplit les fiches.</div></div>
        <div className="actions">
          {db.documents.some((d) => !d.extracted) && <button className="btn" disabled={!!busy} onClick={analyseAll}>{busy ? <><span className="spinner" /> Lecture…</> : `⚡ Tout analyser (${db.documents.filter((d) => !d.extracted).length})`}</button>}
          <button className="btn primary" onClick={async () => addDocs(await api.importFiles())}>+ Importer des fichiers</button>
        </div>
      </div>

      <div className="layout-2" style={{ alignItems: 'stretch' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className={`dropzone mb${over ? ' over' : ''}`} style={{ padding: 16 }} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
            <b>⇩ Glisse tes PDF, photos ou captures d'écran ici</b> <span className="small">— ou colle une capture avec Ctrl + V</span>
          </div>

          <div className="row-flex mb" style={{ flexWrap: 'wrap', gap: 6 }}>
            {(['tous', 'a_traiter', 'traites'] as const).map((f) => <button key={f} className={`btn small${filter === f ? ' primary' : ''}`} onClick={() => setFilter(f)}>{f === 'tous' ? `Tous (${db.documents.length})` : f === 'a_traiter' ? `À traiter (${db.documents.filter((d) => !d.extracted).length})` : 'Traités'}</button>)}
            <span style={{ width: 1, height: 22, background: 'var(--line)', margin: '0 4px' }} />
            <select className="search" style={{ minWidth: 190, padding: '4px 8px' }} value={kindFilter} onChange={(e) => setKindFilter(e.target.value as 'tous' | DocumentKind)}>
              <option value="tous">Tous les types</option>
              {(Object.keys(KIND_LABELS) as DocumentKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}{kindCounts[k] ? ` (${kindCounts[k]})` : ''}</option>)}
            </select>
            <input className="search" style={{ minWidth: 160, padding: '4px 8px' }} placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="small row-flex" style={{ gap: 6, cursor: 'pointer' }}><input type="checkbox" checked={byProject} onChange={(e) => setByProject(e.target.checked)} /> Par importation</label>
          </div>

          {sel.size > 0 && (
            <div className="card mb" style={{ padding: '10px 14px', background: 'var(--accent-soft)', borderColor: 'var(--accent)' }}>
              <div className="row-flex" style={{ flexWrap: 'wrap', gap: 8 }}>
                <b>{sel.size} document{sel.size > 1 ? 's' : ''} coché{sel.size > 1 ? 's' : ''}</b>
                <span className="small muted">— Bao les lit un par un et propose la même importation pour tous (proformas, factures et packing lists de plusieurs usines qui partent dans le même conteneur).</span>
                <span style={{ flex: 1 }} />
                <button className="btn primary small" disabled={!!busy} onClick={() => setBatchSetup({ projectId: db.projects.filter((p) => p.status !== 'archive' && p.status !== 'vente')[0]?.id ?? 'new', newProjectName: '' })}>✦ Analyser ensemble comme une même importation</button>
                <button className="btn ghost small" onClick={() => setSel(new Set())}>Tout décocher</button>
              </div>
            </div>
          )}
          {docs.length === 0 ? <div className="card"><Empty icon="📄" title={db.documents.length ? 'Aucun document ne correspond aux filtres' : 'Aucun document'} text={db.documents.length ? '' : 'Commence par importer une facture ou un plan.'} /></div> : (
            <div className="card pad0" style={{ overflowX: 'auto' }}>
              <table className="tbl">
                <thead><tr><th style={{ width: 28 }}><input type="checkbox" title="Tout cocher" checked={docs.length > 0 && docs.every((d) => sel.has(d.id))} onChange={() => setSel(docs.every((d) => sel.has(d.id)) ? new Set() : new Set(docs.map((d) => d.id)))} /></th><Th label="Fichier" sortKey="name" sort={sorter.sort} onSort={sorter.toggle} colKey="name" widths={cols.widths} onResize={cols.setWidth} /><Th label="Type" sortKey="kind" sort={sorter.sort} onSort={sorter.toggle} colKey="kind" widths={cols.widths} onResize={cols.setWidth} /><Th label="Résumé" sortKey="summary" sort={sorter.sort} onSort={sorter.toggle} colKey="summary" widths={cols.widths} onResize={cols.setWidth} /><Th label="Importé le" sortKey="date" sort={sorter.sort} onSort={sorter.toggle} defaultDir="desc" colKey="date" widths={cols.widths} onResize={cols.setWidth} /></tr></thead>
                <tbody>
                  {(() => {
                    // Regroupement par importation (les documents sans importation à la fin).
                    const groups: { key: string; label: string; items: typeof docs }[] = [];
                    if (byProject) {
                      const withP = docs.map((d) => ({ d, pid: projectOf(d) }));
                      for (const p of [...db.projects].sort((a, b) => (b.targetDate || b.createdAt).localeCompare(a.targetDate || a.createdAt))) { const items = withP.filter((x) => x.pid === p.id).map((x) => x.d); if (items.length) groups.push({ key: p.id, label: `📦 ${p.name}${p.container ? ` · ${p.container}` : ''}`, items: sortDocs(items) }); }
                      const rest = withP.filter((x) => !x.pid).map((x) => x.d); if (rest.length) groups.push({ key: '', label: 'Sans importation', items: sortDocs(rest) });
                    } else groups.push({ key: 'all', label: '', items: sortDocs(docs) });
                    return groups.flatMap((g) => [
                      ...(g.label ? [<tr key={`g-${g.key}`} className="group-row"><td colSpan={5}><span className="row-flex" style={{ gap: 8 }}><b>{g.label}</b><span className="muted small">{g.items.length} document{g.items.length > 1 ? 's' : ''}</span>{g.key && g.key !== 'all' && <a className="small" style={{ cursor: 'pointer' }} onClick={() => go('projects', g.key)}>ouvrir l'importation</a>}</span></td></tr>] : []),
                      ...g.items.map((d) => (
                    <tr key={d.id} className={`click${selectedId === d.id ? ' selected' : ''}`} onClick={() => setSelectedId(d.id)}>
                      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(d.id)} onChange={() => toggleSel(d.id)} /></td>
                      <td className="strong cell-clip" style={cols.widths.name ? undefined : { maxWidth: 220 }} title={d.fileName}>{d.mimeType === 'application/pdf' ? '📄' : '🖼'} {d.fileName}</td>
                      <td>{d.extracted ? <Badge tone="blue">{KIND_LABELS[d.kind]}</Badge> : <Badge tone="amber">À traiter</Badge>}</td>
                      <td className="small cell-clip" style={cols.widths.summary ? undefined : { maxWidth: 300 }} title={d.summary}>{d.summary || <span className="muted">Pas encore analysé</span>}</td>
                      <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(d.createdAt)}</td>
                    </tr>
                      )),
                    ]);
                  })()}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="pane-splitter" onMouseDown={startSplit} title="Glisser pour agrandir l'aperçu" />
        <aside className="doc-pane" style={paneW ? { width: paneW } : undefined}>
          {!selected ? <div className="empty"><div className="big">👁</div>Clique sur un document pour l'afficher ici.</div> : (
            <>
              <div className="doc-pane-head">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={selected.fileName}>{selected.fileName}</div>
                  <div className="small muted">{selected.sizeBytes > 1e6 ? `${(selected.sizeBytes / 1e6).toFixed(1)} Mo` : `${Math.round(selected.sizeBytes / 1e3)} Ko`} · importé le {fmtDate(selected.createdAt)}</div>
                </div>
                <div className="row-flex" style={{ flex: 'none' }}>
                  <button className="btn small" title="Plein écran" onClick={() => openDoc(selected.id)}>⤢</button>
                  <button className="btn small primary" disabled={busy === selected.id} onClick={() => analyse(selected)}>{busy === selected.id ? <><span className="spinner" /> Lecture…</> : selected.extracted ? 'Relire' : '✦ Analyser'}</button>
                  <ConfirmButton label="✕" className="btn ghost small" onConfirm={() => { update((x) => removeDocument(x, selected.id)); setSelectedId(null); }} />
                </div>
              </div>
              <div className="doc-pane-meta">
                <div className="row-flex" style={{ flexWrap: 'wrap' }}>
                  <label className="small muted">Type</label>
                  <select value={selected.kind} onChange={(e) => setKind(selected.id, e.target.value as DocumentKind)} style={{ padding: '3px 6px', border: '1px solid var(--line)', borderRadius: 6 }}>
                    {(Object.keys(KIND_LABELS) as DocumentKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                  </select>
                  {!selected.extracted && <Badge tone="amber">Pas encore analysé</Badge>}
                  {selected.linkedTo.map((l, i) => <LinkChip key={i} type={l.type} id={l.id} />)}
                </div>
                {selected.summary && <div className="small mt">{selected.summary}</div>}
              </div>
              <div className="doc-pane-body"><DocumentPreview documentId={selected.id} height={0} /></div>
            </>
          )}
        </aside>
      </div>

      {batchSetup && (
        <Modal title="Analyser ces documents comme une même importation" onClose={() => setBatchSetup(null)} footer={<><button className="btn" onClick={() => setBatchSetup(null)}>Annuler</button><button className="btn primary" disabled={batchSetup.projectId === 'new' && !batchSetup.newProjectName.trim()} onClick={() => analyseSelection(batchSetup)}>Lancer la lecture ({sel.size})</button></>}>
          <p className="small muted" style={{ marginTop: 0 }}>Choisis l'importation (le conteneur) à laquelle rattacher tout ce que Bao va lire dans ces {sel.size} documents. Tu valides ensuite chaque document, avec l'importation déjà pré-remplie.</p>
          <div className="form c2">
            <Field label="Importation" span={2}><Select value={batchSetup.projectId} onChange={(v) => setBatchSetup({ ...batchSetup, projectId: v })} options={[...db.projects.filter((p) => p.status !== 'archive').map((p) => ({ value: p.id, label: `${p.name}${p.container ? ` · ${p.container}` : ''}` })), { value: 'new', label: '➕ Nouvelle importation…' }]} /></Field>
            {batchSetup.projectId === 'new' && <Field label="Nom de la nouvelle importation" span={2}><input autoFocus className="search" style={{ width: '100%' }} placeholder="ex. Conteneur 40HQ — décembre 2026" value={batchSetup.newProjectName} onChange={(e) => setBatchSetup({ ...batchSetup, newProjectName: e.target.value })} /></Field>}
          </div>
          <div className="small muted mt">Documents : {db.documents.filter((d) => sel.has(d.id)).map((d) => d.fileName).join(' · ')}</div>
        </Modal>
      )}
      {already && (
        <Modal title="Document déjà analysé" onClose={() => { setAlready(null); setQueue([]); setBatch(null); }} footer={<>
          <button className="btn" onClick={() => { setAlready(null); setQueue([]); setBatch(null); }}>Arrêter</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => { const d = already; setAlready(null); analyse(d, { force: true }); }}>Relire avec l'IA</button>
          <button className="btn" onClick={() => { const d = already; setAlready(null); analyse(d, { reuse: true }); }}>Revalider sans relire</button>
          <button className="btn primary" onClick={() => { setAlready(null); if (queue.length) nextInQueue(); else { setBatch(null); toast('Terminé'); } }}>Passer au suivant →</button>
        </>}>
          <p style={{ marginTop: 0 }}><b>{already.fileName}</b> a déjà été lu par Bao{already.extracted ? ` (${KIND_LABELS[already.kind]})` : ''}.</p>
          {already.summary && <p className="small muted">{already.summary}</p>}
          {already.linkedTo.length > 0 && <div className="row-flex small" style={{ flexWrap: 'wrap' }}><span className="muted">Rattaché à :</span>{already.linkedTo.map((l, i) => <LinkChip key={i} type={l.type} id={l.id} />)}</div>}
          <p className="small muted mt">« Passer au suivant » garde tout tel quel. « Revalider sans relire » rouvre la fenêtre de validation avec la lecture précédente (utile pour le rattacher à l'importation du lot), sans consommer d'appel IA. « Relire avec l'IA » refait la lecture complète.</p>
          {queue.length > 0 && <div className="small muted">Encore {queue.length} document{queue.length > 1 ? 's' : ''} dans la file.</div>}
        </Modal>
      )}
      {review && <ReviewModal doc={review.doc} result={review.result} remaining={queue.length} batch={batch} onClose={() => { setReview(null); setQueue([]); setBatch(null); }} onSaved={(n, createdProjectId) => { setReview(null); toast('Fiches mises à jour'); if (batch && createdProjectId && batch.projectId === 'new') setBatch({ projectId: createdProjectId, newProjectName: '' }); if (queue.length) nextInQueue(); else { setBatch(null); if (n) go(n.page, n.id); } }} />}
    </div>
  );
}

function LinkChip({ type, id }: { type: DocumentRecord['linkedTo'][number]['type']; id: string }) {
  const { db } = useStore();
  const { go } = useNav();
  const { open: openDoc } = useViewer();
  const map = {
    project: () => ({ label: db.projects.find((x) => x.id === id)?.name, nav: ['projects', id] as const }),
    product: () => ({ label: db.products.find((x) => x.id === id)?.name, nav: ['merchandise', id] as const }),
    factory: () => ({ label: db.factories.find((x) => x.id === id)?.name, nav: ['factories', id] as const }),
    partner: () => ({ label: db.partners.find((x) => x.id === id)?.name, nav: ['logistics', undefined] as const }),
    order: () => { const o = db.orders.find((x) => x.id === id); return { label: o ? `Cde ${o.reference}` : undefined, nav: o?.projectId && db.projects.some((p) => p.id === o.projectId) ? (['projects', o.projectId] as const) : (['factories', o?.factoryId] as const) }; },
    shipment: () => ({ label: db.shipments.find((x) => x.id === id)?.reference, nav: ['logistics', id] as const }),
    drawing: () => { const dr = db.drawings.find((x) => x.id === id); const p = db.products.find((x) => x.id === dr?.productId); return { label: dr ? `Plan ${dr.version}` : undefined, nav: ['merchandise', p?.id] as const }; },
  };
  const r = map[type]();
  if (!r.label) return null;
  return <span className="badge" style={{ cursor: 'pointer', marginRight: 4 }} onClick={() => go(r.nav[0], r.nav[1] ?? undefined)}>{r.label}</span>;
}

export function ReviewModal({ doc, result, remaining = 0, batch = null, onClose, onSaved }: { doc: DocumentRecord; result: ExtractionResult; remaining?: number; batch?: { projectId: string; newProjectName: string } | null; onClose: () => void; onSaved: (nav: { page: 'merchandise' | 'factories' | 'logistics' | 'projects'; id?: string } | null, createdProjectId?: string) => void }) {
  const { db, replace } = useStore();
  const proposal: Proposal = useMemo(() => buildProposal(result, db, doc), [result, db, doc]);
  const [choices, setChoices] = useState<Choices>(() => { const c = defaultChoices(proposal, db, batch && batch.projectId !== 'new' ? batch.projectId : ''); return batch ? { ...c, projectId: batch.projectId, newProjectName: batch.newProjectName } : c; });
  const [showRaw, setShowRaw] = useState(false);
  const matches = useMemo(() => findMatchingOrders(db, proposal), [db, proposal]);
  const matchedOrder = choices.orderId ? db.orders.find((o) => o.id === choices.orderId) : undefined;
  const projectOptions = [{ value: '', label: '— Aucune importation —' }, ...db.projects.filter((p) => p.status !== 'archive').map((p) => ({ value: p.id, label: `${p.name}${p.container ? ` · ${p.container}` : ''}` })), { value: 'new', label: '➕ Nouvelle importation…' }];
  const orderLabel = (o: typeof db.orders[number]) => `${o.reference || 'sans référence'} · ${db.factories.find((f) => f.id === o.factoryId)?.name ?? '?'} · ${fmtDate(o.date)} · ${statusOf(ORDER_STATUS, o.status).label}${o.projectId ? ` · ${db.projects.find((p) => p.id === o.projectId)?.name ?? ''}` : ''}`;
  const chooseOrder = (orderId: string) => {
    const o = orderId ? db.orders.find((x) => x.id === orderId) : undefined;
    const fromOrder = o ? mapLinesToOrder(db, proposal, o) : {};
    const productMap = { ...choices.productMap };
    for (const pp of proposal.products) {
      if (fromOrder[pp.key]) productMap[pp.key] = fromOrder[pp.key];
      else if (o && Object.values(fromOrder).includes(productMap[pp.key])) productMap[pp.key] = 'new';
      else if (!o) productMap[pp.key] = findProduct(db, '', pp.label, pp.details?.sku, pp.supplierLabel)?.id ?? 'new';
    }
    setChoices({ ...choices, orderId, productMap, projectId: batch ? choices.projectId : o?.projectId || choices.projectId });
  };


  const projectProducts = [...db.products].sort((a, b) => a.name.localeCompare(b.name));
  const families = projectProducts.filter((p) => currentVersion(db.products, p.familyId || p.id)?.id === p.id);
  const canSave = true;

  const save = () => {
    const next = applyProposal(db, doc, result, proposal, choices);
    replace(next);
    const pid = choices.projectId === 'new' ? next.projects.find((x) => !db.projects.some((y) => y.id === x.id))?.id : choices.projectId;
    const created = choices.projectId === 'new' ? pid : undefined;
    if ((proposal.order || result.kind === 'packing_list') && pid && next.projects.some((x) => x.id === pid)) onSaved({ page: 'projects', id: pid }, created);
    else if (proposal.order || proposal.factory) onSaved(proposal.factory?.draft.id ? { page: 'factories', id: proposal.factory.draft.id } : null, created);
    else if (proposal.shipment || proposal.partner) onSaved({ page: 'logistics' }, created);
    else if (proposal.drawing) onSaved({ page: 'merchandise', id: choices.drawingProductId }, created);
    else onSaved(null, created);
  };

  return (
    <Modal title={`${remaining ? `Lecture du document (encore ${remaining} après celui-ci)` : 'Lecture du document'}${batch ? ` · importation ${batch.projectId === 'new' ? `« ${batch.newProjectName} » (nouvelle)` : db.projects.find((p) => p.id === batch.projectId)?.name ?? ''}` : ''}`} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>{remaining ? 'Arrêter' : 'Plus tard'}</button><button className="btn primary" disabled={!canSave} onClick={save}>{remaining ? 'Enregistrer et passer au suivant →' : 'Enregistrer dans les fiches'}</button></>}>
      <div className="grid c2" style={{ gridTemplateColumns: 'minmax(0, 4fr) minmax(0, 7fr)' }}>
        <div style={{ minWidth: 0 }}>
          <DocumentPreview documentId={doc.id} height={340} />
          <div className="small muted mt">{doc.fileName}</div>
        </div>
        <div>
          <div className="row-flex mb"><Badge tone="blue">{KIND_LABELS[result.kind]}</Badge><span className="small muted">confiance {(result.confidence * 100).toFixed(0)} %</span><span style={{ flex: 1 }} /><button className="btn ghost small" onClick={() => setShowRaw(!showRaw)}>{showRaw ? 'Masquer' : 'Voir'} les données brutes</button></div>
          <p style={{ marginTop: 0 }}>{result.summary}</p>
          {showRaw && <pre className="mono" style={{ maxHeight: 200, overflow: 'auto', background: '#f8fafc', padding: 10, borderRadius: 8 }}>{JSON.stringify(result.data, null, 2)}</pre>}

          {(proposal.order || result.kind === 'packing_list') && proposal.factory?.existingId && (
            <div className={`dup-banner${matches.length ? ' warn' : ''}`}>
              {matches.length > 0 ? (
                <>
                  <div><b>⚠ Ce document ressemble à une commande déjà enregistrée</b> chez {db.factories.find((f) => f.id === proposal.factory!.existingId)?.name} : {matches[0].reasons.join(', ')}. {result.kind === 'facture' ? 'Sûrement la facture de la proforma déjà importée.' : result.kind === 'proforma' ? 'Sûrement la proforma de la facture déjà importée.' : result.kind === 'packing_list' ? 'Sûrement la packing list de cette commande.' : ''} Regrouper les deux documents sous la même commande évite les doublons de références et de prix.</div>
                </>
              ) : <div className="muted small">Aucune commande existante ne correspond chez cette usine : une nouvelle commande sera créée. Tu peux quand même la rattacher à une commande ci-dessous.</div>}
              <div className="row-flex mt">
                <label className="small" style={{ minWidth: 90 }}>Commande</label>
                <select value={choices.orderId} onChange={(e) => chooseOrder(e.target.value)} style={{ flex: 1 }}>
                  <option value="">➕ Nouvelle commande{proposal.order?.reference ? ` ${proposal.order.reference}` : ''}</option>
                  {matches.map((m) => <option key={m.order.id} value={m.order.id}>✔ Regrouper avec : {orderLabel(m.order)} ({m.reasons.join(', ')})</option>)}
                  {db.orders.filter((o) => o.factoryId === proposal.factory!.existingId && !matches.some((m) => m.order.id === o.id)).map((o) => <option key={o.id} value={o.id}>Rattacher à : {orderLabel(o)}</option>)}
                </select>
              </div>
              {matchedOrder && <div className="small muted mt">Les lignes ci-dessous ont été associées aux références de cette commande. {result.kind === 'facture' ? 'La facture remplace la proforma : référence, statut « acompte payé » et prix mis à jour.' : result.kind === 'packing_list' ? 'La packing list sera attachée à la commande et le colisage mis à jour.' : 'Le document sera attaché à la commande, sans la dupliquer.'}</div>}
            </div>
          )}
          {(proposal.order || result.kind === 'packing_list') && (
            <div className="row-flex mt">
              <label className="small" style={{ minWidth: 90 }}>Importation</label>
              <select value={choices.projectId} onChange={(e) => setChoices({ ...choices, projectId: e.target.value })} style={{ flex: 1 }}>{projectOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              {choices.projectId === 'new' && <input autoFocus placeholder="Nom de l'importation (ex. Conteneur octobre 2026)" value={choices.newProjectName} onChange={(e) => setChoices({ ...choices, newProjectName: e.target.value })} style={{ flex: 1 }} />}
            </div>
          )}
          {proposal.needsProject && proposal.products.length > 0 && (
            <Field label="Dossier pour les nouvelles références (modifiable ligne par ligne)"><FolderSelect value={choices.folderId || null} onChange={(v) => setChoices({ ...choices, folderId: v ?? '', newProducts: Object.fromEntries(Object.entries(choices.newProducts).map(([k, np]) => [k, { ...np, folderId: v }])) })} /></Field>
          )}

          <h3 className="mt">Ce qui sera enregistré</h3>
          {proposal.factory && (
            <label className="check"><input type="checkbox" checked={choices.saveFactory} onChange={(e) => setChoices({ ...choices, saveFactory: e.target.checked })} />
              <span>{proposal.factory.existingId ? <>Compléter l'usine existante <b>{db.factories.find((f) => f.id === proposal.factory!.existingId)?.name}</b></> : <>Créer l'usine <b>{proposal.factory.draft.name}</b></>}{proposal.factory.draft.city && <span className="muted small"> · {proposal.factory.draft.city}</span>}</span></label>
          )}
          {proposal.partner && (
            <label className="check"><input type="checkbox" checked={choices.savePartner} onChange={(e) => setChoices({ ...choices, savePartner: e.target.checked })} />
              <span>{proposal.partner.existingId ? 'Rattacher au' : 'Créer le'} {proposal.partner.draft.type} <b>{proposal.partner.draft.name}</b></span></label>
          )}
          {proposal.contacts.length > 0 && (
            <label className="check"><input type="checkbox" checked={choices.saveContacts} onChange={(e) => setChoices({ ...choices, saveContacts: e.target.checked })} />
              <span>Ajouter le contact {proposal.contacts.map((c) => <b key={c.id}>{c.name} </b>)}</span></label>
          )}

        </div>
      </div>
      <div>
          {proposal.products.length > 0 && (
            <div className="mt">
              <div className="small muted mb">Références détectées — l'IA a pré-rempli nom, description, code douanier et colisage. Pour chaque ligne : associe-la à une référence existante (ses champs vides seront complétés), ou crée-la en choisissant son nom interne, sa référence interne et son dossier :</div>
              <table className="tbl">
                <thead><tr><th style={{ width: '55%' }}>Ligne du document</th><th className="num">Qté</th><th className="num">Prix</th><th>Référence Bao</th></tr></thead>
                <tbody>{proposal.products.map((pp) => (
                  <tr key={pp.key}>
                    <td className="small">
                      <b>{pp.label}</b>{pp.isService && <Badge tone="amber">prestation</Badge>}{pp.details.sku && <span className="muted"> · {pp.details.sku}</span>}
                      {pp.details.description && <div className="muted" style={{ whiteSpace: 'pre-line' }}>{pp.details.description}</div>}
                      <div className="muted">{[pp.hsCode && `SH ${pp.hsCode}`, pp.details.dutyRatePct != null && `droits ~${pp.details.dutyRatePct} %`, pp.packing && `${pp.packing.unitsPerCarton}/carton · ${pp.packing.cartonCbm.toFixed(3)} m³`, (pp.packing?.unitWeightKg || pp.details.unitWeightKg) && `${(pp.packing?.unitWeightKg || pp.details.unitWeightKg)!.toFixed(2)} kg`].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="num">{pp.qty || '—'}</td>
                    <td className="num">{pp.unitPrice ? formatMoney(pp.unitPrice, proposal.currency) : '—'}</td>
                    <td style={{ minWidth: 260 }}>
                      <select value={choices.productMap[pp.key] ?? 'new'} onChange={(e) => setChoices({ ...choices, productMap: { ...choices.productMap, [pp.key]: e.target.value } })} style={{ width: '100%' }}>
                        <option value="new">➕ Créer une nouvelle référence</option>
                        <option value="service">🔧 Prestation (confection, assemblage…) — pas une marchandise</option>
                        <option value="skip">Ignorer cette ligne</option>
                        <optgroup label="🔧 Prestation à ajouter au coût de revient d'une référence">
                          {families.map((fam) => <option key={`svc-${fam.id}`} value={`service:${fam.id}`}>Prestation sur « {fam.name} » (+{pp.unitPrice ? formatMoney(pp.unitPrice, proposal.currency) : '…'} / unité)</option>)}
                        </optgroup>
                        {families.map((fam) => (
                          <optgroup key={fam.id} label={fam.name}>
                            <option value={`newversion:${fam.id}`}>🔁 Nouvelle version de « {fam.name} » ({nextVersionLabel(db.products, fam.familyId || fam.id)})</option>
                            {familyVersions(db.products, fam.familyId || fam.id).map((v) => <option key={v.id} value={v.id}>{v.name} — {v.version}{v.id === fam.id ? ' (actuelle)' : ''}{v.factoryId ? ` · ${db.factories.find((f) => f.id === v.factoryId)?.name?.split(' ')[0] ?? ''}` : ''}</option>)}
                          </optgroup>
                        ))}
                      </select>
                      {(choices.productMap[pp.key] ?? '') === 'service' && <div className="small muted mt">Gardée sur la commande comme prestation (elle compte dans le montant payé), sans créer de référence. Choisis « Prestation sur … » pour l'ajouter au coût de revient d'une référence.</div>}
                      {(choices.productMap[pp.key] ?? '').startsWith('service:') && <div className="small muted mt">Ajoutée en coût additionnel par unité sur cette référence (ex. confection ou assemblage), et gardée sur la commande.</div>}
                      {(choices.productMap[pp.key] ?? '').startsWith('newversion:') && <div className="small muted mt">La nouvelle version reprend la fiche et la composition de la version actuelle, avec l'usine et le prix de ce document. Tu pourras préciser ce qui change dans l'onglet Versions.</div>}
                      {(choices.productMap[pp.key] ?? 'new') === 'new' && (() => {
                        const np = choices.newProducts[pp.key] ?? { name: pp.label, sku: '', folderId: choices.folderId || null };
                        const setNp = (patch: Partial<typeof np>) => setChoices({ ...choices, newProducts: { ...choices.newProducts, [pp.key]: { ...np, ...patch } } });
                        const dup = np.sku && db.products.some((p) => p.sku && p.sku.toLowerCase() === np.sku.toLowerCase());
                        return (
                          <div className="new-ref">
                            <label><span>Nom interne</span><input value={np.name} onChange={(e) => setNp({ name: e.target.value })} /></label>
                            <label><span>Réf. interne</span><input value={np.sku} onChange={(e) => setNp({ sku: e.target.value })} placeholder="ex. WU-CAD-2010" style={dup ? { borderColor: 'var(--bad)' } : undefined} /></label>
                            {dup && <div className="small" style={{ color: 'var(--bad)' }}>Cette référence existe déjà dans le catalogue.</div>}
                            <label><span>Dossier</span><FolderSelect value={np.folderId} onChange={(v) => setNp({ folderId: v })} /></label>
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}

          {proposal.quotes && <label className="check mt"><input type="checkbox" checked={choices.saveQuotes} onChange={(e) => setChoices({ ...choices, saveQuotes: e.target.checked })} /><span>Ajouter ces prix à l'historique des prix</span></label>}
          {proposal.products.some((p) => p.packing) && <label className="check"><input type="checkbox" checked={choices.savePacking} onChange={(e) => setChoices({ ...choices, savePacking: e.target.checked })} /><span>Mettre à jour le colisage des références (pièces/carton, volume, poids)</span></label>}
          {proposal.order && <label className="check"><input type="checkbox" checked={choices.saveOrder} onChange={(e) => setChoices({ ...choices, saveOrder: e.target.checked })} /><span>{matchedOrder ? <>Regrouper avec la commande <b>{matchedOrder.reference || 'sans référence'}</b> (mise à jour, pas de doublon)</> : <>Créer la commande <b>{proposal.order.reference || 'sans référence'}</b> du {fmtDate(proposal.order.date)}</>}{choices.projectId && choices.projectId !== 'new' && db.projects.find((p) => p.id === choices.projectId) ? <span className="muted small"> · dans {db.projects.find((p) => p.id === choices.projectId)?.name}</span> : choices.projectId === 'new' && choices.newProjectName.trim() ? <span className="muted small"> · dans la nouvelle importation {choices.newProjectName}</span> : null}</span></label>}
          {result.kind === 'packing_list' && matchedOrder && <div className="check"><span>📎 La packing list sera attachée à la commande <b>{matchedOrder.reference || 'sans référence'}</b>.</span></div>}
          {proposal.shipment && (() => { const sh = proposal.shipment; const costs = sh.freightCost + sh.originFees + sh.destinationFees + sh.insuranceCost; const existing = choices.shipmentId ? db.shipments.find((x) => x.id === choices.shipmentId) : undefined; const label = (x: typeof db.shipments[number]) => `${x.reference || 'Expédition'}${x.trackingRef ? ` · ${x.trackingRef}` : ''} · ${statusOf(SHIPMENT_STATUS, x.status).label}${x.etd ? ` · ETD ${fmtDate(x.etd)}` : ''}`; return (
            <div className={`dup-banner${existing ? ' warn' : ''}`}>
              <label className="check"><input type="checkbox" checked={choices.saveShipment} onChange={(e) => setChoices({ ...choices, saveShipment: e.target.checked })} /><span>{existing ? <>Compléter l'expédition <b>{existing.reference || 'Expédition'}</b> avec ce document</> : <>Créer l'expédition <b>{sh.reference}</b></>}{costs ? ` (${formatMoney(costs, sh.currency)} de logistique)` : ''}{sh.trackingRef ? <span className="muted small"> · {sh.trackingRef}</span> : null}{sh.etd || sh.eta ? <span className="muted small"> · {[sh.etd && `ETD ${fmtDate(sh.etd)}`, sh.eta && `ETA ${fmtDate(sh.eta)}`].filter(Boolean).join(' · ')}</span> : null}</span></label>
              <div className="row-flex mt">
                <label className="small" style={{ minWidth: 90 }}>Expédition</label>
                <select value={choices.shipmentId} onChange={(e) => setChoices({ ...choices, shipmentId: e.target.value, saveShipment: true })} style={{ flex: 1 }}>
                  <option value="">➕ Nouvelle expédition {sh.reference}</option>
                  {db.shipments.map((x) => <option key={x.id} value={x.id}>{x.id === findMatchingShipment(db, proposal)?.id ? '✔ Correspond : ' : 'Rattacher à : '}{label(x)}</option>)}
                </select>
              </div>
              {existing && <div className="small muted mt">Les champs vides de l'expédition seront complétés (dates, volume, n° de conteneur / B/L, coûts s'ils manquent), le statut avance si le document le montre, et le document lui est attaché. Rien n'est écrasé.</div>}
            </div>
          ); })()}
          {proposal.drawing && (
            <>
              <label className="check"><input type="checkbox" checked={choices.saveDrawing} onChange={(e) => setChoices({ ...choices, saveDrawing: e.target.checked })} /><span>Ajouter une version de plan : <b>{proposal.drawing.title}</b></span></label>
              <Field label="Référence concernée"><Select value={choices.drawingProductId} onChange={(v) => setChoices({ ...choices, drawingProductId: v })} options={[{ value: '', label: '— Choisir —' }, ...projectProducts.map((p) => ({ value: p.id, label: p.name }))]} /></Field>
            </>
          )}
          {!proposal.factory && !proposal.partner && proposal.products.length === 0 && !proposal.drawing && !proposal.shipment && (
            <div className="muted small">Rien à créer automatiquement : le document sera simplement classé et rattaché à l'importation choisie.</div>
          )}
      </div>
    </Modal>
  );
}
