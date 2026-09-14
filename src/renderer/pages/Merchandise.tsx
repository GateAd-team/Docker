import React, { useEffect, useMemo, useState } from 'react';
import { newId, today, useStore } from '../store';
import { useNav } from '../App';
import { useViewer } from '../components/Viewer';
import { Badge, ConfirmButton, Empty, Field, Input, Modal, NumberInput, Select, Tabs, Textarea, fmtDate } from '../components/ui';
import { DRAWING_STATUS, ORDER_STATUS, statusOf } from '../labels';
import { MarketForm } from '../components/MarketForm';
import type { Currency, Database, Drawing, ExtraCost, Folder, Product, ProductComponent, Quote } from '../../shared/types';
import { currentVersion, effectiveComponents, extraCostEur, familyVersions, formatEur, formatMoney, nextVersionLabel, orderTotalEur, priceHistory, unitCost, type UnitCostResult } from '../../shared/finance';

/* ---------- Dossiers ---------- */

/** Dossiers triés en profondeur, avec leur niveau, pour les listes déroulantes et l'arbre. */
export function folderTree(folders: Folder[]): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number, seen: Set<string>) => {
    folders.filter((f) => f.parentId === parentId && !seen.has(f.id)).sort((a, b) => a.name.localeCompare(b.name)).forEach((f) => {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1, new Set([...seen, f.id]));
    });
  };
  walk(null, 0, new Set());
  return out;
}
export function folderPath(folders: Folder[], id: string | null): string {
  const parts: string[] = [];
  let cur = folders.find((f) => f.id === id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) { parts.unshift(cur.name); seen.add(cur.id); cur = folders.find((f) => f.id === cur!.parentId); }
  return parts.join(' / ');
}
function descendantFolderIds(folders: Folder[], id: string): Set<string> {
  const ids = new Set<string>([id]);
  let grew = true;
  while (grew) { grew = false; for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }
  return ids;
}

/* ---------- Catalogue : explorateur de dossiers avec glisser-déposer ---------- */

type DragPayload = { type: 'products'; ids: string[] } | { type: 'folder'; id: string };
/** Cible de dépôt : id de dossier, 'root' (racine). Portée par un attribut data-drop sur les éléments. */
type DropKey = string;

/**
 * Glisser-déposer maison (souris), indépendant du drag & drop HTML5 qui est peu fiable
 * dans Electron sous Windows. On suit la souris, on affiche une étiquette, et on lit
 * l'élément sous le curseur pour connaître la cible (attribut data-drop).
 */
