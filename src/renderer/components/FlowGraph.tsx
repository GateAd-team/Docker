/**
 * Arborescence des flux d'une importation : usine A → usine B → usine C → France.
 * Les cartes sont placées automatiquement en colonnes (étapes) puis déplaçables à la souris ;
 * les flèches sont dessinées en SVG au-dessus des cartes et contournent celles qu'elles croiseraient.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useNav } from '../App';
import { Badge, Stars, fmtDate } from './ui';
import { SHIPMENT_STATUS } from '../labels';
import type { Project, ProjectFlow } from '../../shared/types';
import type { Need } from '../../shared/importFlows';

export const FLOW_STATUS: { value: ProjectFlow['status']; label: string; color: string; tone: '' | 'amber' | 'green' }[] = [
  { value: 'prevu', label: 'Prévu', color: '#a0a8b5', tone: '' },
  { value: 'envoye', label: 'Envoyé', color: '#e0a100', tone: 'amber' },
  { value: 'recu', label: 'Reçu', color: '#1f9d55', tone: 'green' },
];

export const FR = 'FR';
const NODE_W = 240;
const COL_GAP = 220;
const ROW_GAP = 40;

/** Ordonne les nœuds en niveaux : sources à gauche, France tout à droite. */
export function flowLevels(project: Project, factoryIds: string[]): Map<string, number> {
  const nodes = new Set<string>(factoryIds);
  for (const f of project.flows) { nodes.add(f.fromFactoryId); if (f.to !== FR) nodes.add(f.to); }
  const level = new Map<string, number>();
  const memo = new Map<string, number>();
  const depth = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0; // boucle : on coupe
    stack.add(id);
    const incoming = project.flows.filter((f) => f.to === id && f.fromFactoryId !== id);
    const d = incoming.length ? Math.max(...incoming.map((f) => depth(f.fromFactoryId, stack) + 1)) : 0;
    stack.delete(id); memo.set(id, d); return d;
  };
  for (const id of nodes) level.set(id, depth(id, new Set()));
  const max = Math.max(0, ...level.values());
  level.set(FR, max + 1);
  return level;
}

type Rect = { x: number; y: number; w: number; h: number };
type Pos = { x: number; y: number };

const bezier = (p0: Pos, p1: Pos, p2: Pos, p3: Pos, t: number): Pos => {
  const u = 1 - t;
  return { x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y };
};
const segmentHitsRect = (a: Pos, b: Pos, r: Rect, pad = 6): boolean => {
  // Échantillonnage simple du segment : suffisant pour décider de contourner une carte.
  for (let i = 1; i < 20; i++) {
    const t = i / 20; const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    if (x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad) return true;
  }
  return false;
};

