# Docker · compte & espace partagé (Supabase)

Docker reste une application locale (Electron, données sur le poste), mais **tous les utilisateurs partagent le même espace de travail** via le projet Supabase intégré à l'application (Postgres + auth + stockage + temps réel).

## Fonctionnement pour l'utilisateur
- Au lancement : écran de connexion (email + mot de passe). « Créer un compte » la première fois.
- Un nouveau compte n'a accès à aucune donnée. Il doit **créer son espace** (il en devient propriétaire, les données locales du poste deviennent le contenu de l'espace) ou **rejoindre un espace existant** avec le code d'invitation à 8 caractères que le propriétaire trouve dans Réglages → Compte & espace partagé.
- Un compte peut appartenir à plusieurs espaces et changer d'espace actif dans les Réglages ; il peut quitter un espace, et le propriétaire peut régénérer le code pour invalider l'ancien.
- Rien à configurer sur le poste : le serveur est intégré à l'application.

## Mise en place (une fois, par la personne qui administre)
1. Le projet actuel est `gwsmympgsroetgpjtolv` (URL et clé publique dans `src/shared/cloudConfig.ts`).
2. Le schéma (`schema.sql`) est appliqué. Il est idempotent : à relancer dans SQL Editor après une mise à jour du schéma.
3. Authentication → Providers → Email : activé. Deux réglages à décider dans le tableau de bord Supabase :
   - **Confirm email** : si activé, l'utilisateur doit cliquer le lien reçu avant de pouvoir se connecter (Docker l'indique). Le désactiver simplifie le démarrage.
   - **Allow new users to sign up** : peut rester activé, un nouveau compte ne voit rien sans code d'invitation. À désactiver si tu préfères créer les comptes à la main dans Authentication → Users.
4. Pour changer de projet : nouveau projet Supabase, coller `schema.sql`, mettre à jour `cloudConfig.ts`, redistribuer l'application.

## Modèle
- `profiles` : miroir de `auth.users` (email, nom).
- `organizations` : un espace partagé (= une société), avec un `invite_code`.
- `org_members` : qui est dans quel espace (`owner` / `member`).
- `workspaces` : toute la base Docker d'un espace en JSON (`data`) + `version` (verrouillage optimiste via `save_workspace`).
- Storage bucket `files` : `<org_id>/<document_id>.<ext>`.
- Toutes les tables sont protégées par RLS : seuls les membres lisent / écrivent leur espace.

## Synchronisation (electron/cloud.ts + src/shared/sync.ts)
- À chaque enregistrement local, synchro différée (1,5 s) : lecture du serveur, fusion à trois voies fiche par fiche (base = dernière version synchronisée, local, remote), envoi si la version n'a pas bougé (sinon on refusionne). Les autres postes sont prévenus en temps réel.
- Réglages partagés : taux de change, TVA, clé Claude, modèle, société. Locaux : Gmail, espace actif.
- Fichiers : envoyés au serveur après import ; téléchargés à la demande sur les autres postes (ouverture, lecture IA).
- Le poste garde toujours une copie locale complète (`database.json`) : Docker fonctionne hors ligne et rattrape au retour.

## Distribution
- Windows : `Lancer Docker.cmd` (ou `npm run build` + electron-builder pour un installeur).
- macOS : `Lancer Docker.command` (clic droit → Ouvrir la première fois). Installeur signé/notarisé : `npm run build` sur un Mac avec le certificat Developer ID (voir electron-builder `mac` dans package.json).
