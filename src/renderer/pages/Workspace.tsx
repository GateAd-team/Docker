import React, { useState } from 'react';
import { api } from '../api';
import { useCloud } from '../cloud';
import { AuthShell, Avatar } from '../components/AuthShell';

/** Après la connexion, si le compte n'appartient à aucun espace : créer le sien ou rejoindre celui d'un collègue avec son code. */
export function WorkspacePage() {
  const { status, run, busy } = useCloud();
  const [choice, setChoice] = useState<'create' | 'join' | null>(() => { const c = new URLSearchParams(window.location.search).get('choice'); return c === 'create' || c === 'join' ? c : null; });
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const user = status?.user;
  const act = async (fn: () => Promise<unknown>, label: string) => {
    setError(null); setStep(label);
    const err = await run(fn as () => Promise<never>);
    setStep(null);
    if (err) setError(err);
  };
  const codeClean = code.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8);

  return (
    <AuthShell wide footer={<>Tu pourras plus tard rejoindre d'autres espaces ou en créer un autre depuis Réglages → Compte & espace partagé.</>}>
      {user && (
        <div className="auth-user">
          <Avatar name={user.name} email={user.email} />
          <div><b>{user.name || user.email}</b><div className="small muted">{user.email}</div></div>
          <button className="btn ghost small" disabled={busy} onClick={() => act(() => api.cloudSignOut(), 'Déconnexion…')}>Changer de compte</button>
        </div>
      )}
      <div className="auth-head">
        <h1>Ton espace de travail</h1>
        <p className="muted">Un espace = une société. Ses membres partagent importations, marchandises, usines et documents. Personne d'autre n'y a accès.</p>
      </div>

      <div className="choice-grid">
        <button type="button" className={`choice${choice === 'create' ? ' on' : ''}`} onClick={() => { setChoice('create'); setError(null); }}>
          <span className="choice-ico">＋</span>
          <b>Créer mon espace</b>
          <span className="small muted">Tu en es le propriétaire et tu invites ton équipe avec un code.</span>
        </button>
        <button type="button" className={`choice${choice === 'join' ? ' on' : ''}`} onClick={() => { setChoice('join'); setError(null); }}>
          <span className="choice-ico">⇥</span>
          <b>Rejoindre un espace</b>
          <span className="small muted">Un collègue t'a donné un code d'invitation à 8 caractères.</span>
        </button>
      </div>

      {choice === 'create' && (
        <form className="auth-form choice-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) act(() => api.cloudCreateOrg(name), 'Création de l\'espace…'); }}>
          <label className="auth-field">
            <span>Nom de l'espace</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Le nom de ta société, ex. Wall Up" />
          </label>
          <div className="small muted">Les données déjà présentes sur cet ordinateur deviennent le contenu de l'espace.</div>
          {error && <div className="auth-alert bad" role="alert">{error}</div>}
          <button type="submit" className="btn primary auth-submit" disabled={busy || !name.trim()}>{step ? <><span className="spinner light" /> {step}</> : 'Créer l\'espace'}</button>
        </form>
      )}
      {choice === 'join' && (
        <form className="auth-form choice-form" onSubmit={(e) => { e.preventDefault(); if (codeClean.length === 8) act(() => api.cloudJoinOrg(codeClean), 'Récupération des données…'); }}>
          <label className="auth-field">
            <span>Code d'invitation</span>
            <input autoFocus className="code-input" value={codeClean} onChange={(e) => setCode(e.target.value)} placeholder="A1B2C3D4" spellCheck={false} autoComplete="off" />
            <em className="auth-hint">{codeClean.length}/8 · le propriétaire le trouve dans Réglages → Compte & espace partagé.</em>
          </label>
          {error && <div className="auth-alert bad" role="alert">{error}</div>}
          <button type="submit" className="btn primary auth-submit" disabled={busy || codeClean.length !== 8}>{step ? <><span className="spinner light" /> {step}</> : 'Rejoindre'}</button>
        </form>
      )}
    </AuthShell>
  );
}