function useMouseDrag(onDrop: (payload: DragPayload, target: DropKey | null) => void) {
  const [drag, setDrag] = useState<{ payload: DragPayload; label: string; x: number; y: number; active: boolean } | null>(null);
  const [over, setOver] = useState<DropKey | null>(null);
  const lastEnd = React.useRef(0);
  const ref = React.useRef<{ payload: DragPayload; label: string; sx: number; sy: number; active: boolean; over: DropKey | null } | null>(null);

  const begin = (payload: DragPayload, label: string) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, button, select, a, textarea')) return;
    ref.current = { payload, label, sx: e.clientX, sy: e.clientY, active: false, over: null };
    const move = (ev: MouseEvent) => {
      const st = ref.current; if (!st) return;
      if (!st.active) {
        if (Math.hypot(ev.clientX - st.sx, ev.clientY - st.sy) < 6) return; // seuil : un clic n'est pas un glisser
        st.active = true; document.body.classList.add('dragging');
      }
      ev.preventDefault();
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const key = el?.closest<HTMLElement>('[data-drop]')?.dataset.drop ?? null;
      st.over = key;
      setOver(key);
      setDrag({ payload: st.payload, label: st.label, x: ev.clientX, y: ev.clientY, active: true });
    };
    const up = () => {
      const st = ref.current; ref.current = null;
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging');
      setDrag(null); setOver(null);
      if (st?.active) { lastEnd.current = Date.now(); onDrop(st.payload, st.over); }
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  /** Vrai juste après un glisser : sert à ignorer le clic qui suit le relâchement. */
  const justDragged = () => Date.now() - lastEnd.current < 300;
  return { drag, over, begin, justDragged };
}

export function MerchandisePage() {
  const { db, update, replace, toast } = useStore();
  const { nav, go } = useNav();
  const [q, setQ] = useState('');
  const [view, setView] = useState<'folder' | 'all'>('folder');
  const [folderId, setFolderId] = useState<string | null>(null); // null = racine
  const [creating, setCreating] = useState<Product | null>(null);
  const [newPrice, setNewPrice] = useState<PriceEdit>({ unitPrice: 0, currency: 'USD', sellHt: 0 });
  const [folderEdit, setFolderEdit] = useState<Folder | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [openTree, setOpenTree] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const hoverTimer = React.useRef<number | undefined>(undefined);

  const selectedProduct = nav.id ? db.products.find((p) => p.id === nav.id) : undefined;

  const folder = folderId ? db.folders.find((f) => f.id === folderId) : undefined;
  const childFolders = (parentId: string | null) => db.folders.filter((f) => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));
  const countIn = (id: string) => { const ids = descendantFolderIds(db.folders, id); return db.products.filter((p) => p.folderId && ids.has(p.folderId)).length; };
  const matches = (p: Product) => `${p.name} ${p.supplierName} ${p.sku} ${p.description}`.toLowerCase().includes(q.toLowerCase());
  const showAll = view === 'all' || !!q;
  const isCurrent = (p: Product) => currentVersion(db.products, p.familyId || p.id)?.id === p.id;
  const products = (showAll ? db.products.filter((p) => !q || matches(p)) : db.products.filter((p) => (p.folderId ?? null) === (folderId ?? null))).filter((p) => q ? true : isCurrent(p)).sort((a, b) => a.name.localeCompare(b.name));
  const crumbs: Folder[] = [];
  { let cur = folder; const seen = new Set<string>(); while (cur && !seen.has(cur.id)) { crumbs.unshift(cur); seen.add(cur.id); cur = db.folders.find((f) => f.id === cur!.parentId); } }

  /* --- déplacements --- */
  const moveProducts = (ids: string[], target: string | null) => {
    update((d) => ({ ...d, products: d.products.map((p) => (ids.includes(p.id) ? { ...p, folderId: target } : p)) }));
    const name = target ? `« ${db.folders.find((f) => f.id === target)?.name} »` : 'la racine';
    toast(`${ids.length} référence${ids.length > 1 ? 's' : ''} déplacée${ids.length > 1 ? 's' : ''} vers ${name}`);
    setSelected(new Set());
  };
  const moveFolder = (id: string, target: string | null) => {
    if (id === target || (target && descendantFolderIds(db.folders, id).has(target))) { toast('Impossible : un dossier ne peut pas aller dans lui-même', true); return; }
    if ((db.folders.find((f) => f.id === id)?.parentId ?? null) === target) return;
    update((d) => ({ ...d, folders: d.folders.map((f) => (f.id === id ? { ...f, parentId: target } : f)) }));
    if (target) setOpenTree((o) => ({ ...o, [target]: true }));
    toast('Dossier déplacé');
  };
  const { drag, over, begin, justDragged } = useMouseDrag((payload, key) => {
    window.clearTimeout(hoverTimer.current);
    if (key == null) return;
    const target = key === 'root' ? null : key;
    if (payload.type === 'products') { if (payload.ids.some((id) => (db.products.find((p) => p.id === id)?.folderId ?? null) !== target)) moveProducts(payload.ids, target); }
    else moveFolder(payload.id, target);
  });
  // Survol prolongé d'un dossier fermé pendant un glisser → on le déplie.
  React.useEffect(() => {
    window.clearTimeout(hoverTimer.current);
    if (drag && over && over !== 'root' && db.folders.some((f) => f.parentId === over)) hoverTimer.current = window.setTimeout(() => setOpenTree((o) => ({ ...o, [over]: true })), 600);
  }, [over, drag, db.folders]);

  const beginProductDrag = (id: string) => {
    const ids = selected.has(id) ? [...selected] : [id];
    return begin({ type: 'products', ids }, ids.length > 1 ? `📦 ${ids.length} références` : `📦 ${db.products.find((p) => p.id === id)?.name ?? ''}`);
  };
  const beginFolderDrag = (id: string) => begin({ type: 'folder', id }, `📁 ${db.folders.find((f) => f.id === id)?.name ?? ''}`);

  /* --- dossiers --- */
  const saveFolder = () => {
    if (!folderEdit?.name.trim()) return;
    update((d) => ({ ...d, folders: d.folders.some((f) => f.id === folderEdit.id) ? d.folders.map((f) => (f.id === folderEdit.id ? folderEdit : f)) : [...d.folders, folderEdit] }));
    if (folderEdit.parentId) setOpenTree((o) => ({ ...o, [folderEdit.parentId!]: true }));
    setFolderEdit(null);
  };
  const deleteFolder = (id: string) => {
    const ids = descendantFolderIds(db.folders, id);
    const target = db.folders.find((f) => f.id === id)?.parentId ?? null;
    update((d) => ({ ...d, folders: d.folders.filter((f) => !ids.has(f.id)), products: d.products.map((p) => (p.folderId && ids.has(p.folderId) ? { ...p, folderId: target } : p)) }));
    if (folderId && ids.has(folderId)) setFolderId(target);
  };
  const openFolder = (id: string | null) => { setView('folder'); setFolderId(id); setQ(''); setSelected(new Set()); if (id) setOpenTree((o) => ({ ...o, [id]: true })); };
  const saveNew = () => {
    if (!creating?.name.trim()) return;
    update((d) => applyPriceEdit({ ...d, products: [...d.products, creating] }, creating, newPrice, { unitPrice: 0, currency: 'USD', sellHt: 0 }));
    setCreating(null); setNewPrice({ unitPrice: 0, currency: 'USD', sellHt: 0 }); toast('Référence créée'); go('merchandise', creating.id);
  };

  if (selectedProduct) return <ProductDetail product={selectedProduct} />;

  /* --- arbre gauche (récursif) --- */
  const TreeNode = ({ f, depth }: { f: Folder; depth: number }) => {
    const kids = childFolders(f.id);
    const isOpen = openTree[f.id] ?? depth < 1;
    return (
      <>
        <div className={`node${view === 'folder' && folderId === f.id && !q ? ' active' : ''}${over === f.id ? ' drop' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} data-drop={f.id}
          onMouseDown={beginFolderDrag(f.id)} onClick={() => { if (!justDragged()) openFolder(f.id); }}>
          <button className="twisty" onClick={(e) => { e.stopPropagation(); setOpenTree((o) => ({ ...o, [f.id]: !isOpen })); }} style={{ visibility: kids.length ? 'visible' : 'hidden' }}>{isOpen ? '▾' : '▸'}</button>
          <span className="ico">{isOpen && kids.length ? '📂' : '📁'}</span>
          <span className="label">{f.name}</span>
          <span className="n">{countIn(f.id)}</span>
          <button className="more" title="Renommer, déplacer, supprimer" onClick={(e) => { e.stopPropagation(); setFolderEdit(f); }}>✎</button>
        </div>
        {isOpen && kids.map((k) => <TreeNode key={k.id} f={k} depth={depth + 1} />)}
      </>
    );
  };

  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const rowsOf = (p: Product, depth: number, comp: ProductComponent | null, seen: Set<string>): { p: Product; depth: number; comp: ProductComponent | null }[] => {
    const out = [{ p, depth, comp }];
    if (expanded[p.id] && !seen.has(p.id)) for (const c of p.components) { const sub = db.products.find((x) => x.id === c.productId); if (sub) out.push(...rowsOf(sub, depth + 1, c, new Set([...seen, p.id]))); }
    return out;
  };
  const rows = products.flatMap((p) => rowsOf(p, 0, null, new Set()));
  const unclassified = db.products.filter((p) => !p.folderId).length;

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      {drag?.active && <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 }}>{drag.label}</div>}
      <div className="page-head">
        <div><h1>Marchandise</h1><div className="sub">Ton catalogue, rangé en dossiers. Attrape une référence ou un dossier et lâche-le sur un dossier pour le déplacer.</div></div>
        <div className="actions">
          <input className="search" placeholder="Rechercher dans tout le catalogue…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={() => setFolderEdit({ id: newId(), name: '', parentId: folderId })}>+ Dossier</button>
          <button className="btn primary" onClick={() => setCreating(blankProduct(db.settings.defaultDutyRatePct, folderId))}>+ Référence</button>
        </div>
      </div>

      <div className="layout-2">
        <div className="card folder-tree" style={{ padding: 8, position: 'sticky', top: 16 }}>
          <div className={`node root${view === 'all' && !q ? ' active' : ''}`} onClick={() => { setView('all'); setQ(''); setSelected(new Set()); }}>
            <span className="ico">▦</span><span className="label">Toutes les références</span><span className="n">{db.products.length}</span>
          </div>
          <div className={`node root${view === 'folder' && folderId === null && !q ? ' active' : ''}${over === 'root' ? ' drop' : ''}`} data-drop="root" onClick={() => openFolder(null)}>
            <span className="ico">🏠</span><span className="label">Racine</span><span className="n">{unclassified}</span>
          </div>
          {childFolders(null).map((f) => <TreeNode key={f.id} f={f} depth={0} />)}
          {db.folders.length === 0 && <div className="small muted" style={{ padding: 8 }}>Aucun dossier. Clique « + Dossier » pour commencer (ex. Modules, Composants, Accessoires).</div>}
          <div className="small muted" style={{ padding: '10px 8px 4px', borderTop: '1px solid var(--line)', marginTop: 8 }}>Astuce : maintiens le clic sur une référence ou un dossier, déplace la souris et lâche sur un dossier.</div>
        </div>

        <div className="grow">
          <div className="breadcrumb" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {q ? <span>Résultats pour « {q} » dans tout le catalogue ({products.length})</span>
              : view === 'all' ? <span>▦ Toutes les références ({db.products.length}) — la colonne « Dossier » indique où chacune est rangée</span>
              : <><a onClick={() => openFolder(null)}>🏠 Racine</a>{crumbs.map((c) => <React.Fragment key={c.id}><span>›</span><a onClick={() => openFolder(c.id)}>{c.name}</a></React.Fragment>)}</>}
            <span style={{ flex: 1 }} />
            {selected.size > 0 && <span className="row-flex small"><Badge tone="blue">{selected.size} sélectionnée{selected.size > 1 ? 's' : ''}</Badge><span className="muted">glisse-les vers un dossier, ou</span>
              <select className="search" style={{ minWidth: 160, padding: '3px 8px' }} value="" onChange={(e) => { if (e.target.value === '__root') moveProducts([...selected], null); else if (e.target.value) moveProducts([...selected], e.target.value); }}>
                <option value="">Déplacer vers…</option><option value="__root">🏠 Racine</option>
                {folderTree(db.folders).map(({ folder: f, depth }) => <option key={f.id} value={f.id}>{'  '.repeat(depth)}📁 {f.name}</option>)}
              </select>
              <button className="btn small" onClick={() => { let d = db; const ids: string[] = []; for (const id of selected) { const r = duplicateProduct(d, id); if (r) { d = r.db; ids.push(r.newId); } } replace(d); setSelected(new Set(ids)); toast(`${ids.length} copie${ids.length > 1 ? 's' : ''} créée${ids.length > 1 ? 's' : ''}`); }}>⧉ Dupliquer</button>
              <ConfirmButton label={`🗑 Supprimer (${selected.size})`} onConfirm={() => { const n = selected.size; update((d) => deleteProducts(d, [...selected])); setSelected(new Set()); toast(`${n} référence${n > 1 ? 's' : ''} supprimée${n > 1 ? 's' : ''}`); }} />
              <button className="btn ghost small" onClick={() => setSelected(new Set())}>✕</button></span>}
          </div>

          {drag?.active && view === 'folder' && !q && (
            <div className={`drop-banner${over === (folderId ?? 'root') ? ' drop' : ''}`} data-drop={folderId ?? 'root'}>
              {drag.payload.type === 'products' ? `Lâcher ici pour ranger ${drag.payload.ids.length > 1 ? `ces ${drag.payload.ids.length} références` : 'cette référence'} dans « ${folder?.name ?? 'Racine'} »` : `Lâcher ici pour mettre ce dossier dans « ${folder?.name ?? 'Racine'} »`} — ou sur un dossier à gauche.
            </div>
          )}

          {!showAll && (
            <div className="folder-cards">
              {childFolders(folderId).map((f) => (
                <div key={f.id} className={`folder-card${over === f.id ? ' drop' : ''}`} data-drop={f.id} onMouseDown={beginFolderDrag(f.id)} onClick={() => { if (!justDragged()) openFolder(f.id); }}>
                  <div className="big">📁</div>
                  <div><div style={{ fontWeight: 600 }}>{f.name}</div><div className="small muted">{countIn(f.id)} réf.{childFolders(f.id).length ? ` · ${childFolders(f.id).length} sous-dossier${childFolders(f.id).length > 1 ? 's' : ''}` : ''}</div></div>
                  <button className="more" onClick={(e) => { e.stopPropagation(); setFolderEdit(f); }}>✎</button>
                </div>
              ))}
              <div className="folder-card new" onClick={() => setFolderEdit({ id: newId(), name: '', parentId: folderId })}><div className="big">＋</div><div><div style={{ fontWeight: 600 }}>Nouveau dossier</div><div className="small muted">{folder ? `dans « ${folder.name} »` : 'à la racine'}</div></div></div>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="card" data-drop={folderId ?? 'root'}>
              <Empty icon="📦" title={q ? 'Aucune référence ne correspond' : folder ? `Aucune référence directement dans « ${folder.name} »` : 'Aucune référence à la racine'} text={q ? '' : 'Glisse des références ici, ou crée-en une avec « + Référence ».'} />
            </div>
          ) : (
            <div className="card pad0">
              <table className="tbl">
                <thead><tr><th style={{ width: 34 }}><input type="checkbox" checked={products.length > 0 && products.every((p) => selected.has(p.id))} onChange={(e) => setSelected(e.target.checked ? new Set(products.map((p) => p.id)) : new Set())} title="Tout sélectionner" /></th><th>Référence</th>{showAll && <th>Dossier</th>}<th>Composition</th><th>Usine</th><th>Plans</th><th className="num">Coût unitaire</th><th></th></tr></thead>
                <tbody>
                  {rows.map(({ p, depth, comp }, i) => {
                    const cost = unitCost(p.id, db);
                    const factory = db.factories.find((f) => f.id === p.factoryId);
                    const latest = db.drawings.filter((d) => d.productId === p.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                    const nOpt = p.components.filter((c) => c.role === 'option').length;
                    const isChild = depth > 0;
                    return (
                      <tr key={`${p.id}-${i}`} className={`click${selected.has(p.id) ? ' selected' : ''}${!isChild ? ' grab' : ''}`} onMouseDown={isChild ? undefined : beginProductDrag(p.id)} onClick={() => { if (!justDragged()) go('merchandise', p.id); }} style={isChild ? { background: '#fafbfc' } : undefined}>
                        <td onClick={(e) => e.stopPropagation()}>{!isChild && <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSel(p.id)} />}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: depth * 22 }}>
                            {p.components.length > 0 ? <button className="btn ghost small" style={{ padding: '0 4px', width: 22 }} onClick={(e) => { e.stopPropagation(); setExpanded((x) => ({ ...x, [p.id]: !x[p.id] })); }}>{expanded[p.id] ? '▾' : '▸'}</button> : <span style={{ width: 22, display: 'inline-block', textAlign: 'center', color: 'var(--muted)' }}>{isChild ? '└' : '⋮⋮'}</span>}
                            <div>
                              <div style={{ fontWeight: isChild ? 500 : 600 }}>{comp && <span className="muted">{comp.qty} × </span>}{p.name}{p.isFinished && !isChild && <Badge tone="green" >produit final</Badge>}{(familyVersions(db.products, p.familyId || p.id).length > 1 || p.version !== 'V1') && <Badge tone={isCurrent(p) ? 'green' : ''} >{p.version}{!isCurrent(p) ? ' · ancienne' : ''}</Badge>}{comp?.role === 'option' && <Badge tone={comp.isDefault ? 'blue' : ''}>{comp.optionGroup || 'option'}{comp.isDefault ? ' · défaut' : ''}</Badge>}</div>
                              <div className="small muted">{[p.sku, isChild && !showAll ? folderPath(db.folders, p.folderId) : null].filter(Boolean).join(' · ')}</div>
                            </div>
                          </div>
                        </td>
                        {showAll && <td className="small">{p.folderId ? <a style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); openFolder(p.folderId); }}>📁 {folderPath(db.folders, p.folderId)}</a> : <span className="muted">🏠 Racine</span>}</td>}
                        <td className="small">{p.components.length ? <Badge tone="blue">{p.components.length - nOpt} sous-réf.{nOpt ? ` + ${nOpt} option${nOpt > 1 ? 's' : ''}` : ''}</Badge> : <span className="muted">achetée</span>}</td>
                        <td className="small" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={factory?.name}>{factory?.name ?? <span className="muted">—</span>}</td>
                        <td className="small">{latest ? <Badge tone={statusOf(DRAWING_STATUS, latest.status).tone}>{latest.version}</Badge> : <span className="muted">—</span>}</td>
                        <td className="num">{cost ? <>{formatEur(cost.costEur)}{cost.missing.length > 0 && <span className="muted small" title="Certaines sous-références n'ont pas de prix"> (partiel)</span>}</> : <span className="muted">—</span>}</td>
                        <td className="right" style={{ whiteSpace: 'nowrap' }}>{!isChild && <button className="btn ghost small" title="Dupliquer cette référence" onClick={(e) => { e.stopPropagation(); const r = duplicateProduct(db, p.id); if (r) { replace(r.db); toast(`Copie créée : ${p.name} (copie)`); go('merchandise', r.newId); } }}>⧉</button>}<button className="btn ghost small" title="Finance" onClick={(e) => { e.stopPropagation(); go('finance', p.id); }}>€</button>{!isChild && <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-block' }}><ConfirmButton label="🗑" className="btn ghost small" onConfirm={() => { update((d) => deleteProducts(d, [p.id])); toast(`« ${p.name} » supprimée`); }} /></span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {creating && (
        <Modal title="Nouvelle référence" onClose={() => setCreating(null)} footer={<><button className="btn" onClick={() => setCreating(null)}>Annuler</button><button className="btn primary" onClick={saveNew}>Créer</button></>}>
          <ProductForm value={creating} onChange={setCreating} />
          <h3 className="mt">Prix</h3>
          <div className="form c3"><PriceFields value={newPrice} onChange={setNewPrice} factoryName={creating.factoryId ? db.factories.find((f) => f.id === creating.factoryId)?.name : undefined} /></div>
        </Modal>
      )}
      {folderEdit && (
        <Modal title={db.folders.some((f) => f.id === folderEdit.id) ? 'Dossier' : 'Nouveau dossier'} onClose={() => setFolderEdit(null)}
          footer={<>{db.folders.some((f) => f.id === folderEdit.id) && <ConfirmButton label="Supprimer le dossier" onConfirm={() => { deleteFolder(folderEdit.id); setFolderEdit(null); }} />}<span style={{ flex: 1 }} /><button className="btn" onClick={() => setFolderEdit(null)}>Annuler</button><button className="btn primary" onClick={saveFolder}>Enregistrer</button></>}>
          <div className="form c2">
            <Field label="Nom du dossier"><Input value={folderEdit.name} onChange={(v) => setFolderEdit({ ...folderEdit, name: v })} placeholder="Ex. : Housses, Fixations, Wall 2 m…" /></Field>
            <Field label="Dans le dossier"><FolderSelect value={folderEdit.parentId} onChange={(v) => setFolderEdit({ ...folderEdit, parentId: v })} exclude={folderEdit.id} /></Field>
          </div>
          <div className="small muted mt">Supprimer un dossier ne supprime pas les références : elles remontent dans le dossier parent.</div>
        </Modal>
      )}
    </div>
  );
}

export function FolderSelect({ value, onChange, exclude }: { value: string | null; onChange: (v: string | null) => void; exclude?: string }) {
  const { db } = useStore();
  const excluded = exclude ? descendantFolderIds(db.folders, exclude) : new Set<string>();
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— Racine / non classée —</option>
      {folderTree(db.folders).filter(({ folder }) => !excluded.has(folder.id)).map(({ folder, depth }) => <option key={folder.id} value={folder.id}>{'  '.repeat(depth)}{depth ? '└ ' : ''}{folder.name}</option>)}
    </select>
  );
}

/**
 * Duplique une référence : même fiche, même composition, mêmes prix usine et prix de vente (nouveaux ids).
 * Les plans et les commandes ne sont pas copiés. Renvoie la base modifiée et l'id de la copie.
 */
/** Supprime des références et tout ce qui pointe vers elles (composition, plans, prix, lignes de commande, contenu des importations). */
export function deleteProducts(db: Database, ids: string[]): Database {
  const gone = new Set(ids);
  return {
    ...db,
    products: db.products.filter((p) => !gone.has(p.id)).map((p) => ({ ...p, components: p.components.filter((c) => !gone.has(c.productId)) })),
    drawings: db.drawings.filter((x) => !gone.has(x.productId)),
    quotes: db.quotes.filter((x) => !gone.has(x.productId)),
    marketPrices: db.marketPrices.filter((x) => !gone.has(x.productId)),
    orders: db.orders.map((o) => ({ ...o, lines: o.lines.filter((l) => !gone.has(l.productId)) })),
    projects: db.projects.map((pr) => ({ ...pr, contents: pr.contents.filter((l) => !gone.has(l.productId)), flows: pr.flows.map((f) => ({ ...f, lines: f.lines.filter((l) => !gone.has(l.productId)) })) })),
    documents: db.documents.map((d) => ({ ...d, linkedTo: d.linkedTo.filter((l) => !(l.type === 'product' && gone.has(l.id))) })),
  };
}

export function duplicateProduct(db: Database, id: string): { db: Database; newId: string } | null {
  const src = db.products.find((p) => p.id === id);
  if (!src) return null;
  const nid = newId();
  const copy: Product = { ...src, id: nid, familyId: nid, version: 'V1', versionDate: today(), versionNotes: '', isCurrentVersion: true, name: `${src.name} (copie)`, sku: src.sku ? `${src.sku}-COPIE` : '', components: src.components.map((c) => ({ ...c })), extraCosts: src.extraCosts.map((x) => ({ ...x, id: newId() })), notes: src.notes };
  const quotes = db.quotes.filter((q) => q.productId === id).map((q) => ({ ...q, id: newId(), productId: nid }));
  const prices = db.marketPrices.filter((m) => m.productId === id).map((m) => ({ ...m, id: newId(), productId: nid }));
  return { db: { ...db, products: [...db.products, copy], quotes: [...db.quotes, ...quotes], marketPrices: [...db.marketPrices, ...prices] }, newId: nid };
}

export const blankProduct = (dutyRatePct: number, folderId: string | null): Product => {
  const id = newId();
  return {
  id, projectId: null, folderId, name: '', familyId: id, version: 'V1', versionDate: today(), versionNotes: '', isCurrentVersion: true, supplierName: '', sku: '', description: '', factoryId: null, components: [], componentsIncludedInPrice: false, extraCosts: [], assemblyCostEur: 0,
  hsCode: '', dutyRatePct, unitWeightKg: 0, unitsPerCarton: 0, cartonCbm: 0, notes: '',
  };
};

/** Nouvelle version d'une famille à partir de sa version actuelle. */
export function createNextVersion(db: Database, productId: string, notes = ''): { db: Database; newId: string } | null {
  const src = db.products.find((p) => p.id === productId);
  if (!src) return null;
  const fam = src.familyId || src.id;
  const nid = newId();
  const copy: Product = { ...src, id: nid, familyId: fam, version: nextVersionLabel(db.products, fam), versionDate: today(), versionNotes: notes, isCurrentVersion: true, components: src.components.map((c) => ({ ...c })), extraCosts: src.extraCosts.map((x) => ({ ...x, id: newId() })) };
  return { db: { ...db, products: [...db.products.map((p) => ((p.familyId || p.id) === fam ? { ...p, isCurrentVersion: false } : p)), copy] }, newId: nid };
}

/** Prix saisis directement dans le formulaire de la référence : prix d'achat usine (devis) et prix de vente HT (marché France). */
export interface PriceEdit { unitPrice: number; currency: Currency; sellHt: number }
export function initPriceEdit(db: Database, product: Product): PriceEdit {
  const q = priceHistory(db.quotes.filter((x) => !product.factoryId || x.factoryId === product.factoryId), product.id, db.settings).at(-1) ?? priceHistory(db.quotes, product.id, db.settings).at(-1);
  const mp = db.marketPrices.find((m) => m.productId === product.id && m.market === 'FR');
  return { unitPrice: q?.unitPrice ?? 0, currency: q?.currency ?? 'USD', sellHt: mp && mp.sellPrice > 0 ? Math.round((mp.sellPrice / (1 + mp.vatPct / 100)) * 100) / 100 : 0 };
}
/** Applique les prix saisis : nouveau devis si le prix d'achat a changé, prix de vente FR mis à jour (stocké TTC avec la TVA du marché). */
export function applyPriceEdit(db: Database, product: Product, pe: PriceEdit, before: PriceEdit): Database {
  let next = db;
  if (pe.unitPrice > 0 && (pe.unitPrice !== before.unitPrice || pe.currency !== before.currency)) {
    next = { ...next, quotes: [...next.quotes, { id: newId(), productId: product.id, factoryId: product.factoryId ?? '', date: today(), unitPrice: pe.unitPrice, currency: pe.currency, moq: 0, incoterm: 'FOB', leadTimeDays: 0, documentId: null, notes: 'Saisi dans la fiche' }] };
  }
  if (pe.sellHt > 0 && pe.sellHt !== before.sellHt) {
    const existing = next.marketPrices.find((m) => m.productId === product.id && m.market === 'FR');
    const vat = existing?.vatPct ?? next.settings.defaultVat.FR;
    const ttc = Math.round(pe.sellHt * (1 + vat / 100) * 100) / 100;
    next = { ...next, marketPrices: existing ? next.marketPrices.map((m) => (m.id === existing.id ? { ...m, sellPrice: ttc, currency: 'EUR', date: today() } : m)) : [...next.marketPrices, { id: newId(), productId: product.id, market: 'FR', sellPrice: ttc, currency: 'EUR', vatPct: vat, platformFeePct: 0, lastMileCost: 0, date: today() }] };
  }
  return next;
}
function PriceFields({ value, onChange, factoryName }: { value: PriceEdit; onChange: (v: PriceEdit) => void; factoryName?: string }) {
  return (
    <>
      <Field label={`Prix d'achat usine${factoryName ? ` (${factoryName})` : ''}`}><NumberInput value={value.unitPrice} onChange={(v) => onChange({ ...value, unitPrice: v })} /></Field>
      <Field label="Devise"><Select value={value.currency} onChange={(v) => onChange({ ...value, currency: v })} options={[{ value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }, { value: 'CNY', label: 'CNY' }, { value: 'GBP', label: 'GBP' }]} /></Field>
      <Field label="Prix de vente HT (France, €)"><NumberInput value={value.sellHt} onChange={(v) => onChange({ ...value, sellHt: v })} /></Field>
      <Field label="" span={3}><div className="small muted">Le prix d'achat crée une ligne dans l'historique des prix (onglet Prix) à la date du jour ; le prix de vente HT alimente l'analyse financière des importations (TVA du marché France appliquée pour le TTC).</div></Field>
    </>
  );
}

function ProductForm({ value, onChange }: { value: Product; onChange: (p: Product) => void }) {
  const { db } = useStore();
  const set = <K extends keyof Product>(k: K) => (v: Product[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="form c3">
      <Field label="Nom interne (le tien)" span={2}><Input value={value.name} onChange={set('name')} placeholder="Ex. : Wall 1 m, Housse anthracite, Plaque EPP…" /></Field>
      <Field label="Réf. interne (code)"><Input value={value.sku} onChange={set('sku')} placeholder="WU-…" /></Field>
      <Field label="Libellé fournisseur (tel que sur les factures)" span={2}><Input value={value.supplierName} onChange={set('supplierName')} placeholder="Ex. : Big Frame 2000mm x 1000mm x 40mm" /></Field>
      <Field label="Dossier"><FolderSelect value={value.folderId} onChange={(v) => onChange({ ...value, folderId: v })} /></Field>
      <Field label="Version"><Input value={value.version} onChange={set('version')} placeholder="V1" /></Field>
      <Field label="Date de la version"><Input type="date" value={value.versionDate} onChange={set('versionDate')} /></Field>
      <Field label="Ce qui change dans cette version"><Input value={value.versionNotes} onChange={set('versionNotes')} placeholder="procédé, matière, usine…" /></Field>
      <Field label="Usine de fabrication" span={3}><Select value={value.factoryId ?? ''} onChange={(v) => onChange({ ...value, factoryId: v || null })} options={[{ value: '', label: '— Aucune / assemblée en interne —' }, ...db.factories.map((f) => ({ value: f.id, label: f.name }))]} /></Field>
      <Field label="Description" span={3}><Textarea value={value.description} onChange={set('description')} placeholder="Matière, dimensions, finition, à quoi ça sert…" /></Field>
      <Field label="Code douanier (SH)"><Input value={value.hsCode} onChange={set('hsCode')} placeholder="7610.90" /></Field>
      <Field label="Droits de douane"><NumberInput value={value.dutyRatePct} onChange={set('dutyRatePct')} unit="%" /></Field>
      <Field label=""><div className="small muted" style={{ paddingTop: 20 }}>Les coûts additionnels (assemblage, transport…) se gèrent sur la fiche, onglet « Fiche ».</div></Field>
      <Field label="Produit final" span={3}><label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={!!value.isFinished} onChange={(e) => onChange({ ...value, isFinished: e.target.checked })} style={{ marginTop: 3 }} /><span><b>Produit final</b> : ce qui se vend et arrive en France dans le conteneur (paravent, Wall, chariot…). Décoché : composant ou matière (tissu, cadre, EPP…). Les produits finaux sont proposés en premier dans la liste de courses des importations et dans l'analyse financière.</span></label></Field>
      <Field label="Prix usine et composition" span={3}><label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={value.componentsIncludedInPrice} onChange={(e) => onChange({ ...value, componentsIncludedInPrice: e.target.checked })} style={{ marginTop: 3 }} /><span>Le prix usine de cette référence <b>inclut déjà</b> ses sous-références (l'usine fournit tout). Décoché : coût = prix usine + sous-références (ex. tu fournis le tissu à l'atelier de confection).</span></label></Field>
      <Field label="Poids unitaire"><NumberInput value={value.unitWeightKg} onChange={set('unitWeightKg')} unit="kg" /></Field>
      <Field label="Pièces par carton"><NumberInput value={value.unitsPerCarton} onChange={set('unitsPerCarton')} /></Field>
      <Field label="Volume d'un carton"><NumberInput value={value.cartonCbm} onChange={set('cartonCbm')} unit="m³" /></Field>
      <Field label="Notes" span={3}><Textarea value={value.notes} onChange={set('notes')} /></Field>
    </div>
  );
}

/* ---------- Coûts additionnels ---------- */

const EXTRA_COST_SUGGESTIONS = ['Assemblage', 'Production / main d\'œuvre', 'Transport interne', 'Réparation / retouche', 'Contrôle qualité', 'Emballage', 'Stockage', 'Étiquetage', 'Certification'];

function ExtraCostsEditor({ product, onChange }: { product: Product; onChange: (x: ExtraCost[]) => void }) {
  const [draft, setDraft] = useState<ExtraCost | null>(null);
  const { db } = useStore();
  const total = product.extraCosts.reduce((t, x) => t + extraCostEur(x, db.settings), 0);
  const setLine = (id: string, patch: Partial<ExtraCost>) => onChange(product.extraCosts.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  return (
    <>
      <div className="card-head"><h3 style={{ margin: 0 }}>Coûts additionnels par unité</h3><span className="row-flex"><span className="small muted">Total : <b>{formatEur(total)}</b></span><button className="btn small" onClick={() => setDraft({ id: newId(), label: '', amount: 0, currency: 'EUR', amountEur: 0, note: '' })}>+ Ajouter un coût</button></span></div>
      {product.extraCosts.length === 0 && !draft && <div className="muted small">Aucun. Ajoute ici ce que te coûte cette référence en plus de l'achat : assemblage, transport interne, réparation, contrôle qualité, emballage…</div>}
      {product.extraCosts.length > 0 && (
        <table className="tbl">
          <thead><tr><th>Poste</th><th>Note</th><th className="num">Montant / unité</th><th></th></tr></thead>
          <tbody>
            {product.extraCosts.map((x) => (
              <tr key={x.id}>
                <td><input value={x.label} onChange={(e) => setLine(x.id, { label: e.target.value })} list="extra-cost-labels" style={{ width: '100%', border: '1px solid transparent', borderRadius: 6, padding: '4px 6px', fontWeight: 600 }} onFocus={(e) => (e.target.style.borderColor = 'var(--line)')} onBlur={(e) => (e.target.style.borderColor = 'transparent')} /></td>
                <td><input value={x.note} placeholder="détail, base de calcul…" onChange={(e) => setLine(x.id, { note: e.target.value })} style={{ width: '100%', border: '1px solid transparent', borderRadius: 6, padding: '4px 6px' }} onFocus={(e) => (e.target.style.borderColor = 'var(--line)')} onBlur={(e) => (e.target.style.borderColor = 'transparent')} /></td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}><input type="number" step="any" value={x.amount} onChange={(e) => setLine(x.id, { amount: Number(e.target.value) })} style={{ width: 90, textAlign: 'right', border: '1px solid var(--line)', borderRadius: 6, padding: 4 }} /> <select value={x.currency} onChange={(e) => setLine(x.id, { currency: e.target.value as Currency })} style={{ padding: 4 }}>{(['EUR', 'USD', 'CNY', 'GBP'] as Currency[]).map((c) => <option key={c} value={c}>{c}</option>)}</select>{x.currency !== 'EUR' && <div className="small muted">≈ {formatEur(extraCostEur(x, db.settings))}</div>}</td>
                <td className="right"><button className="btn ghost small" onClick={() => onChange(product.extraCosts.filter((y) => y.id !== x.id))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {draft && (
        <div className="row-flex mt" style={{ background: '#fafbfc', padding: 10, borderRadius: 8, flexWrap: 'wrap' }}>
          <input autoFocus list="extra-cost-labels" placeholder="Poste (ex. Assemblage)" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} style={{ flex: 1, minWidth: 160, border: '1px solid var(--line)', borderRadius: 6, padding: 6 }} onKeyDown={(e) => { if (e.key === 'Enter' && draft.label.trim()) { onChange([...product.extraCosts, draft]); setDraft(null); } }} />
          <input type="number" step="any" placeholder="Montant / unité" value={draft.amount || ''} onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })} style={{ width: 110, border: '1px solid var(--line)', borderRadius: 6, padding: 6, textAlign: 'right' }} />
          <select value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value as Currency })} style={{ padding: 6 }}>{(['EUR', 'USD', 'CNY', 'GBP'] as Currency[]).map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <input placeholder="Note (facultatif)" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} style={{ flex: 1, minWidth: 160, border: '1px solid var(--line)', borderRadius: 6, padding: 6 }} />
          <button className="btn primary small" disabled={!draft.label.trim()} onClick={() => { onChange([...product.extraCosts, draft]); setDraft(null); }}>Ajouter</button>
          <button className="btn small" onClick={() => setDraft(null)}>Annuler</button>
        </div>
      )}
      <datalist id="extra-cost-labels">{EXTRA_COST_SUGGESTIONS.map((l) => <option key={l} value={l} />)}</datalist>
      <div className="small muted mt">Ces montants s'ajoutent au coût de revient de la référence (et donc à celui des références qui l'utilisent).</div>
    </>
  );
}

/* ---------- Fiche d'une référence ---------- */

function ProductDetail({ product }: { product: Product }) {
  const { db, update, replace, toast } = useStore();
  const { go } = useNav();
  const { open: openDoc } = useViewer();
  const [tab, setTab] = useState<'fiche' | 'versions' | 'composition' | 'couts' | 'rd' | 'prix' | 'documents'>('fiche');
  const versions = familyVersions(db.products, product.familyId || product.id);
  const isCurrentV = currentVersion(db.products, product.familyId || product.id)?.id === product.id;
  const [edit, setEdit] = useState<Product | null>(null);
  const [priceEdit, setPriceEdit] = useState<{ before: PriceEdit; now: PriceEdit } | null>(null);
  useEffect(() => { if (edit) { const pe = initPriceEdit(db, edit); setPriceEdit({ before: pe, now: pe }); } else setPriceEdit(null); }, [edit?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [addComp, setAddComp] = useState<ProductComponent | null>(null);
  const [simu, setSimu] = useState<Record<string, string>>({});
  const [openComp, setOpenComp] = useState<Record<string, boolean>>({});
  const [vAdd, setVAdd] = useState<Record<string, ProductComponent | null>>({});

  const cost = useMemo(() => unitCost(product.id, db), [product.id, db]);
  const factory = db.factories.find((f) => f.id === product.factoryId);
  const parents = db.products.filter((p) => p.components.some((c) => c.productId === product.id));
  const drawings = db.drawings.filter((d) => d.productId === product.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const quotes = priceHistory(db.quotes, product.id, db.settings).reverse();
  const orders = db.orders.filter((o) => o.lines.some((l) => l.productId === product.id)).sort((a, b) => b.date.localeCompare(a.date));
  const docs = db.documents.filter((d) => d.linkedTo.some((l) => (l.type === 'product' && l.id === product.id)) || drawings.some((dr) => dr.documentId === d.id));

  const saveProduct = (p: Product) => update((d) => ({ ...d, products: d.products.map((x) => (x.id === p.id ? p : x)) }));
  const setComponents = (components: Product['components']) => saveProduct({ ...product, components });
  const candidates = db.products.filter((p) => p.id !== product.id && !product.components.some((c) => c.productId === p.id) && !isAncestor(p.id, product.id, db.products));

  const saveDrawing = () => {
    if (!drawing) return;
    update((d) => ({ ...d, drawings: d.drawings.some((x) => x.id === drawing.id) ? d.drawings.map((x) => (x.id === drawing.id ? drawing : x)) : [...d.drawings, drawing] }));
    setDrawing(null); toast('Version enregistrée');
  };
  const saveQuote = () => {
    if (!quote?.factoryId) return;
    update((d) => ({ ...d, quotes: d.quotes.some((x) => x.id === quote.id) ? d.quotes.map((x) => (x.id === quote.id ? quote : x)) : [...d.quotes, quote] }));
    setQuote(null); toast('Prix enregistré');
  };
  const remove = () => {
    update((d) => deleteProducts(d, [product.id]));
    toast(`« ${product.name} » supprimée`);
    go('merchandise');
  };

  return (
    <div className="page">
      <div className="breadcrumb"><a onClick={() => go('merchandise')}>Marchandise</a>{parents.map((pp) => <span key={pp.id}> › <a onClick={() => go('merchandise', pp.id)}>{pp.name}</a></span>)} › {product.name}</div>
      <div className="page-head">
        <div>
          <h1>{product.name} <Badge tone={isCurrentV ? 'green' : 'amber'}>{product.version}{isCurrentV ? ' · actuelle' : ' · ancienne version'}</Badge> {product.folderId && <Badge>{folderPath(db.folders, product.folderId)}</Badge>}</h1>
          <div className="sub">{[product.sku, product.supplierName && `chez l'usine : « ${product.supplierName} »`, factory ? `Fabriquée par ${factory.name}` : product.components.length ? 'Assemblée à partir de sous-références' : null].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="actions">
          <button className="btn" title="Créer la version suivante de cette référence (nouveau procédé, nouvelle usine…)" onClick={() => { const r = createNextVersion(db, product.id); if (r) { replace(r.db); toast(`${nextVersionLabel(db.products, product.familyId || product.id)} créée — note ce qui change dans l'onglet Versions`); go('merchandise', r.newId); } }}>🔁 Nouvelle version</button>
          <button className="btn" title="Créer une copie de cette référence (fiche, composition, prix)" onClick={() => { const r = duplicateProduct(db, product.id); if (r) { replace(r.db); toast('Copie créée — pense à la renommer'); go('merchandise', r.newId); } }}>⧉ Dupliquer</button>
          <button className="btn" title="Ajouter un coût d'assemblage, de production, de transport… à cette référence" onClick={() => setTab('couts')}>+ Coût</button>
          <button className="btn" onClick={() => go('finance', product.id)}>Finance →</button>
          <button className="btn primary" onClick={() => setEdit(product)}>Modifier</button>
          <ConfirmButton label="🗑 Supprimer" className="btn small" onConfirm={remove} />
        </div>
      </div>

      <div className="grid c4 mb">
        <div className="stat"><div className="label">Coût de revient unitaire</div><div className="value">{cost ? formatEur(cost.costEur) : '—'}</div><div className="hint">{cost ? cost.source : 'Aucun prix ni composition'}</div></div>
        <div className="stat"><div className="label">Composition</div><div className="value">{product.components.length || '—'}</div><div className="hint">{product.components.length ? `${product.components.filter((c) => c.role !== 'option').length} de base${product.components.some((c) => c.role === 'option') ? ` · ${product.components.filter((c) => c.role === 'option').length} options` : ''}` : 'référence achetée telle quelle'}</div></div>
        <div className="stat"><div className="label">Plans</div><div className="value">{drawings[0]?.version ?? '—'}</div><div className="hint">{drawings[0] ? statusOf(DRAWING_STATUS, drawings[0].status).label : 'aucun plan'}</div></div>
        <div className="stat"><div className="label">Utilisée dans</div><div className="value">{parents.length || '—'}</div><div className="hint">{parents.map((p) => p.name).join(', ') || 'référence finale'}</div></div>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'fiche', label: 'Fiche' }, { value: 'versions', label: `Versions (${versions.length})` }, { value: 'composition', label: `Composition (${product.components.length})` }, { value: 'couts', label: `Coûts additionnels (${product.extraCosts.length})` }, { value: 'rd', label: `R&D · plans (${drawings.length})` }, { value: 'prix', label: `Prix & commandes (${quotes.length + orders.length})` }, { value: 'documents', label: `Documents (${docs.length})` }]} />

      {tab === 'fiche' && (
        <div className="grid c2">
          <div className="card">
            <h3>Description</h3>
            <div style={{ whiteSpace: 'pre-wrap' }}>{product.description || <span className="muted">Aucune description. Clique « Modifier » pour la renseigner.</span>}</div>
            {product.notes && <><h3 className="mt">Notes</h3><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{product.notes}</div></>}
          </div>
          <div className="card">
            <h3>Caractéristiques</h3>
            <div className="kv">
              <span className="k">Réf. interne</span><span className="mono">{product.sku || '—'}</span>
              <span className="k">Libellé fournisseur</span><span>{product.supplierName || '—'}</span>
              <span className="k">Dossier</span><span>{folderPath(db.folders, product.folderId) || '—'}</span>
              <span className="k">Usine</span><span>{factory ? <a style={{ cursor: 'pointer' }} onClick={() => go('factories', factory.id)}>{factory.name}</a> : '—'}</span>
              <span className="k">Code douanier</span><span className="mono">{product.hsCode || '—'}</span>
              <span className="k">Droits de douane</span><span>{product.dutyRatePct} %</span>
              <span className="k">Poids unitaire</span><span>{product.unitWeightKg ? `${product.unitWeightKg} kg` : '—'}</span>
              <span className="k">Colisage</span><span>{product.unitsPerCarton ? `${product.unitsPerCarton} pcs/carton · ${product.cartonCbm} m³` : '—'}</span>
              <span className="k">Coûts additionnels</span><span><a style={{ cursor: 'pointer' }} onClick={() => setTab('couts')}>{product.extraCosts.length ? formatEur(product.extraCosts.reduce((t, x) => t + extraCostEur(x, db.settings), 0)) + ' / unité' : '+ ajouter (assemblage, production…)'}</a></span>
            </div>
          </div>
        </div>
      )}

      {tab === 'couts' && (
        <div className="grid c2">
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <ExtraCostsEditor product={product} onChange={(extraCosts) => saveProduct({ ...product, extraCosts })} />
          </div>
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <h3>Comment se calcule le coût de revient</h3>
            <div className="kv">
              <span className="k">Achat (prix usine rendu)</span><span>{cost?.purchaseEur ? formatEur(cost.purchaseEur) : '—'}</span>
              <span className="k">Composition (sous-références)</span><span>{cost ? formatEur(cost.compositionEur) : '—'}{product.componentsIncludedInPrice && <span className="muted small"> — déjà comprise dans le prix d'achat</span>}</span>
              <span className="k">Coûts additionnels</span><span>{formatEur(product.extraCosts.reduce((t, x) => t + extraCostEur(x, db.settings), 0))}</span>
              <span className="k"><b>Coût de revient unitaire</b></span><span><b>{cost ? formatEur(cost.costEur) : '—'}</b></span>
            </div>
          </div>
        </div>
      )}

      {tab === 'versions' && (() => {
        /** Réordonne la famille : la liste donnée devient V1, V2, … dans cet ordre. */
        const renumber = (ordered: Product[]) => update((d) => ({ ...d, products: d.products.map((x) => { const i = ordered.findIndex((o) => o.id === x.id); return i >= 0 ? { ...x, version: `V${i + 1}` } : x; }) }));
        const move = (idx: number, dir: -1 | 1) => { const arr = [...versions]; const j = idx + dir; if (j < 0 || j >= arr.length) return; [arr[idx], arr[j]] = [arr[j], arr[idx]]; renumber(arr); };
        /** Supprime une version (ses prix, plans et liens de composition) et renumérote les autres. */
        const deleteVersion = (v: Product) => {
          const rest = versions.filter((x) => x.id !== v.id);
          if (rest.length === 0) return;
          const wasCurrent = currentVersion(db.products, v.familyId || v.id)?.id === v.id;
          const newCurrent = wasCurrent ? rest[rest.length - 1].id : null;
          update((d) => ({
            ...d,
            products: d.products.filter((p) => p.id !== v.id).map((p) => {
              const i = rest.findIndex((o) => o.id === p.id);
              const next = { ...p, components: p.components.filter((c) => c.productId !== v.id) };
              if (i < 0) return next;
              return { ...next, version: `V${i + 1}`, isCurrentVersion: newCurrent ? p.id === newCurrent : p.isCurrentVersion };
            }),
            drawings: d.drawings.filter((x) => x.productId !== v.id),
            quotes: d.quotes.filter((q) => q.productId !== v.id),
          }));
          toast(`${v.version} supprimée`);
          if (v.id === product.id) go('merchandise', newCurrent ?? rest[0].id);
        };
        return (
        <div className="card">
          <div className="card-head"><h2>Évolution de la référence</h2><button className="btn small" onClick={() => { const r = createNextVersion(db, product.id); if (r) { replace(r.db); go('merchandise', r.newId); } }}>🔁 Nouvelle version</button></div>
          <div className="small muted mb">Chaque version est une fiche complète : usine, prix, composition, description. La version « actuelle » est celle utilisée dans le catalogue et les coûts. Les flèches ↑ ↓ changent l'ordre (les numéros V1, V2… suivent) — pratique pour ranger une ancienne version saisie après coup. 🗑 supprime une version avec ses prix et ses plans (les autres sont renumérotées).</div>
          <table className="tbl">
            <thead><tr><th style={{ width: 90 }}>Ordre</th><th>Version</th><th>Date</th><th>Ce qui change</th><th>Usine</th><th>Composition</th><th className="num">Dernier prix usine</th><th className="num">Coût de revient</th><th></th></tr></thead>
            <tbody>
              {versions.map((v, idx) => {
                const lastQ = priceHistory(db.quotes, v.id, db.settings).at(-1);
                const c = unitCost(v.id, db);
                const cur = currentVersion(db.products, v.familyId || v.id)?.id === v.id;
                return (
                  <tr key={v.id} className="click" style={v.id === product.id ? { background: 'var(--accent-soft)' } : undefined} onClick={() => go('merchandise', v.id)}>
                    <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}><button className="btn ghost small" disabled={idx === 0} title="Monter (version plus ancienne)" onClick={() => move(idx, -1)}>↑</button><button className="btn ghost small" disabled={idx === versions.length - 1} title="Descendre (version plus récente)" onClick={() => move(idx, 1)}>↓</button></td>
                    <td className="strong">{v.version} {cur && <Badge tone="green">actuelle</Badge>}</td>
                    <td onClick={(e) => e.stopPropagation()}><input type="date" defaultValue={v.versionDate} key={v.id + v.versionDate} onBlur={(e) => { if (e.target.value !== v.versionDate) update((d) => ({ ...d, products: d.products.map((x) => (x.id === v.id ? { ...x, versionDate: e.target.value } : x)) })); }} style={{ border: '1px solid transparent', borderRadius: 6, padding: 3, background: 'transparent' }} onFocus={(e) => (e.target.style.borderColor = 'var(--line)')} /></td>
                    <td className="small"><textarea defaultValue={v.versionNotes} key={v.id + v.versionNotes} placeholder="Ex. : tube 1,5 mm, soudure TIG, passage chez Onmuse…" onClick={(e) => e.stopPropagation()} onBlur={(e) => { if (e.target.value !== v.versionNotes) update((d) => ({ ...d, products: d.products.map((x) => (x.id === v.id ? { ...x, versionNotes: e.target.value } : x)) })); }} style={{ width: '100%', minHeight: 40, border: '1px solid transparent', borderRadius: 6, padding: 4, background: 'transparent', resize: 'vertical' }} onFocus={(e) => (e.target.style.borderColor = 'var(--line)')} /></td>
                    <td className="small">{db.factories.find((f) => f.id === v.factoryId)?.name ?? '—'}</td>
                    <td className="small" onClick={(e) => e.stopPropagation()}><button className="btn small" onClick={() => setOpenComp((o) => ({ ...o, [v.id]: !o[v.id] }))}>{openComp[v.id] ? '▾' : '▸'} {v.components.length} sous-réf.{v.extraCosts.length ? ` · ${v.extraCosts.length} coût${v.extraCosts.length > 1 ? 's' : ''}` : ''}</button></td>
                    <td className="num">{lastQ ? <>{formatMoney(lastQ.unitPrice, lastQ.currency)}<div className="small muted">{fmtDate(lastQ.date)}</div></> : '—'}</td>
                    <td className="num">{c ? formatEur(c.costEur) : '—'}</td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>{!cur && <button className="btn small" onClick={(e) => { e.stopPropagation(); update((d) => ({ ...d, products: d.products.map((x) => ((x.familyId || x.id) === (v.familyId || v.id) ? { ...x, isCurrentVersion: x.id === v.id } : x)) })); toast(`${v.version} est maintenant la version actuelle`); }}>Définir comme actuelle</button>}{' '}{versions.length > 1 && <span onClick={(e) => e.stopPropagation()}><ConfirmButton label="🗑" className="btn ghost small" onConfirm={() => deleteVersion(v)} /></span>}</td>
                  </tr>
                );
              }).flatMap((row, i) => {
                const v = versions[i];
                if (!openComp[v.id]) return [row];
                const vCandidates = db.products.filter((p) => p.id !== v.id && !v.components.some((c) => c.productId === p.id) && !isAncestor(p.id, v.id, db.products));
                const add = vAdd[v.id] ?? null;
                const setComps = (components: ProductComponent[]) => update((d) => ({ ...d, products: d.products.map((x) => (x.id === v.id ? { ...x, components } : x)) }));
                return [row, (
                  <tr key={`${v.id}-comp`}>
                    <td colSpan={9} style={{ background: '#fafbfc', padding: '12px 16px 16px' }}>
                      <div className="row-flex mb"><b>Composition de la {v.version}</b><span className="muted small">— chaque version a sa propre composition et ses propres coûts additionnels, pour un coût de revient juste à chaque étape.</span><span style={{ flex: 1 }} /><button className="btn small" onClick={() => setVAdd((a) => ({ ...a, [v.id]: { productId: vCandidates[0]?.id ?? '', qty: 1, role: 'base', optionGroup: '', isDefault: false } }))}>+ Sous-référence</button></div>
                      {v.components.length === 0 ? <div className="muted small">Aucune sous-référence dans cette version.</div> : <CompositionTable cost={unitCost(v.id, db)} product={v} simu={{}} onSimu={() => {}} onChange={setComps} />}
                      {add && (
                        <div className="mt" style={{ background: '#fff', padding: 10, borderRadius: 8, border: '1px solid var(--line)' }}>
                          <div className="form c4">
                            <Field label="Référence existante" span={2}><select value={add.productId} onChange={(e) => setVAdd((a) => ({ ...a, [v.id]: { ...add, productId: e.target.value } }))}><option value="">— Choisir —</option>{vCandidates.map((p) => <option key={p.id} value={p.id}>{p.name}{p.version !== 'V1' || familyVersions(db.products, p.familyId || p.id).length > 1 ? ` (${p.version})` : ''}</option>)}</select></Field>
                            <Field label="Quantité / unité"><NumberInput value={add.qty} onChange={(q) => setVAdd((a) => ({ ...a, [v.id]: { ...add, qty: q } }))} /></Field>
                            <Field label="Rôle"><Select value={add.role} onChange={(r) => setVAdd((a) => ({ ...a, [v.id]: { ...add, role: r } }))} options={[{ value: 'base', label: 'De base' }, { value: 'option', label: 'En option' }]} /></Field>
                            {add.role === 'option' && <Field label="Groupe d'options" span={2}><Input value={add.optionGroup} onChange={(g) => setVAdd((a) => ({ ...a, [v.id]: { ...add, optionGroup: g } }))} placeholder="Ex. : Housse" /></Field>}
                          </div>
                          <div className="row-flex mt">
                            <button className="btn primary small" disabled={!add.productId || (add.role === 'option' && !add.optionGroup.trim())} onClick={() => { let next = [...v.components, add]; if (add.role === 'option' && !next.some((c) => c !== add && c.role === 'option' && c.optionGroup === add.optionGroup && c.isDefault)) next = next.map((c) => (c === add ? { ...c, isDefault: true } : c)); setComps(next); setVAdd((a) => ({ ...a, [v.id]: null })); }}>Ajouter</button>
                            <button className="btn small" onClick={() => setVAdd((a) => ({ ...a, [v.id]: null }))}>Annuler</button>
                          </div>
                        </div>
                      )}
                      <div className="mt" style={{ background: '#fff', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--line)' }}>
                        <ExtraCostsEditor product={v} onChange={(extraCosts) => update((d) => ({ ...d, products: d.products.map((x) => (x.id === v.id ? { ...x, extraCosts } : x)) }))} />
                      </div>
                    </td>
                  </tr>
                )];
              })}
            </tbody>
          </table>
          {versions.length > 1 && (() => {
            const pts = versions.map((v) => ({ v, c: unitCost(v.id, db)?.costEur ?? null })).filter((x) => x.c != null);
            if (pts.length < 2) return null;
            const first = pts[0].c!, last = pts[pts.length - 1].c!;
            const d = ((last - first) / first) * 100;
            return <div className="small mt">Coût de revient : {formatEur(first)} ({pts[0].v.version}) → {formatEur(last)} ({pts[pts.length - 1].v.version}) <Badge tone={d > 0 ? 'red' : d < 0 ? 'green' : ''}>{d > 0 ? '+' : ''}{d.toFixed(1)} %</Badge></div>;
          })()}
          <div className="row-flex mt small">
            <button className="btn small" onClick={() => renumber([...versions].sort((a, b) => (a.versionDate || '9999').localeCompare(b.versionDate || '9999')))}>Trier par date</button>
            <span className="muted">Renumérote V1, V2… selon les dates saisies.</span>
          </div>
        </div>
        );
      })()}

      {tab === 'composition' && (
        <div className="card">
          <div className="card-head"><h2>Sous-références</h2><button className="btn small" onClick={() => setAddComp({ productId: candidates[0]?.id ?? '', qty: 1, role: 'base', optionGroup: '', isDefault: false })}>+ Ajouter une sous-référence</button></div>
          {product.components.length === 0 ? <Empty icon="🧩" title="Référence simple" text="Si cette référence est fabriquée à partir d'autres (ex. Wall 1 m = plaque + cadre + housse), ajoute-les ici : le coût se calcule tout seul. Une sous-référence peut être « en option » (plusieurs housses au choix)." /> : (
            <CompositionTable cost={cost} product={product} simu={simu} onSimu={setSimu} onChange={setComponents} />
          )}
          {addComp && (
            <div className="mt" style={{ background: '#fafbfc', padding: 12, borderRadius: 8 }}>
              <div className="form c4">
                <Field label="Référence existante" span={2}>
                  <select value={addComp.productId} onChange={(e) => setAddComp({ ...addComp, productId: e.target.value })}>
                    <option value="">— Choisir —</option>
                    {candidates.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''}</option>)}
                  </select>
                </Field>
                <Field label="Quantité par unité"><NumberInput value={addComp.qty} onChange={(v) => setAddComp({ ...addComp, qty: v })} /></Field>
                <Field label="Rôle"><Select value={addComp.role} onChange={(v) => setAddComp({ ...addComp, role: v })} options={[{ value: 'base', label: 'De base (toujours inclus)' }, { value: 'option', label: 'En option (au choix)' }]} /></Field>
                {addComp.role === 'option' && (
                  <>
                    <Field label="Groupe d'options" span={2}><Input value={addComp.optionGroup} onChange={(v) => setAddComp({ ...addComp, optionGroup: v })} placeholder="Ex. : Housse, Couleur, Traitement feu" /></Field>
                    <Field label="Coût standard"><label className="small" style={{ paddingTop: 8, display: 'block' }}><input type="checkbox" checked={addComp.isDefault} onChange={(e) => setAddComp({ ...addComp, isDefault: e.target.checked })} /> variante par défaut</label></Field>
                  </>
                )}
              </div>
              <div className="row-flex mt">
                <button className="btn primary small" disabled={!addComp.productId || (addComp.role === 'option' && !addComp.optionGroup.trim())} onClick={() => {
                  let next = [...product.components, addComp];
                  if (addComp.role === 'option' && addComp.isDefault) next = next.map((c) => (c !== addComp && c.role === 'option' && c.optionGroup === addComp.optionGroup ? { ...c, isDefault: false } : c));
                  if (addComp.role === 'option' && !next.some((c) => c.role === 'option' && c.optionGroup === addComp.optionGroup && c.isDefault)) next = next.map((c) => (c === addComp ? { ...c, isDefault: true } : c));
                  setComponents(next); setAddComp(null);
                }}>Ajouter</button>
                <button className="btn small" onClick={() => setAddComp(null)}>Annuler</button>
              </div>
            </div>
          )}
          <div className="small muted mt">Une sous-référence qui n'existe pas encore ? Crée-la d'abord depuis la liste Marchandise (bouton « + Référence »), puis ajoute-la ici.</div>
        </div>
      )}

      {tab === 'rd' && (
        <div className="card pad0">
          <div className="card-head" style={{ padding: '14px 20px 0' }}><h2>Plans techniques</h2><button className="btn small" onClick={() => setDrawing({ id: newId(), productId: product.id, version: `V${drawings.length + 1}`, title: '', changelog: '', status: 'brouillon', documentId: null, createdAt: new Date().toISOString() })}>+ Nouvelle version</button></div>
          {drawings.length === 0 ? <Empty icon="✎" title="Aucun plan" text="Importe le PDF du plan dans Documents (il sera reconnu comme plan technique) ou crée une version ici." /> : (
            <table className="tbl">
              <thead><tr><th>Version</th><th>Titre</th><th>Ce qui change</th><th>Statut</th><th>Date</th><th>Fichier</th></tr></thead>
              <tbody>{drawings.map((v) => {
                const vs = statusOf(DRAWING_STATUS, v.status);
                const doc = v.documentId ? db.documents.find((d) => d.id === v.documentId) : undefined;
                return (
                  <tr key={v.id} className="click" onClick={() => setDrawing(v)}>
                    <td className="strong">{v.version}</td><td>{v.title || '—'}</td><td className="small">{v.changelog || '—'}</td>
                    <td><Badge tone={vs.tone}>{vs.label}</Badge></td><td>{fmtDate(v.createdAt)}</td>
                    <td>{doc ? <button className="btn small" onClick={(e) => { e.stopPropagation(); openDoc(doc.id); }}>Ouvrir</button> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'prix' && (
        <>
          <div className="card mb">
            <div className="card-head"><div><h2>Prix de vente (France)</h2><div className="small muted">Utilisé par l'analyse financière des importations (en HT) et le calcul des marges. Saisis le HT ou le TTC, l'autre se recalcule avec la TVA.</div></div>{(() => { const mpFR = db.marketPrices.find((m) => m.productId === product.id && m.market === 'FR'); return mpFR && mpFR.sellPrice > 0 ? <Badge tone="green">HT {formatEur(mpFR.sellPrice / (1 + mpFR.vatPct / 100))}</Badge> : <Badge tone="amber">pas de prix de vente</Badge>; })()}</div>
            <MarketForm
              mp={db.marketPrices.find((m) => m.productId === product.id && m.market === 'FR') ?? { id: `mp-${product.id}-FR`, productId: product.id, market: 'FR', sellPrice: 0, currency: 'EUR', vatPct: db.settings.defaultVat.FR, platformFeePct: 0, lastMileCost: 0, date: today() }}
              onSave={(v) => { update((d) => ({ ...d, marketPrices: d.marketPrices.some((x) => x.id === v.id) ? d.marketPrices.map((x) => (x.id === v.id ? { ...v, date: today() } : x)) : [...d.marketPrices, { ...v, date: today() }] })); toast('Prix de vente enregistré'); }}
            />
            <div className="small muted mt">Autres marchés (UK, US) et détail des marges : page <a style={{ cursor: 'pointer' }} onClick={() => go('finance', product.id)}>Finance</a>.</div>
          </div>
          <div className="card pad0">
            <div className="card-head" style={{ padding: '14px 20px 0' }}><h2>Prix proposés par les usines</h2><button className="btn small" onClick={() => setQuote({ id: newId(), productId: product.id, factoryId: product.factoryId ?? db.factories[0]?.id ?? '', date: today(), unitPrice: 0, currency: 'USD', moq: 0, incoterm: 'FOB', leadTimeDays: 30, documentId: null, notes: '' })}>+ Prix</button></div>
            {quotes.length === 0 ? <Empty icon="€" title="Aucun prix" text="Ajoute un devis à la main ou importe une facture / PI dans Documents." /> : (
              <table className="tbl">
                <thead><tr><th>Date</th><th>Usine</th><th className="num">Prix</th><th className="num">En EUR</th><th className="num">MOQ</th><th>Incoterm</th><th className="num">Délai</th><th>Note</th></tr></thead>
                <tbody>{quotes.map((qq) => (
                  <tr key={qq.id} className="click" onClick={() => setQuote(qq)}>
                    <td>{fmtDate(qq.date)}</td><td className="small">{db.factories.find((f) => f.id === qq.factoryId)?.name ?? '—'}</td>
                    <td className="num">{formatMoney(qq.unitPrice, qq.currency)}</td><td className="num">{formatEur(qq.unitPriceEur)}</td>
                    <td className="num">{qq.moq || '—'}</td><td>{qq.incoterm}</td><td className="num">{qq.leadTimeDays ? `${qq.leadTimeDays} j` : '—'}</td><td className="small muted">{qq.notes}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
          <div className="card pad0">
            <div className="card-head" style={{ padding: '14px 20px 0' }}><h2>Commandes contenant cette référence</h2></div>
            {orders.length === 0 ? <Empty icon="⚙" title="Aucune commande" /> : (
              <table className="tbl">
                <thead><tr><th>Réf.</th><th>Usine</th><th>Date</th><th>Statut</th><th className="num">Qté</th><th className="num">Prix unitaire</th><th className="num">Total commande</th></tr></thead>
                <tbody>{orders.map((o) => {
                  const os = statusOf(ORDER_STATUS, o.status); const l = o.lines.find((x) => x.productId === product.id)!;
                  return <tr key={o.id} className="click" onClick={() => go('factories', o.factoryId, o.id)}><td className="strong">{o.reference || '—'}</td><td className="small">{db.factories.find((f) => f.id === o.factoryId)?.name}</td><td>{fmtDate(o.date)}</td><td><Badge tone={os.tone}>{os.label}</Badge></td><td className="num">{l.qty}</td><td className="num">{formatMoney(l.unitPrice, l.currency)}</td><td className="num">{formatEur(orderTotalEur(o, db.settings))}</td></tr>;
                })}</tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === 'documents' && (
        <div className="card pad0">
          {docs.length === 0 ? <Empty icon="⇩" title="Aucun document lié" text="Les factures, plans et catalogues rattachés à cette référence apparaîtront ici." /> : (
            <table className="tbl"><thead><tr><th>Fichier</th><th>Type</th><th>Résumé</th><th></th></tr></thead>
              <tbody>{docs.map((d) => <tr key={d.id}><td className="strong">{d.fileName}</td><td><Badge>{d.kind}</Badge></td><td className="small">{d.summary}</td><td className="right"><button className="btn small" onClick={() => openDoc(d.id)}>Ouvrir</button></td></tr>)}</tbody></table>
          )}
        </div>
      )}

      {edit && (
        <Modal title="Modifier la référence" onClose={() => setEdit(null)} footer={<><ConfirmButton label="Supprimer la référence" onConfirm={remove} /><span style={{ flex: 1 }} /><button className="btn" onClick={() => setEdit(null)}>Annuler</button><button className="btn primary" onClick={() => { if (edit.name.trim()) { update((d) => applyPriceEdit({ ...d, products: d.products.map((x) => (x.id === edit.id ? edit : x)) }, edit, priceEdit?.now ?? { unitPrice: 0, currency: 'USD', sellHt: 0 }, priceEdit?.before ?? { unitPrice: 0, currency: 'USD', sellHt: 0 })); setEdit(null); toast('Référence enregistrée'); } }}>Enregistrer</button></>}>
          <ProductForm value={edit} onChange={setEdit} />
          {priceEdit && <><h3 className="mt">Prix</h3><div className="form c3"><PriceFields value={priceEdit.now} onChange={(v) => setPriceEdit({ ...priceEdit, now: v })} factoryName={edit.factoryId ? db.factories.find((f) => f.id === edit.factoryId)?.name : undefined} /></div></>}
        </Modal>
      )}

      {drawing && (
        <Modal title="Version de plan" onClose={() => setDrawing(null)} footer={<>{db.drawings.some((x) => x.id === drawing.id) && <ConfirmButton label="Supprimer" onConfirm={() => { update((d) => ({ ...d, drawings: d.drawings.filter((x) => x.id !== drawing.id) })); setDrawing(null); }} />}<span style={{ flex: 1 }} /><button className="btn" onClick={() => setDrawing(null)}>Annuler</button><button className="btn primary" onClick={saveDrawing}>Enregistrer</button></>}>
          <div className="form c3">
            <Field label="Version"><Input value={drawing.version} onChange={(v) => setDrawing({ ...drawing, version: v })} /></Field>
            <Field label="Titre" span={2}><Input value={drawing.title} onChange={(v) => setDrawing({ ...drawing, title: v })} placeholder="Ex. : Fixation I — alu 42 mm" /></Field>
            <Field label="Statut"><Select value={drawing.status} onChange={(v) => setDrawing({ ...drawing, status: v })} options={DRAWING_STATUS.map((s) => ({ value: s.value, label: s.label }))} /></Field>
            <Field label="Fichier du plan" span={2}><Select value={drawing.documentId ?? ''} onChange={(v) => setDrawing({ ...drawing, documentId: v || null })} options={[{ value: '', label: '— Aucun (importe-le dans Documents) —' }, ...db.documents.map((d) => ({ value: d.id, label: `${d.fileName}${d.kind === 'plan_technique' ? ' · plan' : ''}` }))]} /></Field>
            <Field label="Ce qui change dans cette version" span={3}><Textarea value={drawing.changelog} onChange={(v) => setDrawing({ ...drawing, changelog: v })} placeholder="Ex. : passage en aluminium 6082-T6 ép. 3 mm" /></Field>
          </div>
        </Modal>
      )}

      {quote && (
        <Modal title="Prix proposé" onClose={() => setQuote(null)} footer={<>{db.quotes.some((x) => x.id === quote.id) && <ConfirmButton label="Supprimer" onConfirm={() => { update((d) => ({ ...d, quotes: d.quotes.filter((x) => x.id !== quote.id) })); setQuote(null); }} />}<span style={{ flex: 1 }} /><button className="btn" onClick={() => setQuote(null)}>Annuler</button><button className="btn primary" onClick={saveQuote}>Enregistrer</button></>}>
          <div className="form c3">
            <Field label="Usine" span={2}><Select value={quote.factoryId} onChange={(v) => setQuote({ ...quote, factoryId: v })} options={[{ value: '', label: '— Choisir —' }, ...db.factories.map((f) => ({ value: f.id, label: f.name }))]} /></Field>
            <Field label="Date"><Input type="date" value={quote.date} onChange={(v) => setQuote({ ...quote, date: v })} /></Field>
            <Field label="Prix unitaire"><NumberInput value={quote.unitPrice} onChange={(v) => setQuote({ ...quote, unitPrice: v })} /></Field>
            <Field label="Devise"><Select value={quote.currency} onChange={(v) => setQuote({ ...quote, currency: v })} options={(['USD', 'EUR', 'CNY', 'GBP'] as const).map((c) => ({ value: c, label: c }))} /></Field>
            <Field label="Incoterm"><Select value={quote.incoterm} onChange={(v) => setQuote({ ...quote, incoterm: v })} options={(['EXW', 'FOB', 'CIF', 'DDP'] as const).map((c) => ({ value: c, label: c }))} /></Field>
            <Field label="MOQ"><NumberInput value={quote.moq} onChange={(v) => setQuote({ ...quote, moq: v })} unit="pcs" /></Field>
            <Field label="Délai de production"><NumberInput value={quote.leadTimeDays} onChange={(v) => setQuote({ ...quote, leadTimeDays: v })} unit="jours" /></Field>
            <Field label="Note"><Input value={quote.notes} onChange={(v) => setQuote({ ...quote, notes: v })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CompositionTable({ cost, product, simu, onSimu, onChange }: { cost: UnitCostResult | null; product: Product; simu: Record<string, string>; onSimu: (s: Record<string, string>) => void; onChange: (c: ProductComponent[]) => void }) {
  const { db } = useStore();
  const { go } = useNav();
  const subCost = (pid: string) => unitCost(pid, db)?.costEur ?? null;
  const base = product.components.filter((c) => c.role !== 'option');
  const groups = new Map<string, ProductComponent[]>();
  for (const c of product.components.filter((c) => c.role === 'option')) groups.set(c.optionGroup || 'Options', [...(groups.get(c.optionGroup || 'Options') ?? []), c]);
  const setComp = (target: ProductComponent, patch: Partial<ProductComponent>) => onChange(product.components.map((c) => (c === target ? { ...c, ...patch } : c)));
  const setDefault = (target: ProductComponent) => onChange(product.components.map((c) => (c.role === 'option' && c.optionGroup === target.optionGroup ? { ...c, isDefault: c === target } : c)));
  const remove = (target: ProductComponent) => onChange(product.components.filter((c) => c !== target));
  const simuCost = Object.keys(simu).length ? unitCost(product.id, db, new Set(), simu) : null;
  const effective = new Set(effectiveComponents(product, simu).map((c) => c.productId));

  const Row = ({ c }: { c: ProductComponent }) => {
    const sub = db.products.find((p) => p.id === c.productId);
    const uc = subCost(c.productId);
    const counted = effective.has(c.productId);
    return (
      <tr style={{ opacity: (c.role === 'option' && !counted) || (product.componentsIncludedInPrice && cost?.purchaseEur) ? 0.6 : 1 }}>
        <td className="strong" style={{ cursor: 'pointer' }} onClick={() => go('merchandise', c.productId)}>
          {c.role === 'option' && <input type="radio" name={`simu-${c.optionGroup}`} checked={counted} onChange={() => onSimu({ ...simu, [c.optionGroup || 'Options']: c.productId })} title="Simuler avec cette variante" onClick={(e) => e.stopPropagation()} style={{ marginRight: 6 }} />}
          {sub?.name ?? '?'}{sub && sub.components.length > 0 && <span className="muted small"> · {sub.components.length} sous-réf.</span>}
          {c.role === 'option' && c.isDefault && <Badge tone="blue">par défaut</Badge>}
        </td>
        <td className="small">{db.factories.find((f) => f.id === sub?.factoryId)?.name ?? '—'}</td>
        <td className="num"><input type="number" step="any" value={c.qty} onChange={(e) => setComp(c, { qty: Number(e.target.value) })} style={{ width: 80, textAlign: 'right', border: '1px solid var(--line)', borderRadius: 6, padding: 4 }} /></td>
        <td className="num">{uc != null ? formatEur(uc) : <span style={{ color: 'var(--warn)' }}>prix inconnu</span>}</td>
        <td className="num">{uc != null ? formatEur(uc * c.qty) : '—'}</td>
        <td className="right" style={{ whiteSpace: 'nowrap' }}>
          {c.role === 'option' ? <>{!c.isDefault && <button className="btn ghost small" title="Utiliser comme variante par défaut" onClick={() => setDefault(c)}>défaut</button>}<button className="btn ghost small" title="Rendre de base" onClick={() => setComp(c, { role: 'base', optionGroup: '', isDefault: false })}>→ base</button></>
            : <button className="btn ghost small" title="Passer en option" onClick={() => setComp(c, { role: 'option', optionGroup: 'Options', isDefault: true })}>→ option</button>}
          <button className="btn ghost small" onClick={() => remove(c)}>✕</button>
        </td>
      </tr>
    );
  };

  return (
    <>
      <table className="tbl">
        <thead><tr><th>Sous-référence</th><th>Usine</th><th className="num">Quantité / unité</th><th className="num">Coût unitaire</th><th className="num">Total</th><th></th></tr></thead>
        <tbody>
          {base.length > 0 && <tr><td colSpan={6} className="muted small" style={{ background: '#fafbfc' }}>Composants de base</td></tr>}
          {base.map((c, i) => <Row key={`b${i}`} c={c} />)}
          {[...groups.entries()].map(([g, opts]) => (
            <React.Fragment key={g}>
              <tr><td colSpan={6} className="small" style={{ background: '#fafbfc' }}>
                <span className="row-flex"><b>Option ·</b> <input defaultValue={g} key={g} onBlur={(e) => { const name = e.target.value.trim(); if (name && name !== g) onChange(product.components.map((c) => (c.role === 'option' && (c.optionGroup || 'Options') === g ? { ...c, optionGroup: name } : c))); }} style={{ border: '1px solid transparent', borderRadius: 6, padding: '2px 6px', fontWeight: 600, background: 'transparent' }} title="Cliquer pour renommer le groupe" onFocus={(e) => (e.target.style.borderColor = 'var(--line)')} />
                <span className="muted">— une variante au choix ; le bouton rond simule, « défaut » fixe le coût standard</span></span></td></tr>
              {opts.map((c, i) => <Row key={`${g}${i}`} c={c} />)}
            </React.Fragment>
          ))}
          {cost && cost.purchaseEur > 0 && <tr><td colSpan={4} className={product.componentsIncludedInPrice ? 'muted' : ''}>Prix usine de la référence (logistique et douane comprises){product.componentsIncludedInPrice && <span className="muted small"> — sous-références incluses dans ce prix, non additionnées</span>}</td><td className="num">{formatEur(cost.purchaseEur)}</td><td /></tr>}
          {product.extraCosts.map((x) => <tr key={x.id}><td colSpan={4} className="muted">＋ {x.label || 'Coût additionnel'}{x.note && <span className="small"> — {x.note}</span>}</td><td className="num">{formatEur(extraCostEur(x, db.settings))}</td><td /></tr>)}
          <tr className="total"><td colSpan={4}>Coût de revient standard (options par défaut)</td><td className="num">{cost ? formatEur(cost.costEur) : '—'}</td><td /></tr>
          {simuCost && simuCost.costEur !== cost?.costEur && <tr className="total"><td colSpan={4} style={{ color: 'var(--accent)' }}>Avec les variantes cochées</td><td className="num" style={{ color: 'var(--accent)' }}>{formatEur(simuCost.costEur)}</td><td><button className="btn ghost small" onClick={() => onSimu({})}>réinit.</button></td></tr>}
        </tbody>
      </table>
      {groups.size > 0 && (
        <div className="mt">
          <h3>Coût selon les variantes</h3>
          <div className="pill-row">
            {[...groups.entries()].flatMap(([g, opts]) => opts.map((o) => { const r = unitCost(product.id, db, new Set(), { [g]: o.productId }); const sub = db.products.find((p) => p.id === o.productId); return <span key={o.productId} className="badge" style={{ padding: '6px 10px' }}>{g} : {sub?.name ?? '?'} → <b>{r ? formatEur(r.costEur) : '—'}</b></span>; }))}
          </div>
        </div>
      )}
    </>
  );
}

/** Vrai si `candidateId` contient (directement ou non) `productId` — pour éviter les boucles. */
function isAncestor(candidateId: string, productId: string, products: Product[], seen = new Set<string>()): boolean {
  if (candidateId === productId) return true;
  if (seen.has(candidateId)) return false;
  seen.add(candidateId);
  const c = products.find((p) => p.id === candidateId);
  return !!c && c.components.some((x) => isAncestor(x.productId, productId, products, seen));
}

