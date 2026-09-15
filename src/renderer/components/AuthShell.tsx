import React from 'react';
import logoUrl from '../assets/logo.png';

/** Habillage commun des écrans d'accueil (connexion, choix de l'espace) : panneau de marque à gauche, contenu à droite. */
export function AuthShell({ children, footer, wide }: { children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  return (
    <div className="auth">
      <aside className="auth-side">
        <div className="auth-brand"><img className="logo" src={logoUrl} alt="" /><div>Docker<small>Import Chine · BudinBox</small></div></div>
        <div className="auth-pitch">
          <h1>Tes importations, du plan technique à la marge.</h1>
          <ul>
            <li><span className="ico">⛴</span><div><b>Un espace par société</b><span>Importations, usines, commandes, documents : tout au même endroit, partagé avec ton équipe.</span></div></li>
            <li><span className="ico">✦</span><div><b>Documents lus par l'IA</b><span>Factures, packing lists, plans, devis transport : transformés en fiches, à vérifier en un clic.</span></div></li>
            <li><span className="ico">⇄</span><div><b>Temps réel, même hors ligne</b><span>Chaque poste garde une copie et se synchronise dès qu'il retrouve le réseau.</span></div></li>
          </ul>
        </div>
        <div className="auth-side-foot">Mac · Windows · Linux</div>
      </aside>
      <main className="auth-main">
        <div className={`auth-content${wide ? ' wide' : ''}`}>{children}</div>
        {footer && <div className="auth-foot">{footer}</div>}
      </main>
    </div>
  );
}

/** Pastille avec les initiales d'une personne. */
export function Avatar({ name, email }: { name: string; email: string }) {
  const src = (name || email).trim();
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  const initials = (parts.length >= 2 ? parts[0][0] + parts[1][0] : src.slice(0, 2)).toUpperCase();
  return <span className="avatar" aria-hidden>{initials}</span>;
}
