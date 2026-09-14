import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { ConfirmButton, Field, Input, NumberInput } from '../components/ui';
import type { CloudStatus, Currency, Market, Settings } from '../../shared/types';
import { emptyDatabase } from '../../shared/types';
import { seedDatabase } from '../seed';
import { MARKET_LABELS } from '../labels';

export function SettingsPage() {
  const { db, update, replace, toast } = useStore();
  const [s, setS] = useState<Settings>(db.settings);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [mailTesting, setMailTesting] = useState(false);
  const [mailMsg, setMailMsg] = useState<string | null>(null);
  const testMail = async () => {
    setMailTesting(true); setMailMsg(null);
    const r = await api.mailTest(s.gmail);
    setMailMsg(`${r.ok ? '✅' : '⚠️'} ${r.message}`); setMailTesting(false);
    if (r.ok) update((d) => ({ ...d, settings: { ...d.settings, gmail: s.gmail } }));
  };
  const [connecting, setConnecting] = useState(false);
  const [labels, setLabels] = useState<string[] | null>(null);
  const loadLabels = async () => { try { update((d) => ({ ...d, settings: { ...d.settings, gmail: s.gmail } })); const l = await api.mailLabels(); setLabels(l); if (!l.length) toast('Aucun libellé trouvé dans cette boîte', true); } catch (e) { toast((e as Error).message, true); } };
  const historyField = (
    <Field label="Historique lu à chaque synchronisation (jours)">
      <NumberInput value={s.gmail.historyDays || 730} onChange={(v) => setS({ ...s, gmail: { ...s.gmail, historyDays: Math.max(1, Math.round(v || 730)) } })} />
      <div className="small muted" style={{ marginTop: 4 }}>Docker relit toute cette période à chaque synchro et ne garde que les emails qu'il n'a pas encore (ceux supprimés dans Docker ne reviennent pas).</div>
    </Field>
  );
  const labelField = (
    <Field label="Libellé Gmail à lire (facultatif — recommandé)" span={3}>
      <div className="row-flex">
        <input list="gmail-labels" value={s.gmail.label} onChange={(e) => setS({ ...s, gmail: { ...s.gmail, label: e.target.value } })} placeholder="ex. Transporteurs" style={{ flex: 1 }} />
        <datalist id="gmail-labels">{(labels ?? []).map((l) => <option key={l} value={l} />)}</datalist>
        <button className="btn small" onClick={loadLabels}>Charger mes libellés</button>
        {s.gmail.label && <button className="btn ghost small" onClick={() => setS({ ...s, gmail: { ...s.gmail, label: '' } })}>✕</button>}
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>Crée un libellé dans Gmail (ex. « Transporteurs »), range-y les échanges logistiques (un filtre Gmail peut le faire tout seul), et Docker lira <b>tout ce libellé</b> — sans chercher par expéditeur ni mot-clé. Vide = recherche par adresses des partenaires + mots-clés.</div>
    </Field>
  );
  const connectGoogle = async () => {
    setConnecting(true); setMailMsg('Une page Google s\'ouvre dans ton navigateur : choisis le compte et accepte la lecture de Gmail…');
    const r = await api.mailConnectGoogle(s.gmail.clientId.trim(), s.gmail.clientSecret.trim());
    setConnecting(false); setMailMsg(`${r.ok ? '✅' : '⚠️'} ${r.message}`);
    if (r.ok && r.refreshToken) {
      const gmail = { ...s.gmail, mode: 'oauth' as const, refreshToken: r.refreshToken, email: r.email ?? s.gmail.email };
      setS({ ...s, gmail }); update((d) => ({ ...d, settings: { ...d.settings, gmail } }));
    }
  };

  const save = () => { update((d) => ({ ...d, settings: s })); toast('Réglages enregistrés'); };
  const test = async () => {
    setTesting(true); setTestMsg(null);
    const r = await api.testApiKey(s.anthropicApiKey);
    setTestMsg(`${r.ok ? '✅' : '⚠️'} ${r.message}`); setTesting(false);
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `docker-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  };
  const importJson = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) return;
      try { const parsed = JSON.parse(await f.text()); if (!parsed.projects) throw new Error(); replace({ ...emptyDatabase(), ...parsed }); toast('Données importées'); }
      catch { toast('Fichier invalide', true); }
    };
    input.click();
  };

  return (
    <div className="page">
      <div className="page-head"><div><h1>Réglages</h1><div className="sub">Clé API, taux de change, valeurs par défaut.</div></div><div className="actions"><button className="btn primary" onClick={save}>Enregistrer</button></div></div>

      <CloudCard s={s} setS={setS} />

      <div className="card">
        <h2>Lecture des documents (API Claude)</h2>
        <div className="form c3">
          <Field label="Clé API Anthropic" span={2}><Input type="password" value={s.anthropicApiKey} onChange={(v) => setS({ ...s, anthropicApiKey: v })} placeholder="sk-ant-…" /></Field>
          <Field label="Modèle"><Input value={s.model} onChange={(v) => setS({ ...s, model: v })} /></Field>
        </div>
        <div className="row-flex mt">
          <button className="btn" onClick={test} disabled={testing || !s.anthropicApiKey}>{testing ? 'Test…' : 'Tester la clé'}</button>
          {testMsg && <span className="small">{testMsg}</span>}
        </div>
        <div className="small muted mt">La clé est stockée uniquement sur cet ordinateur. Les documents sont envoyés à l'API Claude au moment de l'analyse, jamais ailleurs. Clé à créer sur console.anthropic.com.</div>
      </div>

      <div className="card">
        <h2>Boîte Gmail (échanges transporteurs & agents)</h2>
        <div className="row-flex mb small">
          <label className="check"><input type="radio" checked={s.gmail.mode === 'oauth'} onChange={() => setS({ ...s, gmail: { ...s.gmail, mode: 'oauth' } })} /> <span><b>Connexion Google</b> (recommandé — fonctionne avec tous les comptes)</span></label>
          <label className="check"><input type="radio" checked={s.gmail.mode === 'imap'} onChange={() => setS({ ...s, gmail: { ...s.gmail, mode: 'imap' } })} /> <span>Mot de passe d'application (IMAP)</span></label>
        </div>
        {s.gmail.mode === 'oauth' ? (
          <>
            <div className="form c3">
              <Field label="ID client OAuth"><Input value={s.gmail.clientId} onChange={(v) => setS({ ...s, gmail: { ...s.gmail, clientId: v } })} placeholder="1234…apps.googleusercontent.com" /></Field>
              <Field label="Secret client"><Input type="password" value={s.gmail.clientSecret} onChange={(v) => setS({ ...s, gmail: { ...s.gmail, clientSecret: v } })} placeholder="GOCSPX-…" /></Field>
              <Field label=" "><div className="row-flex" style={{ paddingTop: 6 }}><button className="btn primary" onClick={connectGoogle} disabled={connecting || !s.gmail.clientId || !s.gmail.clientSecret}>{connecting ? 'En attente de Google…' : s.gmail.refreshToken ? 'Reconnecter mon compte Google' : 'Connecter mon compte Google'}</button>{s.gmail.refreshToken && <button className="btn" onClick={testMail} disabled={mailTesting}>{mailTesting ? 'Test…' : 'Tester'}</button>}</div></Field>
              {labelField}
              {historyField}
              {!s.gmail.label && <Field label="Mots-clés recherchés dans les objets (séparés par des virgules)" span={3}><Input value={s.gmail.keywords} onChange={(v) => setS({ ...s, gmail: { ...s.gmail, keywords: v } })} /></Field>}
            </div>
            {mailMsg && <div className="small mt">{mailMsg}</div>}
            {s.gmail.refreshToken && <div className="small mt">✅ Compte connecté : <b>{s.gmail.email}</b>{s.gmail.lastSync && <> · dernière synchronisation {new Date(s.gmail.lastSync).toLocaleString('fr-FR')}</>} <button className="btn ghost small" onClick={() => { const gmail = { ...s.gmail, refreshToken: '' }; setS({ ...s, gmail }); update((d) => ({ ...d, settings: { ...d.settings, gmail } })); }}>Déconnecter</button></div>}
            <details className="small muted mt">
              <summary style={{ cursor: 'pointer' }}><b>Marche à suivre (une seule fois, ~5 minutes)</b> — obtenir un ID client et un secret</summary>
              <ol style={{ paddingLeft: 18, lineHeight: 1.6 }}>
                <li>Va sur <b>console.cloud.google.com</b>, connecté avec ton compte Gmail. En haut, crée un projet (ex. « Docker »).</li>
                <li>Menu ☰ → <b>API et services</b> → <b>Bibliothèque</b> → cherche « Gmail API » → <b>Activer</b>.</li>
                <li><b>API et services → Écran de consentement OAuth</b> (ou « Branding / Audience ») : type <b>Externe</b>, nom « Docker », ton email comme contact → Enregistrer. Dans <b>Audience</b>, ajoute ton adresse Gmail comme <b>utilisateur test</b>.</li>
                <li><b>API et services → Identifiants</b> → <b>Créer des identifiants</b> → <b>ID client OAuth</b> → type d'application <b>Application de bureau</b> → Créer. Copie l'<b>ID client</b> et le <b>Secret client</b> ici.</li>
                <li>Clique <b>Connecter mon compte Google</b> : une page Google s'ouvre (l'avertissement « application non validée » est normal : Continuer), choisis le compte, coche la lecture de Gmail, valide. Docker ne demande que la <b>lecture</b> — il ne peut ni envoyer ni supprimer.</li>
              </ol>
              Le jeton reste sur cet ordinateur ; tu peux retirer l'accès à tout moment sur myaccount.google.com/permissions.
            </details>
          </>
        ) : (
          <>
            <div className="form c3">
              <Field label="Adresse Gmail"><Input value={s.gmail.email} onChange={(v) => setS({ ...s, gmail: { ...s.gmail, email: v } })} placeholder="prenom@gmail.com" /></Field>
              <Field label="Mot de passe d'application"><Input type="password" value={s.gmail.appPassword} onChange={(v) => setS({ ...s, gmail: { ...s.gmail, appPassword: v } })} placeholder="xxxx xxxx xxxx xxxx" /></Field>
              <Field label=" "><div className="row-flex" style={{ paddingTop: 6 }}><button className="btn" onClick={testMail} disabled={mailTesting || !s.gmail.email || !s.gmail.appPassword}>{mailTesting ? 'Connexion…' : 'Tester la connexion'}</button></div></Field>
              {labelField}
              {historyField}
              {!s.gmail.label && <Field label="Mots-clés recherchés dans les objets (séparés par des virgules)" span={3}><Input value={s.gmail.keywords} onChange={(v) => setS({ ...s, gmail: { ...s.gmail, keywords: v } })} /></Field>}
            </div>
            {mailMsg && <div className="small mt">{mailMsg}</div>}
            <div className="small muted mt">Nécessite la validation en deux étapes sur le compte Google, puis un mot de passe d'application créé sur myaccount.google.com/apppasswords (16 caractères). Si ton compte ne le permet pas, utilise « Connexion Google » ci-dessus.</div>
          </>
        )}
        <div className="small muted mt">Dans tous les cas, Docker lit ta boîte en <b>lecture seule</b> et ne récupère que les échanges avec tes transporteurs et agents (adresses de Logistique) ou dont l'objet contient un mot-clé. Sans aucune connexion, tu peux aussi glisser des fichiers .eml dans Logistique → Emails.</div>
      </div>

      <div className="card">
        <h2>Taux de change (valeur en euros)</h2>
        <div className="form c4">
          {(['USD', 'GBP', 'CNY'] as Currency[]).map((c) => <Field key={c} label={`1 ${c} =`}><NumberInput value={s.fxToEur[c]} onChange={(v) => setS({ ...s, fxToEur: { ...s.fxToEur, [c]: v } })} unit="EUR" /></Field>)}
        </div>
        <div className="small muted mt">Mets-les à jour de temps en temps : tous les coûts de revient et marges sont recalculés avec ces taux.</div>
      </div>

      <div className="card">
        <h2>Valeurs par défaut</h2>
        <div className="form c4">
          <Field label="Droits de douane par défaut"><NumberInput value={s.defaultDutyRatePct} onChange={(v) => setS({ ...s, defaultDutyRatePct: v })} unit="%" /></Field>
          {(['FR', 'UK', 'US'] as Market[]).map((m) => <Field key={m} label={`TVA / taxe ${MARKET_LABELS[m]}`}><NumberInput value={s.defaultVat[m]} onChange={(v) => setS({ ...s, defaultVat: { ...s.defaultVat, [m]: v } })} unit="%" /></Field>)}
        </div>
      </div>

      <div className="card">
        <h2>Données</h2>
        <div className="row-flex" style={{ flexWrap: 'wrap' }}>
          <button className="btn" onClick={exportJson}>Exporter (JSON)</button>
          <button className="btn" onClick={importJson}>Importer un export</button>
          <button className="btn" onClick={() => { replace(seedDatabase()); toast("Données d'exemple chargées"); }}>Charger les données d'exemple</button>
          <ConfirmButton label="Tout effacer" onConfirm={() => { replace(emptyDatabase()); toast('Base vidée'); }} className="btn danger" />
        </div>
        <div className="small muted mt">{db.projects.length} projets · {db.products.length} produits · {db.factories.length} usines · {db.orders.length} commandes · {db.shipments.length} expéditions · {db.documents.length} documents</div>
      </div>
    </div>
  );
}


/** Compte & synchronisation : connexion, organisation partagée (plusieurs utilisateurs), état de la synchro. */
function CloudCard({ s, setS }: { s: Settings; setS: (v: Settings) => void }) {
  const { db, update, toast } = useStore();
  const [st, setSt] = useState<CloudStatus | null>(null);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [orgName, setOrgName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.cloudStatus().then(setSt).catch(() => undefined);
    const w = (window as unknown as { dockerCloud?: { onStatus: (cb: (s: CloudStatus) => void) => () => void } }).dockerCloud;
    return w ? w.onStatus(setSt) : undefined;
  }, []);
  const run = async (fn: () => Promise<CloudStatus>, okMsg?: string) => {
    setBusy(true);
    try { const r = await fn(); setSt(r); if (okMsg) toast(okMsg); }
    catch (e) { toast((e as Error).message, true); }
    finally { setBusy(false); }
  };
  const saveConfig = () => { update((d) => ({ ...d, settings: { ...d.settings, cloud: { ...d.settings.cloud, url: s.cloud.url.trim(), anonKey: s.cloud.anonKey.trim() } } })); toast('Configuration enregistrée — connexion en cours…'); setTimeout(() => api.cloudStatus().then(setSt).catch(() => undefined), 1500); };
  const configured = !!db.settings.cloud.url && !!db.settings.cloud.anonKey;
  const active = st?.orgs.find((o) => o.id === st.activeOrgId);
  const isOwner = active?.role === 'owner';
  return (
    <div className="card">
      <div className="card-head">
        <div><h2>Compte & espace partagé</h2><div className="small muted">Un compte par personne, un espace partagé par société : tout le monde voit et modifie les mêmes importations, marchandises, usines et documents, en temps réel, sur Mac comme sur PC.</div></div>
        {st?.user ? <span className="row-flex small">{st.syncing ? <><span className="spinner" /> synchronisation…</> : st.lastSync ? <span className="muted">✅ synchronisé {new Date(st.lastSync).toLocaleTimeString('fr-FR')} · v{st.version}</span> : null}{st.user && active && <button className="btn small" disabled={busy || st.syncing} onClick={() => run(() => api.cloudSyncNow(), 'Synchronisé')}>↻ Synchroniser</button>}</span> : null}
      </div>
      {st?.error && <div className="dup-banner warn mb">⚠️ {st.error}</div>}

      {!configured || !st?.configured ? (
        <>
          <div className="form c3">
            <Field label="URL du projet Supabase" span={2}><Input value={s.cloud.url} onChange={(v) => setS({ ...s, cloud: { ...s.cloud, url: v } })} placeholder="https://xxxxx.supabase.co" /></Field>
            <Field label=" "><button className="btn primary" style={{ marginTop: 20 }} onClick={saveConfig} disabled={!s.cloud.url.trim() || !s.cloud.anonKey.trim()}>Connecter le serveur</button></Field>
            <Field label="Clé « anon public »" span={3}><Input type="password" value={s.cloud.anonKey} onChange={(v) => setS({ ...s, cloud: { ...s.cloud, anonKey: v } })} placeholder="eyJhbGciOi…" /></Field>
          </div>
          <details className="small mt"><summary style={{ cursor: 'pointer' }}>Mettre en place le serveur (une seule fois, 5 minutes)</summary>
            <ol className="small" style={{ lineHeight: 1.7 }}>
              <li>Crée un compte gratuit sur <b>supabase.com</b>, puis « New project » (région : Europe, Frankfurt ou Paris). Note le mot de passe de base de données, il ne sert qu'à Supabase.</li>
              <li>Dans le projet : menu <b>SQL Editor</b> → « New query » → colle tout le contenu du fichier <code>supabase/schema.sql</code> (dans le dossier de Docker) → <b>Run</b>. Ça crée les tables, les règles d'accès, les fonctions et le stockage des fichiers.</li>
              <li>Menu <b>Authentication</b> → Providers → Email : laisse « Email » activé. Pour éviter l'étape de confirmation par email au début, tu peux décocher « Confirm email ».</li>
              <li>Menu <b>Project settings</b> → API : copie l'<b>URL</b> et la clé <b>anon public</b> ci-dessus, puis « Connecter le serveur ». Ton associé mettra exactement les mêmes valeurs sur son poste.</li>
            </ol>
          </details>
        </>
      ) : !st?.user ? (
        <>
          <div className="row-flex mb" style={{ gap: 6 }}><button className={`chip${mode === 'login' ? ' on' : ''}`} onClick={() => setMode('login')}>Se connecter</button><button className={`chip${mode === 'signup' ? ' on' : ''}`} onClick={() => setMode('signup')}>Créer un compte</button></div>
          <div className="form c3">
            {mode === 'signup' && <Field label="Ton nom"><Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Théo" /></Field>}
            <Field label="Email"><Input value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="prenom@societe.fr" /></Field>
            <Field label="Mot de passe"><Input type="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} placeholder="6 caractères minimum" /></Field>
            <Field label=" "><button className="btn primary" style={{ marginTop: 20 }} disabled={busy || !form.email || form.password.length < 6} onClick={() => run(() => (mode === 'signup' ? api.cloudSignUp(form.email.trim(), form.password, form.name.trim()) : api.cloudSignIn(form.email.trim(), form.password)), mode === 'signup' ? 'Compte créé' : 'Connecté')}>{busy ? 'Un instant…' : mode === 'signup' ? 'Créer mon compte' : 'Se connecter'}</button></Field>
          </div>
          <div className="small muted mt">Serveur : {db.settings.cloud.url} · <a style={{ cursor: 'pointer' }} onClick={() => update((d) => ({ ...d, settings: { ...d.settings, cloud: { ...d.settings.cloud, url: '', anonKey: '' } } }))}>changer</a></div>
        </>
      ) : (
        <>
          <div className="row-flex small mb"><span>Connecté en tant que <b>{st.user.name || st.user.email}</b> <span className="muted">({st.user.email})</span></span><span style={{ flex: 1 }} /><button className="btn small" disabled={busy} onClick={() => run(() => api.cloudSignOut(), 'Déconnecté')}>Se déconnecter</button></div>
          {st.orgs.length === 0 ? (
            <div className="form c2">
              <Field label="Créer l'espace de ta société"><div className="row-flex"><Input value={orgName} onChange={setOrgName} placeholder="ex. Wall Up" /><button className="btn primary" disabled={busy || !orgName.trim()} onClick={() => run(() => api.cloudCreateOrg(orgName), 'Espace créé — tes données actuelles y sont envoyées')}>Créer</button></div><div className="small muted">Tes données actuelles deviennent l'espace partagé.</div></Field>
              <Field label="Ou rejoindre un espace existant"><div className="row-flex"><Input value={code} onChange={setCode} placeholder="Code d'invitation (8 caractères)" /><button className="btn" disabled={busy || code.trim().length < 4} onClick={() => run(() => api.cloudJoinOrg(code), 'Espace rejoint — récupération des données…')}>Rejoindre</button></div><div className="small muted">Demande le code à ton associé (il l'a dans cette même page).</div></Field>
            </div>
          ) : (
            <>
              <div className="row-flex small mb" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span>Espace partagé :</span>
                {st.orgs.length > 1 ? <select value={st.activeOrgId} onChange={(e) => run(() => api.cloudSelectOrg(e.target.value), 'Espace changé')}>{st.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select> : <b>{active?.name}</b>}
                {active && <span className="muted">· tu es {isOwner ? 'propriétaire' : 'membre'}</span>}
                <span style={{ flex: 1 }} />
                {active && <ConfirmButton label="Quitter cet espace" className="btn ghost small" onConfirm={() => run(() => api.cloudLeaveOrg(active.id), 'Espace quitté')} />}
              </div>
              {active && (
                <div className="grid c2">
                  <div>
                    <div className="small muted">Inviter ton associé</div>
                    <div className="row-flex" style={{ gap: 8, alignItems: 'center' }}><code style={{ fontSize: 18, letterSpacing: 2, padding: '4px 10px', background: 'var(--accent-soft)', borderRadius: 8 }}>{active.inviteCode}</code><button className="btn small" onClick={() => { navigator.clipboard.writeText(active.inviteCode).then(() => toast('Code copié')); }}>Copier</button>{isOwner && <button className="btn ghost small" disabled={busy} onClick={() => run(() => api.cloudRegenerateCode(), 'Nouveau code généré')} title="Invalide l'ancien code">Régénérer</button>}</div>
                    <div className="small muted mt">Il installe Docker, met la même URL et la même clé Supabase, crée son compte, puis « Rejoindre un espace » avec ce code.</div>
                  </div>
                  <div>
                    <div className="small muted">Membres ({st.members.length})</div>
                    {st.members.map((m) => <div key={m.userId} className="small">👤 {m.name || m.email} <span className="muted">· {m.email} · {m.role === 'owner' ? 'propriétaire' : 'membre'}</span></div>)}
                  </div>
                </div>
              )}
              <div className="small muted mt">Ce qui est partagé : importations, marchandises, usines, commandes, expéditions, transporteurs, documents (PDF), emails récupérés, prix, réglages communs (taux de change, clé Claude). Propre à chaque poste : la connexion Gmail et ces identifiants Supabase. Docker garde une copie locale et fusionne fiche par fiche : deux personnes peuvent travailler en même temps.</div>
              <div className="form c2 mt">
                <Field label="Ou rejoindre un autre espace"><div className="row-flex"><Input value={code} onChange={setCode} placeholder="Code d'invitation" /><button className="btn small" disabled={busy || code.trim().length < 4} onClick={() => run(() => api.cloudJoinOrg(code), 'Espace rejoint')}>Rejoindre</button></div></Field>
                <Field label="Créer un autre espace"><div className="row-flex"><Input value={orgName} onChange={setOrgName} placeholder="Nom" /><button className="btn small" disabled={busy || !orgName.trim()} onClick={() => run(() => api.cloudCreateOrg(orgName), 'Espace créé')}>Créer</button></div></Field>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