export function FlowGraph({ project, needs, onEditFlow, onAddFlow, onLayout, onLinkDocs }: { project: Project; needs: Need[]; onEditFlow: (f: ProjectFlow) => void; onAddFlow: (fromFactoryId?: string) => void; onLayout: (layout: Project['layout']) => void; onLinkDocs: (factoryId: string) => void }) {
  const { db } = useStore();
  const { go } = useNav();
  const wrap = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; pos: Pos } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Usines de l'arborescence : celles qui fabriquent une pièce de la liste de courses, plus l'usine de groupage.
  const factoryIds = [...new Set([...needs.map((n) => n.factoryId).filter((x): x is string => !!x), ...(project.consolidatorFactoryId ? [project.consolidatorFactoryId] : [])])].filter((id) => db.factories.some((f) => f.id === id));
  // --- Placement automatique (colonnes) puis positions manuelles.
  const levels = flowLevels(project, factoryIds);
  const maxLevel = Math.max(...levels.values());
  const columns: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const [id, lv] of levels) columns[lv].push(id);
  for (const col of columns) col.sort((a, b) => (a === FR ? 1 : b === FR ? -1 : (db.factories.find((f) => f.id === a)?.name ?? '').localeCompare(db.factories.find((f) => f.id === b)?.name ?? '')));
  const auto: Record<string, Pos> = {};
  columns.forEach((col, ci) => { let y = 28; for (const id of col) { auto[id] = { x: ci * (NODE_W + COL_GAP), y }; y += (heights[id] ?? 150) + ROW_GAP; } });
  const posOf = (id: string): Pos => (drag && drag.id === id ? drag.pos : project.layout[id] ?? auto[id] ?? { x: 0, y: 28 });
  const ids = [...levels.keys()];
  const rects: Record<string, Rect> = {};
  for (const id of ids) { const p = posOf(id); rects[id] = { x: p.x, y: p.y, w: NODE_W, h: heights[id] ?? 150 }; }
  const canvasW = Math.max(...ids.map((id) => rects[id].x + rects[id].w), 600) + 24;
  const canvasH = Math.max(...ids.map((id) => rects[id].y + rects[id].h), 200) + 24;

  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    let changed = false;
    for (const [id, el] of refs.current) { const h = el.offsetHeight; next[id] = h; if (heights[id] !== h) changed = true; }
    if (changed || Object.keys(next).length !== Object.keys(heights).length) setHeights(next);
  });

  // --- Glisser-déposer des cartes (souris, comme ailleurs dans Docker).
  const startDrag = (id: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = posOf(id);
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    let cur = p;
    const onMove = (ev: MouseEvent) => {
      const nx = Math.max(0, p.x + ev.clientX - start.x), ny = Math.max(0, p.y + ev.clientY - start.y);
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      moved = true; setDragging(true);
      cur = { x: Math.round(nx), y: Math.round(ny) };
      setDrag({ id, dx: 0, dy: 0, pos: cur });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      setDrag(null); setTimeout(() => setDragging(false), 0);
      if (moved) onLayout({ ...project.layout, [id]: cur });
    };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    e.preventDefault();
  };

  // --- Flèches : départ sur le bord droit, arrivée sur le bord gauche, contournement des cartes croisées.
  const countOut: Record<string, number> = {}, countIn: Record<string, number> = {};
  for (const f of project.flows) { countOut[f.fromFactoryId] = (countOut[f.fromFactoryId] ?? 0) + 1; countIn[f.to] = (countIn[f.to] ?? 0) + 1; }
  const seenOut: Record<string, number> = {}, seenIn: Record<string, number> = {};
  const paths = project.flows.flatMap((flow) => {
    const a = rects[flow.fromFactoryId], b = rects[flow.to];
    if (!a || !b) return [];
    const oi = (seenOut[flow.fromFactoryId] = (seenOut[flow.fromFactoryId] ?? 0) + 1);
    const ii = (seenIn[flow.to] = (seenIn[flow.to] ?? 0) + 1);
    const backwards = b.x + b.w / 2 < a.x + a.w / 2;
    const overlapX = a.x < b.x + b.w - 40 && b.x < a.x + a.w - 40; // cartes l'une au-dessus de l'autre → flèche verticale
    const below = b.y > a.y;
    const fracOut = oi / ((countOut[flow.fromFactoryId] ?? 1) + 1), fracIn = ii / ((countIn[flow.to] ?? 1) + 1);
    const p0: Pos = overlapX ? { x: a.x + a.w * fracOut, y: below ? a.y + a.h : a.y } : { x: backwards ? a.x : a.x + a.w, y: a.y + a.h * fracOut };
    const p3: Pos = overlapX ? { x: b.x + b.w * fracIn, y: below ? b.y : b.y + b.h } : { x: backwards ? b.x + b.w : b.x, y: b.y + b.h * fracIn };
    // Une carte sur le chemin ? On fait passer la flèche à côté.
    let bow = 0;
    for (const id of ids) {
      if (id === flow.fromFactoryId || id === flow.to) continue;
      const r = rects[id];
      if (segmentHitsRect(p0, p3, r)) {
        if (overlapX) {
          const mid = (p0.x + p3.x) / 2;
          const left = r.x - 30 - mid, right = r.x + r.w + 30 - mid;
          const candidate = Math.abs(left) < Math.abs(right) ? left : right;
          if (Math.abs(candidate) > Math.abs(bow)) bow = candidate;
        } else {
          const mid = (p0.y + p3.y) / 2;
          const up = r.y - 30 - mid, down = r.y + r.h + 30 - mid;
          const candidate = Math.abs(up) < Math.abs(down) ? up : down;
          if (Math.abs(candidate) > Math.abs(bow)) bow = candidate;
        }
      }
    }
    let p1: Pos, p2: Pos;
    if (overlapX) {
      const dy = Math.max(50, Math.abs(p3.y - p0.y) / 2) * (below ? 1 : -1);
      p1 = { x: p0.x + bow * 1.6, y: p0.y + dy }; p2 = { x: p3.x + bow * 1.6, y: p3.y - dy };
    } else {
      const dx = Math.max(60, Math.abs(p3.x - p0.x) / 2) * (backwards ? -1 : 1);
      p1 = { x: p0.x + dx, y: p0.y + bow * 1.6 }; p2 = { x: p3.x - dx, y: p3.y + bow * 1.6 };
    }
    const d = `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
    const mid = bezier(p0, p1, p2, p3, 0.5);
    return [{ flow, d, mx: mid.x, my: mid.y }];
  });

  const productName = (id: string) => db.products.find((p) => p.id === id)?.name ?? '?';
  const flowLabel = (f: ProjectFlow) => f.lines.length ? f.lines.map((l) => `${l.qty} × ${productName(l.productId)}`).join(', ') : f.note || 'Flux';

  return (
    <div className="flow-wrap" ref={wrap}>
      <div className="flow-canvas" style={{ width: canvasW, height: canvasH }}>
        {columns.map((col, ci) => col.length > 0 && !col.every((id) => project.layout[id]) && (
          <div key={ci} className="flow-col-title" style={{ left: ci * (NODE_W + COL_GAP), top: 0 }}>{ci === maxLevel ? 'Destination' : ci === 0 ? 'Étape 1 · fabrication' : `Étape ${ci + 1}`}</div>
        ))}
        {ids.map((id) => {
          const r = rects[id];
          const style: React.CSSProperties = { left: r.x, top: r.y, width: NODE_W };
          const setRef = (el: HTMLDivElement | null) => { if (el) refs.current.set(id, el); else refs.current.delete(id); };
          if (id === FR) {
            return (
              <div key={id} className={`flow-node dest${drag?.id === id ? ' dragging' : ''}`} style={style} ref={setRef} onMouseDown={(e) => startDrag(id, e)}>
                <div className="flow-node-name">🇫🇷 France</div>
                <div className="small muted">{[project.container && `Conteneur ${project.container}`, project.targetDate && `départ ${fmtDate(project.targetDate)}`].filter(Boolean).join(' · ') || 'Conteneur'}</div>
                {(() => { const ships = db.shipments.filter((s) => s.projectId === project.id); if (!ships.length) return null; return ships.map((s) => <div key={s.id} className="small" style={{ marginTop: 2 }}>⛴ <b>{s.reference || 'Expédition'}</b> <span className="muted">· {SHIPMENT_STATUS.find((x) => x.value === s.status)?.label ?? s.status}{s.etd ? ` · ETD ${fmtDate(s.etd)}` : ''}{s.eta ? ` · ETA ${fmtDate(s.eta)}` : ''}{db.partners.find((p) => p.id === s.partnerId)?.name ? ` · ${db.partners.find((p) => p.id === s.partnerId)!.name}` : ''}</span></div>); })()}
                {(() => { const arriving = project.contents.length ? project.contents : project.flows.filter((f) => f.to === FR).flatMap((f) => f.lines); if (!arriving.length) return null; const m = new Map<string, number>(); for (const l of arriving) m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty); return <div className="flow-list">{[...m.entries()].map(([pid, q]) => <div key={pid} className="flow-list-row"><span className="n">{productName(pid)}</span><span className="q">{q}</span></div>)}</div>; })()}
                <DocsButton project={project} factoryId={FR} onClick={() => onLinkDocs(FR)} />
              </div>
            );
          }
          const f = db.factories.find((x) => x.id === id);
          const made = new Map<string, number>();
          for (const n of needs) if (n.factoryId === id) made.set(n.productId, (made.get(n.productId) ?? 0) + n.qty);
          const received = new Map<string, { qty: number; from: string }>();
          for (const x of project.flows.filter((x) => x.to === id)) for (const l of x.lines) { const cur = received.get(l.productId); received.set(l.productId, { qty: (cur?.qty ?? 0) + l.qty, from: db.factories.find((y) => y.id === x.fromFactoryId)?.name?.split(' ')[0] ?? '?' }); }
          return (
            <div key={id} className={`flow-node${drag?.id === id ? ' dragging' : ''}`} style={style} ref={setRef} onMouseDown={(e) => startDrag(id, e)}>
              <div className="flow-node-head">
                <div className="flow-node-name" onClick={() => { if (!dragging) go('factories', id); }}>{f?.name ?? 'Usine inconnue'}</div>
                {f && <Stars value={f.rating} size={11} />}
              </div>
              {made.size === 0 && received.size === 0 ? <div className="small muted">{id === project.consolidatorFactoryId ? 'Groupage : charge le conteneur.' : 'Rien à fabriquer pour cette liste.'}</div> : (
                <div className="flow-list">
                  {[...made.entries()].map(([pid, q]) => <div key={`m${pid}`} className="flow-list-row" title="À fabriquer ici pour cette liste"><span className="n">⚙ {productName(pid)}</span><span className="q">{q}</span></div>)}
                  {[...received.entries()].map(([pid, r]) => <div key={`r${pid}`} className="flow-list-row recv" title={`Reçu de ${r.from}`}><span className="n">↳ {productName(pid)} <span className="muted">({r.from})</span></span><span className="q">{r.qty}</span></div>)}
                </div>
              )}
              <div className="row-flex" style={{ gap: 4 }}>
                <button className="btn ghost small flow-node-add" onMouseDown={(e) => e.stopPropagation()} onClick={() => onAddFlow(id)}>→ Envoie à…</button>
                <DocsButton project={project} factoryId={id} onClick={() => onLinkDocs(id)} />
              </div>
            </div>
          );
        })}
        <svg className="flow-svg" width={canvasW} height={canvasH}>
          <defs>
            {FLOW_STATUS.map((s) => <marker key={s.value} id={`arrow-${s.value}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={s.color} /></marker>)}
          </defs>
          {paths.map(({ flow, d }) => { const st = FLOW_STATUS.find((s) => s.value === flow.status)!; return (
            <g key={flow.id} className="flow-edge" onClick={() => onEditFlow(flow)}>
              <title>{`${flowLabel(flow)} — ${st.label}${flow.date ? ` · ${fmtDate(flow.date)}` : ''}${flow.note ? ` — ${flow.note}` : ''}\nClique pour modifier`}</title>
              <path d={d} fill="none" stroke="#fff" strokeWidth={10} opacity={0.9} />
              <path d={d} fill="none" stroke={st.color} strokeWidth={2.5} strokeDasharray={flow.status === 'prevu' ? '6 5' : undefined} markerEnd={`url(#arrow-${flow.status})`} />
            </g>
          ); })}
        </svg>
      </div>
      {project.flows.length === 0 && <div className="small muted mt">Aucun flux pour l'instant : remplis la liste de courses et génère l'arborescence, ou clique « → Envoie vers… » sur une usine pour un flux manuel.</div>}
      {project.flows.length > 0 && (
        <table className="tbl small flow-table">
          <thead><tr><th>De</th><th></th><th>Vers</th><th>Marchandise</th><th>Statut</th><th>Date</th></tr></thead>
          <tbody>{project.flows.map((f) => { const st = FLOW_STATUS.find((s) => s.value === f.status)!; return (
            <tr key={f.id} className="click" onClick={() => onEditFlow(f)}>
              <td className="strong">{db.factories.find((x) => x.id === f.fromFactoryId)?.name ?? '?'}</td>
              <td className="muted">→</td>
              <td className="strong">{f.to === FR ? '🇫🇷 France' : db.factories.find((x) => x.id === f.to)?.name ?? '?'}</td>
              <td className="muted">{flowLabel(f)}</td>
              <td><span style={{ color: st.color }}>●</span> {st.label}</td>
              <td className="muted">{f.date ? fmtDate(f.date) : '—'}</td>
            </tr>
          ); })}</tbody>
        </table>
      )}
      <div className="flow-legend small muted">
        {FLOW_STATUS.map((s) => <span key={s.value}><span style={{ color: s.color }}>{s.value === 'prevu' ? '- - -' : '———'}</span> {s.label}</span>)}
        <span>⚙ à fabriquer ici · ↳ reçu d'une autre usine · glisse les cartes pour les ranger · survole ou clique une flèche pour voir / modifier ce qui transite.</span>
        {Object.keys(project.layout).length > 0 && <button className="btn ghost small" onClick={() => onLayout({})}>Replacer automatiquement</button>}
      </div>
    </div>
  );
}

export function flowStatusBadge(status: ProjectFlow['status']) {
  const st = FLOW_STATUS.find((s) => s.value === status)!;
  return <Badge tone={st.tone}>{st.label}</Badge>;
}

/** Bouton « 📎 » d'une carte : nombre de documents rattachés, ouvre la fenêtre de liaison. */
function DocsButton({ project, factoryId, onClick }: { project: Project; factoryId: string; onClick: () => void }) {
  const n = project.docLinks.filter((l) => l.factoryId === factoryId).length;
  return <button className={`btn ghost small flow-node-add${n ? ' has-docs' : ''}`} title={n ? `${n} document${n > 1 ? 's' : ''} rattaché${n > 1 ? 's' : ''} — clique pour voir / lier` : 'Lier un ou plusieurs PDF / photos à cette carte'} onMouseDown={(e) => e.stopPropagation()} onClick={onClick}>📎{n ? ` ${n}` : ' PDF'}</button>;
}
