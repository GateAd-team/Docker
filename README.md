# Docker — gestion des importations depuis la Chine

Application de bureau (Mac / Windows / Linux) pour piloter des projets d'importation :
R&D et plans techniques, usines et contacts, commandes et logistique, coût de revient et marges.
Les documents (PDF, photos, captures d'écran) sont lus par l'API Claude et transformés en fiches.

Nom provisoire : **Docker**. Destinée à devenir un agent de **BudinBox**.

## Démarrage rapide

```bash
npm install
npm run dev        # ouvre l'application Electron (rechargement à chaud du renderer)
```

Autres commandes :

```bash
npm run dev:web    # renderer seul dans le navigateur, en mode démo (données d'exemple, IA simulée)
npm run build      # compile main + renderer
npm run dist       # produit l'installeur (.dmg / .exe / .AppImage) dans release/
npm test           # tests des calculs financiers
npm run typecheck  # vérification TypeScript des deux côtés
```

Au lancement, l'application demande de **se connecter ou créer un compte** (email + mot de passe), puis de
**créer son espace de travail ou rejoindre celui d'un collègue** avec son code d'invitation. Chaque espace a ses
propres données, visibles uniquement par ses membres. Le serveur (projet Supabase) est intégré à l'application
(`src/shared/cloudConfig.ts`) : rien à configurer sur le poste.

Première utilisation : **Réglages → clé API Anthropic** (créée sur console.anthropic.com), puis « Tester la clé ».
Sans clé, tout fonctionne sauf l'analyse automatique des documents. La clé est partagée avec les autres comptes.
« Charger les données d'exemple » dans Réglages permet de voir l'app remplie.

## Architecture

```
electron/            process principal Electron (Node)
  main.ts            fenêtre, handlers IPC
  preload.ts         expose window.docker (API typée : src/shared/types.ts → DockerApi)
  store.ts           stockage JSON local + copie des fichiers importés
  ai.ts              appel à l'API Claude (PDF → bloc document, image → bloc image, réponse forcée via tool_use)
  cloud.ts           compte Supabase (login), espaces de travail (créer / rejoindre par code), synchro temps réel + fichiers
src/shared/          code partagé main ↔ renderer (aucune dépendance Electron ni React)
  cloudConfig.ts     URL + clé publique du projet Supabase (intégrées à l'app, identiques pour tous)
  types.ts           modèle de données complet (Database) + interface DockerApi
  finance.ts         calculs : conversion devises, coût de revient, douane, marges, prix cible
  extraction.ts      prompt d'extraction + schémas attendus par type de document
src/renderer/        interface React (Vite)
  api.ts             window.docker si présent, sinon mode démo (localStorage + IA simulée)
  cloud.tsx          état du compte (connecté ? synchro ?) ; pages/Login.tsx + pages/Workspace.tsx = connexion puis choix de l'espace
  store.tsx          état global (toute la base en mémoire, sauvegarde à chaque mutation)
  applyExtraction.ts résultat IA → propositions de fiches → application à la base
  pages/             Dashboard, Projects (+R&D), Factories, Logistics, Finance, Documents, Settings
  seed.ts            jeu de données d'exemple
test/finance.test.ts tests unitaires des calculs
```

### Données

Tout est dans un seul objet `Database` (voir `types.ts`) : tableaux plats reliés par `id`.
Sur disque : `<userData>/docker-data/database.json` (écriture atomique) et les fichiers importés dans
`<userData>/docker-data/files/`. `userData` = `~/Library/Application Support/Docker` sur Mac,
`%APPDATA%/Docker` sur Windows.

Le renderer charge la base entière au démarrage, la modifie de façon immuable (`update(db => ...)`)
et la renvoie au process principal qui l'écrit. Simple et suffisant pour quelques milliers d'objets ;
passer à SQLite revient à réécrire `electron/store.ts` sans toucher au reste.

### Lecture des documents (IA)

1. Le fichier est copié dans `files/` et une fiche `DocumentRecord` est créée (kind = `autre`).
2. « Analyser » → `ai:extract` → `electron/ai.ts` envoie le fichier à Claude avec le prompt de
   `src/shared/extraction.ts` et un outil `enregistrer_extraction` (tool_choice forcé) pour obtenir
   un JSON structuré : `{ kind, summary, confidence, data }`.
3. Le renderer construit une **proposition** (`buildProposal`) : usine existante ou nouvelle
   (rapprochement par nom), contacts, produits (rapprochement par nom dans le projet choisi),
   prix pour l'historique, commande, expédition, version de plan…
4. L'utilisateur choisit le projet, associe les lignes aux produits, coche, puis `applyProposal`
   écrit tout dans la base et lie le document aux fiches créées.

Types de documents gérés : facture / proforma (avec packing list intégrée), packing list, catalogue,
plan technique, devis transport, contact, capture d'écran, autre.

### Finance (src/shared/finance.ts)

- Prix convertis en EUR avec les taux des Réglages (`fxToEur`).
- Coût de revient unitaire = marchandise + part de logistique (fret, assurance, frais départ)
  + droits de douane sur la valeur CIF + part des frais à l'arrivée.
- La logistique d'une expédition est répartie entre ses lignes au prorata du **volume**
  (pièces/carton × m³/carton) si connu, sinon de la **valeur**.
- Marge par marché : prix TTC → HT (TVA du marché) − commission plateforme − livraison client − coût de revient.
- `priceForTargetMargin` donne le prix TTC à afficher pour une marge cible.
- La TVA à l'import est calculée à titre indicatif (récupérable pour une société), hors coût de revient.

## Intégration dans BudinBox

- `src/shared/` est autonome : le modèle, les calculs et le prompt d'extraction se réutilisent tels quels.
- `DockerApi` (types.ts) est le contrat entre l'interface et le « backend » ; il suffit de fournir une
  autre implémentation (serveur BudinBox, autre stockage) pour que l'interface fonctionne sans changement —
  `src/renderer/api.ts` en contient déjà une seconde (mode démo).
- Aucune dépendance UI externe : CSS maison (`styles.css`), composants dans `components/ui.tsx`.

## Pistes pour la suite

- Rapprochement automatique packing list ↔ commande existante (aujourd'hui : par référence de facture).
- Alertes (acompte à payer, production en retard, ETA dépassée) et notifications.
- Export Excel des coûts de revient / marges.
- Comparateur de devis entre usines pour un même produit.
- Taux de change automatiques.
- Lecture par lots (analyser tous les documents « à traiter » d'un coup).
