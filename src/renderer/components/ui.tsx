import React, { useState } from 'react';

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const [max, setMax] = useState(false);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}${max ? ' max' : ''}`}>
        <div className="modal-head"><h2 style={{ margin: 0 }}>{title}</h2><div className="row-flex" style={{ gap: 4 }}><button className="btn ghost" title={max ? 'Taille normale' : 'Agrandir (tu peux aussi tirer le coin en bas à droite)'} onClick={() => setMax(!max)}>{max ? '⤡' : '⤢'}</button><button className="btn ghost" onClick={onClose}>✕</button></div></div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, span }: { label: string; children: React.ReactNode; span?: 2 | 3 | 4 }) {
  return <div className={`field${span ? ` span${span}` : ''}`}><label>{label}</label>{children}</div>;
}

export function Input({ value, onChange, type = 'text', placeholder, unit }: { value: string | number; onChange: (v: string) => void; type?: string; placeholder?: string; unit?: string }) {
  const el = <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} step={type === 'number' ? 'any' : undefined} />;
  return unit ? <div className="unit">{el}<span>{unit}</span></div> : el;
}

export function NumberInput({ value, onChange, unit, placeholder }: { value: number; onChange: (v: number) => void; unit?: string; placeholder?: string }) {
  return <Input type="number" value={Number.isFinite(value) ? value : 0} onChange={(v) => onChange(v === '' ? 0 : Number(v))} unit={unit} placeholder={placeholder} />;
}

export function Select<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Textarea({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <textarea value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function Badge({ children, tone = '' }: { children: React.ReactNode; tone?: '' | 'blue' | 'green' | 'amber' | 'red' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Empty({ icon, title, text, action }: { icon: string; title: string; text?: string; action?: React.ReactNode }) {
  return <div className="empty"><div className="big">{icon}</div><b>{title}</b>{text && <p>{text}</p>}{action}</div>;
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <div className="stat"><div className="label">{label}</div><div className="value">{value}</div>{hint && <div className="hint">{hint}</div>}</div>;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string }[] }) {
  return <div className="tabs">{tabs.map((t) => <button key={t.value} className={t.value === value ? 'active' : ''} onClick={() => onChange(t.value)}>{t.label}</button>)}</div>;
}

export function ConfirmButton({ label, onConfirm, className = 'btn danger small' }: { label: string; onConfirm: () => void; className?: string }) {
  const [arm, setArm] = useState(false);
  if (!arm) return <button className={className} onClick={() => setArm(true)}>{label}</button>;
  return <span className="row-flex"><button className="btn danger small" onClick={onConfirm}>Confirmer</button><button className="btn small" onClick={() => setArm(false)}>Annuler</button></span>;
}

export function Timeline({ steps, current }: { steps: { value: string; label: string }[]; current: string }) {
  const idx = steps.findIndex((s) => s.value === current);
  return (
    <div className="timeline">
      {steps.map((s, i) => <div key={s.value} className={`step ${i < idx ? 'done' : i === idx ? 'current' : ''}`}>{s.label}</div>)}
    </div>
  );
}

export function fmtDate(d: string): string {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-');
  return y && m && day ? `${day}/${m}/${y}` : d;
}

export function daysUntil(d: string): number | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86400000);
}

/** Note sur 5 étoiles, cliquable si onChange est fourni. */
export function Stars({ value, onChange, size = 16 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  const [hover, setHover] = React.useState(0);
  const shown = hover || value;
  return (
    <span className={`stars${onChange ? ' editable' : ''}`} style={{ fontSize: size }} title={value ? `${value}/5` : 'Pas encore notée'} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= shown ? 'on' : ''} onMouseEnter={() => onChange && setHover(i)} onClick={(e) => { if (!onChange) return; e.stopPropagation(); onChange(value === i ? 0 : i); }}>★</span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Tableaux : tri par clic sur l'en-tête + colonnes redimensionnables (largeurs mémorisées par tableau).
 * ---------------------------------------------------------------------------------------------- */

export type SortDir = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDir }

/** Tri mémorisé (localStorage) : `useSort('documents', { key: 'date', dir: 'desc' })`. */
export function useSort(tableId: string, initial: SortState) {
  const storageKey = `sort:${tableId}`;
  const [sort, setSortState] = useState<SortState>(() => { try { const v = localStorage.getItem(storageKey); return v ? (JSON.parse(v) as SortState) : initial; } catch { return initial; } });
  const setSort = (s: SortState) => { setSortState(s); try { localStorage.setItem(storageKey, JSON.stringify(s)); } catch { /* ignore */ } };
  const toggle = (key: string, defaultDir: SortDir = 'asc') => setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir });
  /** Trie une liste selon des accesseurs par colonne (chaîne, nombre ou date ISO). */
  const apply = <T,>(rows: T[], accessors: Record<string, (r: T) => string | number | null | undefined>): T[] => {
    const get = accessors[sort.key]; if (!get) return rows;
    const cmp = (a: T, b: T) => {
      const x = get(a), y = get(b);
      if (x == null || x === '') return y == null || y === '' ? 0 : 1;   // les vides à la fin, quel que soit le sens
      if (y == null || y === '') return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'fr', { numeric: true, sensitivity: 'base' });
      return sort.dir === 'asc' ? r : -r;
    };
    return [...rows].sort(cmp);
  };
  return { sort, setSort, toggle, apply };
}

/** Largeurs de colonnes mémorisées par tableau. */
export function useColumnWidths(tableId: string) {
  const storageKey = `cols:${tableId}`;
  const [widths, setWidths] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } });
  const setWidth = (key: string, w: number) => setWidths((cur) => { const next = { ...cur, [key]: Math.max(40, Math.round(w)) }; try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ } return next; });
  return { widths, setWidth };
}

/**
 * En-tête de colonne : clic = tri (si `sortKey`), poignée à droite = redimensionner (si `widths`).
 * `defaultDir` : sens au premier clic (les dates en décroissant, par exemple).
 */
export function Th({ label, sortKey, sort, onSort, defaultDir, colKey, widths, onResize, className, style, children }: {
  label?: React.ReactNode; sortKey?: string; sort?: SortState; onSort?: (key: string, defaultDir?: SortDir) => void; defaultDir?: SortDir;
  colKey?: string; widths?: Record<string, number>; onResize?: (key: string, w: number) => void; className?: string; style?: React.CSSProperties; children?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLTableCellElement>(null);
  const active = !!sortKey && sort?.key === sortKey;
  const w = colKey && widths?.[colKey];
  const startResize = (e: React.MouseEvent) => {
    if (!colKey || !onResize || !ref.current) return;
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = ref.current.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => onResize(colKey, startW + ev.clientX - startX);
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  return (
    <th ref={ref} className={`${className ?? ''}${sortKey ? ' sortable' : ''}${active ? ' sorted' : ''}`} style={{ ...(w ? { width: w, minWidth: w, maxWidth: w } : {}), ...style }}
      onClick={sortKey && onSort ? () => onSort(sortKey, defaultDir) : undefined} title={sortKey ? 'Cliquer pour trier' : undefined}>
      <span className="th-inner">{label ?? children}{sortKey && <span className="sort-ind">{active ? (sort?.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>}</span>
      {colKey && onResize && <span className="col-grip" onMouseDown={startResize} onClick={(e) => e.stopPropagation()} title="Glisser pour élargir la colonne" />}
    </th>
  );
}
