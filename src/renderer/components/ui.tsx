import React, { useState } from 'react';

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        <div className="modal-head"><h2 style={{ margin: 0 }}>{title}</h2><button className="btn ghost" onClick={onClose}>✕</button></div>
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
