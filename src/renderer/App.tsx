import logoUrl from './assets/logo.png';
import React, { createContext, useContext, useState } from 'react';
import { api } from './api';
import { useStore } from './store';
import { useCloud } from './cloud';
import { LoginPage } from './pages/Login';
import { WorkspacePage } from './pages/Workspace';
import { Dashboard } from './pages/Dashboard';
import { MerchandisePage } from './pages/Merchandise';
import { FactoriesPage } from './pages/Factories';
import { ProjectsPage } from './pages/Projects';
import { LogisticsPage } from './pages/Logistics';
import { FinancePage } from './pages/Finance';
import { DocumentsPage } from './pages/Documents';
import { SettingsPage } from './pages/Settings';
import { ViewerProvider } from './components/Viewer';
import { AssistantPanel } from './components/Assistant';

export type Page = 'dashboard' | 'merchandise' | 'factories' | 'projects' | 'logistics' | 'finance' | 'documents' | 'settings';
export interface NavState { page: Page; id?: string; sub?: string }

const NavCtx = createContext<{ nav: NavState; go: (page: Page, id?: string, sub?: string) => void; back: () => void; forward: () => void; canBack: boolean; canForward: boolean }>({ nav: { page: 'dashboard' }, go: () => {}, back: () => {}, forward: () => {}, canBack: false, canForward: false });
export const useNav = () => useContext(NavCtx);

const PAGES: { page: Page; label: string; ico: string }[] = [
  { page: 'dashboard', label: 'Tableau de bord', ico: '◫' },
  { page: 'merchandise', label: 'Marchandise', ico: '▦' },
  { page: 'factories', label: 'Usines', ico: '⚙' },
  { page: 'projects', label: 'Importations', ico: '▣' },
  { page: 'logistics', label: 'Logistique', ico: '⛴' },
  { page: 'finance', label: 'Finance', ico: '€' },
  { page: 'documents', label: 'Documents', ico: '⇩' },
  { page: 'settings', label: 'Réglages', ico: '⚒' },
];

export function App() {
  const { status: cloud } = useCloud();
  // Connexion obligatoire (sauf mode démo dans le navigateur), puis un espace de travail (créé ou rejoint par code).
  // Aperçu des écrans d'accueil en mode démo (navigateur) : http://localhost:5173/?screen=login ou ?screen=workspace
  const preview = api.isDemo ? new URLSearchParams(window.location.search).get('screen') : null;
  if (preview === 'login' || (!api.isDemo && !cloud?.user)) return <LoginPage />;
  if (preview === 'workspace' || (!api.isDemo && !cloud?.activeOrgId)) return <WorkspacePage />;
  return <Workspace />;
}

