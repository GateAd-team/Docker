import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useCloud } from '../cloud';
import { AuthShell } from '../components/AuthShell';

/** Écran de connexion : obligatoire avant d'accéder aux données. */
export function LoginPage() {
  const { status, run, busy } = useCloud();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { if (status) first.current?.focus(); }, [status, mode]);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
  const canSubmit = !busy && emailOk && form.password.length >= 6 && (mode === 'login' || form.name.trim().length > 0);
  const switchMode = (m: 'login' | 'signup') => { setMode(m); setError(null); setInfo(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null); setInfo(null);
    const err = await run(() => (mode === 'signup' ? api.cloudSignUp(form.email.trim(), form.password, form.name.trim()) : api.cloudSignIn(form.email.trim(), form.password)));
    if (err && /confirme ton adresse/i.test(err)) { setInfo(err); setMode('login'); } else if (err) setError(err);
  };

  if (status === null) {
    return (
      <AuthShell>
        <div className="auth-loading"><span className="spinner" /><div>Connexion au serveur…</div><div className="small muted">Vérification de ta session sur ce poste.</div></div>
      </AuthShell>
    );
  }

  return (
    <AuthShell footer={<>Rien à configurer : le serveur est intégré à l'application. Chaque compte est personnel, les données appartiennent à l'espace de ta société.</>}>
      <div className="auth-head">
        <h1>{mode === 'login' ? 'Bon retour' : 'Créer ton compte'}</h1>
        <p className="muted">{mode === 'login' ? 'Connecte-toi pour retrouver ton espace de travail.' : 'Une minute suffit. Tu créeras ou rejoindras ensuite l\'espace de ta société.'}</p>
      </div>
      <div className="segment" role="tablist">
        <span className="segment-thumb" style={{ transform: mode === 'login' ? 'translateX(0)' : 'translateX(100%)' }} />
        <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => switchMode('login')}>Se connecter</button>
        <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => switchMode('signup')}>Créer un compte</button>
      </div>
      <form className="auth-form" onSubmit={submit} noValidate>
        {mode === 'signup' && (
          <label className="auth-field">
            <span>Ton prénom</span>
            <input ref={first} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Théo" autoComplete="given-name" />
          </label>
        )}
        <label className="auth-field">
          <span>Email</span>
          <input ref={mode === 'login' ? first : undefined} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="prenom@societe.fr" autoComplete="email" spellCheck={false} />
        </label>
        <label className="auth-field">
          <span>Mot de passe</span>
          <div className="auth-pw">
            <input type={showPw ? 'text' : 'password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={mode === 'signup' ? '6 caractères minimum' : '••••••••'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
            <button type="button" className="auth-eye" onClick={() => setShowPw((v) => !v)} title={showPw ? 'Masquer' : 'Afficher'}>{showPw ? 'Masquer' : 'Afficher'}</button>
          </div>
          {mode === 'signup' && form.password.length > 0 && form.password.length < 6 && <em className="auth-hint">Encore {6 - form.password.length} caractère{6 - form.password.length > 1 ? 's' : ''}.</em>}
        </label>
        {error && <div className="auth-alert bad" role="alert">{error}</div>}
        {info && <div className="auth-alert">{info}</div>}
        {status.error && !error && <div className="auth-alert bad">{status.error}</div>}
        <button type="submit" className="btn primary auth-submit" disabled={!canSubmit}>
          {busy ? <><span className="spinner light" /> {mode === 'signup' ? 'Création du compte…' : 'Connexion…'}</> : mode === 'signup' ? 'Créer mon compte' : 'Se connecter'}
        </button>
        <div className="auth-switch small muted">
          {mode === 'login' ? <>Pas encore de compte ? <a onClick={() => switchMode('signup')}>Créer un compte</a></> : <>Déjà un compte ? <a onClick={() => switchMode('login')}>Se connecter</a></>}
        </div>
      </form>
    </AuthShell>
  );
}
