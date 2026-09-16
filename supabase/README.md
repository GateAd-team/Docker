# Bao · compte & espace partagé (Supabase)

Bao reste une application locale (Electron, données sur le poste), mais plusieurs personnes peuvent partager le même espace de travail via un projet Supabase (Postgres + auth + stockage + temps réel), hébergé en Europe ou auto-hébergé.

## Mise en place (une fois, par la personne qui administre)
1. Créer un projet sur supabase.com (région Europe).
2. SQL Editor → coller `schema.sql` → Run. Idempotent : peut être relancé après une mise à jour du schéma.
3. Authentication → Providers → Email activé (désactiver « Confirm email » pour éviter l'étape de confirmation au début).
4. Project settings → API : copier l'URL et la clé `anon public` dans Bao → Réglages → Compte & espace partagé, sur chaque poste.

## Modèle
- `profiles` : miroir de `auth.users` (email, nom).
- `organizations` : un espace partagé (= une société), avec un `invite_code`.
- `org_members` : qui est dans quel espace (`owner` / `member`).
- `workspaces` : toute la base Bao d'un espace en JSON (`data`) + `version` (verrouillage optimiste via `save_workspace`).
- Storage bucket `files` : `<org_id>/<document_id>.<ext>`.
- Toutes les tables sont protégées par RLS : seuls les membres lisent / écrivent leur espace.

## Synchronisation (electron/cloud.ts + src/shared/sync.ts)
- À chaque enregistrement local, synchro différée (1,5 s) : lecture du serveur, fusion à trois voies fiche par fiche (base = dernière version synchronisée, local, remote), envoi si la version n'a pas bougé (sinon on refusionne). Les autres postes sont prévenus en temps réel.
- Réglages partagés : taux de change, TVA, clé Claude, modèle, société. Locaux : Gmail, identifiants Supabase.
- Fichiers : envoyés au serveur après import ; téléchargés à la demande sur les autres postes (ouverture, lecture IA).
- Le poste garde toujours une copie locale complète (`database.json`) : Bao fonctionne hors ligne et rattrape au retour.

## Distribution
- Windows : `Lancer Bao.cmd` (ou `npm run build` + electron-builder pour un installeur).
- macOS : `Lancer Bao.command` (clic droit → Ouvrir la première fois). Installeur signé/notarisé : `npm run build` sur un Mac avec le certificat Developer ID (voir electron-builder `mac` dans package.json).