function Workspace() {
  const { db, ready } = useStore();
  const { status: cloud } = useCloud();
  // Historique de navigation (comme un navigateur) : pile de pages + position.
  const [history, setHistory] = useState<{ stack: NavState[]; index: number }>({ stack: [{ page: 'dashboard' }], index: 0 });
  const nav = history.stack[history.index];
  const [assistant, setAssistant] = useState(false);
  const go = (page: Page, id?: string, sub?: string) => setHistory((h) => {
    const cur = h.stack[h.index];
    if (cur.page === page && cur.id === id && cur.sub === sub) return h;
    const stack = [...h.stack.slice(0, h.index + 1), { page, id, sub }].slice(-50);
    return { stack, index: stack.length - 1 };
  });
  const back = () => setHistory((h) => (h.index > 0 ? { ...h, index: h.index - 1 } : h));
  const forward = () => setHistory((h) => (h.index < h.stack.length - 1 ? { ...h, index: h.index + 1 } : h));
  const canBack = history.index > 0, canForward = history.index < history.stack.length - 1;

  // Alt+← / Alt+→ et boutons latéraux de la souris.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); back(); } if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); forward(); } };
    const onMouse = (e: MouseEvent) => { if (e.button === 3) { e.preventDefault(); back(); } if (e.button === 4) { e.preventDefault(); forward(); } };
    window.addEventListener('keydown', onKey); window.addEventListener('mouseup', onMouse);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mouseup', onMouse); };
  }, []);

  const pageLabel = (n: NavState) => {
    const base = PAGES.find((p) => p.page === n.page)?.label ?? n.page;
    if (!n.id) return base;
    const name = n.page === 'merchandise' || n.page === 'finance' ? db.products.find((p) => p.id === n.id)?.name : n.page === 'factories' ? db.factories.find((f) => f.id === n.id)?.name : n.page === 'projects' ? db.projects.find((x) => x.id === n.id)?.name : n.page === 'logistics' ? db.shipments.find((x) => x.id === n.id)?.reference : undefined;
    return name ? `${base} › ${name}` : base;
  };
  const prev = canBack ? history.stack[history.index - 1] : null;

  const counts: Partial<Record<Page, number>> = {
    merchandise: db.products.length, factories: db.factories.length, projects: db.projects.filter((x) => x.status !== 'archive' && x.status !== 'vente').length || undefined, logistics: db.shipments.filter((s) => s.status !== 'livree').length,
    documents: db.documents.filter((d) => !d.extracted).length || undefined,
  };

  return (
    <NavCtx.Provider value={{ nav, go, back, forward, canBack, canForward }}>
      <ViewerProvider>
      <div className="app">
        <aside className="sidebar">
          <div className="brand"><img className="logo" src={logoUrl} alt="" /><div>Docker<small>Import Chine · BudinBox</small></div></div>
          <nav>
            {PAGES.map((p) => (
              <button key={p.page} className={nav.page === p.page ? 'active' : ''} onClick={() => go(p.page)}>
                <span className="ico">{p.ico}</span>{p.label}
                {counts[p.page] ? <span className="count">{counts[p.page]}</span> : null}
              </button>
            ))}
            <button className={`assistant-btn${assistant ? ' active' : ''}`} onClick={() => setAssistant((a) => !a)}><span className="ico">✦</span>Assistant</button>
          </nav>
          <div className="foot">{api.isDemo ? 'Mode démo (navigateur)' : cloud?.user ? <><div>🏢 {cloud.orgs.find((o) => o.id === cloud.activeOrgId)?.name}</div><div>👤 {cloud.user.name || cloud.user.email}{cloud.syncing ? ' · synchro…' : cloud.error ? ' · ⚠️ hors ligne' : cloud.lastSync ? ' · ✅ synchronisé' : ''}</div></> : 'Données stockées sur cet ordinateur'}</div>
        </aside>
        <main className="main">
          {api.isDemo && <div className="demo-banner">Mode démo : données d'exemple, lecture IA simulée. Lance l'application Electron pour la version complète.</div>}
          <div className="navbar">
            <button className="btn small" disabled={!canBack} onClick={back} title={prev ? `Retour à : ${pageLabel(prev)} (Alt+←)` : 'Retour (Alt+←)'}>← Retour{prev ? <span className="muted small" style={{ marginLeft: 6, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pageLabel(prev)}</span> : null}</button>
            <button className="btn small" disabled={!canForward} onClick={forward} title="Suivant (Alt+→)">→</button>
          </div>
          {!ready ? <div className="page muted">Chargement…</div> : (
            <>
              {nav.page === 'dashboard' && <Dashboard />}
              {nav.page === 'merchandise' && <MerchandisePage />}
              {nav.page === 'factories' && <FactoriesPage />}
              {nav.page === 'projects' && <ProjectsPage />}
              {nav.page === 'logistics' && <LogisticsPage />}
              {nav.page === 'finance' && <FinancePage />}
              {nav.page === 'documents' && <DocumentsPage />}
              {nav.page === 'settings' && <SettingsPage />}
            </>
          )}
        </main>
        <AssistantPanel open={assistant} onClose={() => setAssistant(false)} />
      </div>
      </ViewerProvider>
    </NavCtx.Provider>
  );
}
