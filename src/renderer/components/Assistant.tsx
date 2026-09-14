import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { useNav, type Page } from '../App';
import type { Database } from '../../shared/types';
import type { ChatMessage, ToolTrace } from '../../shared/assistant';

interface Turn extends ChatMessage { traces?: ToolTrace[]; error?: boolean }

const SUGGESTIONS = [
  'Fais-moi le point : où en est chaque importation, ce qui presse cette semaine',
  'Où en est le conteneur en transit ? Résume les derniers emails du transporteur',
  'Analyse financière de mon importation en cours : bénéfice avec et sans transport',
  'Qu\'est-ce qu\'il me reste à commander chez chaque usine pour ce conteneur ?',
  'Quelles marchandises n\'ont pas encore de prix de vente ?',
  'Quel est le coût de revient du Wall 1 m avec la housse ?',
];

export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { db, replace, toast } = useStore();
  const { nav, go } = useNav();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<Database | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns, busy]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const selectionLabel = (() => {
    if (!nav.id) return undefined;
    if (nav.page === 'merchandise' || nav.page === 'finance') return db.products.find((p) => p.id === nav.id)?.name;
    if (nav.page === 'factories') return db.factories.find((f) => f.id === nav.id)?.name;
    if (nav.page === 'logistics') return db.shipments.find((s) => s.id === nav.id)?.reference;
    return undefined;
  })();

  const send = async (text: string) => {
    const msg = text.trim();
    if (!msg || busy) return;
    const history: Turn[] = [...turns, { role: 'user', content: msg }];
    setTurns(history); setInput(''); setBusy(true);
    const snapshot = db;
    try {
      const r = await api.chat(history.map(({ role, content }) => ({ role, content })), { page: nav.page, id: nav.id, selectionLabel });
      if (r.traces.some((t) => ['creer', 'modifier', 'supprimer', 'dupliquer', 'nouvelle_version'].includes(t.tool))) {
        // La base a été modifiée côté principal : on la recharge et on garde l'état d'avant pour « Annuler ».
        const fresh = await api.loadDb();
        replace(fresh);
        setUndo(snapshot);
      }
      setTurns([...history, { role: 'assistant', content: r.text, traces: r.traces }]);
      if (r.navigate) go(r.navigate.page as Page, r.navigate.id);
    } catch (e) {
      setTurns([...history, { role: 'assistant', content: (e as Error).message, error: true }]);
    } finally { setBusy(false); }
  };

  const undoLast = () => {
    if (!undo) return;
    replace(undo); setUndo(null); toast("Modifications de l'assistant annulées");
    setTurns((t) => [...t, { role: 'assistant', content: '↩ J\'ai remis les fiches dans l\'état précédent.' }]);
  };

  if (!open) return null;
  return (
    <aside className="assistant">
      <div className="assistant-head">
        <div><b>Assistant</b><div className="small muted">{selectionLabel ? `Fiche ouverte : ${selectionLabel}` : 'Il voit ce que tu regardes et agit dans tes fiches.'}</div></div>
        <div className="row-flex">
          {undo && <button className="btn small" onClick={undoLast} title="Annule les dernières modifications faites par l'assistant">↩ Annuler</button>}
          {turns.length > 0 && <button className="btn ghost small" onClick={() => { setTurns([]); setUndo(null); }}>Nouvelle discussion</button>}
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="assistant-body">
        {turns.length === 0 && (
          <div className="assistant-empty">
            <div className="muted small mb">Demande-lui en français, par exemple :</div>
            {SUGGESTIONS.map((s) => <button key={s} className="suggestion" onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`bubble from-${t.role}${t.error ? ' bad' : ''}`}>
            {t.traces && t.traces.length > 0 && (
              <div className="traces">{t.traces.map((tr, j) => <span key={j} className={`trace ${tr.tool}`}>{iconFor(tr.tool)} {tr.summary}</span>)}</div>
            )}
            <div style={{ whiteSpace: 'pre-wrap' }}>{t.content}</div>
          </div>
        ))}
        {busy && <div className="bubble from-assistant"><span className="spinner" /> <span className="muted small">L'assistant travaille…</span></div>}
        <div ref={bottom} />
      </div>
      <div className="assistant-input">
        <textarea ref={inputRef} value={input} placeholder="Écris ta demande… (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne)" rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }} />
        <button className="btn primary" disabled={busy || !input.trim()} onClick={() => send(input)}>Envoyer</button>
      </div>
    </aside>
  );
}

function iconFor(tool: string): string {
  return ({ rechercher: '🔍', lister: '📋', lire: '📄', creer: '➕', modifier: '✎', supprimer: '🗑', dupliquer: '⧉', nouvelle_version: '🔁', cout: '€', naviguer: '→' } as Record<string, string>)[tool] ?? '•';
}
