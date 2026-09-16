/**
 * Modèle de données de Bao.
 * Partagé entre le process principal Electron (stockage, IA) et l'interface React.
 * Tout est volontairement plat (tableaux d'objets reliés par id) pour être facile à
 * migrer vers SQLite ou vers le store de BudinBox.
 */

export type Currency = 'USD' | 'EUR' | 'GBP' | 'CNY';
export type Market = 'FR' | 'UK' | 'US';

/**
 * Projet d'import = un conteneur / un départ groupé : rassemble les commandes passées
 * à différentes usines qui partent ensemble (ou en même temps), avec leurs expéditions.
 */
/**
 * Flux de marchandise entre usines dans une importation : l'usine A envoie ses produits
 * à l'usine B (qui les transforme / assemble), B envoie à C, C charge le conteneur pour la France.
 * `to` = id d'usine, ou 'FR' pour la destination finale (conteneur → France).
 */
export interface ProjectFlow {
  id: string;
  fromFactoryId: string;
  to: string;               // id d'usine ou 'FR'
  lines: { productId: string; qty: number }[];
  date: string;             // date d'envoi prévue / réelle
  status: 'prevu' | 'envoye' | 'recu';
  note: string;
  /** Généré automatiquement depuis le contenu du conteneur et les compositions (remplacé à la prochaine génération). */
  auto?: boolean;
}

/** Négociation de prix avec une usine, dans le cadre d'une importation. */
export interface NegotiationLine {
  productId: string;
  qty: number;
  /** Dernier prix connu chez cette usine (USD), au moment de l'ouverture. */
  lastPrice: number | null;
  /** Prix visé (USD). */
  targetPrice: number | null;
  /** Dernière offre reçue de l'usine (USD). */
  offeredPrice: number | null;
  /** Prix convenu (USD). */
  agreedPrice: number | null;
}
export interface NegotiationMessage { id: string; date: string; from: 'moi' | 'usine'; text: string; documentId: string | null }
export interface Negotiation {
  id: string;
  factoryId: string;
  status: 'a_lancer' | 'en_cours' | 'accord' | 'abandon';
  lines: NegotiationLine[];
  messages: NegotiationMessage[];
  notes: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  status: 'idee' | 'rd' | 'sourcing' | 'production' | 'transport' | 'vente' | 'archive';
  /** Date de départ visée (ETD cible). */
  targetDate: string;
  /** Type de conteneur / mode : "40HQ", "20GP", "LCL", "aérien"… */
  container: string;
  notes: string;
  /** Arborescence des flux entre usines (voir ProjectFlow). */
  flows: ProjectFlow[];
  /** Position des cartes dans le schéma des flux (id d'usine ou 'FR' → x, y), déplacées à la main. */
  layout: Record<string, { x: number; y: number }>;
  /** Contenu final du conteneur (produits finis + reliquats), déduit des compositions puis corrigé à la main. */
  contents: { productId: string; qty: number }[];
  /** Usine qui regroupe tout et charge le conteneur (groupage). Null = chaque usine expédie vers la France. */
  consolidatorFactoryId: string | null;
  /** Documents (PDF, photos) rattachés à une carte de l'arborescence : usine (id) ou 'FR' (conteneur / France). */
  docLinks: { documentId: string; factoryId: string }[];
  /** Usines pour lesquelles la commande a été lancée (coché à la main dans « Marchandise de l'importation »). */
  launchedFactoryIds?: string[];
  /** Masquer le tableau « Marchandise de l'importation ». */
  needsHidden?: boolean;
  /** Négociations de prix, une par usine. */
  negotiations: Negotiation[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Sous-référence d'une composition.
 * role 'base' : toujours inclus. role 'option' : appartient à un groupe d'options (ex. "Housse")
 * dans lequel une seule variante est retenue ; `isDefault` marque celle du coût standard.
 */
export interface ProductComponent {
  productId: string;
  qty: number;
  role: 'base' | 'option';
  optionGroup: string;
  isDefault: boolean;
}

/** Coût additionnel par unité. `amount` dans `currency` ; `amountEur` = ancien champ (EUR), conservé pour la migration. */
export interface ExtraCost { id: string; label: string; amount: number; currency: Currency; amountEur: number; note: string }

/** Dossier de rangement du catalogue (imbriquable). */
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}

/** Une référence du catalogue. Peut être composée d'autres références (sous-références). */
export interface Product {
  id: string;
  projectId: string | null;   // gamme (facultatif, historique)
  folderId: string | null;    // dossier de rangement
  name: string;               // nom interne (le tien)
  /** Famille de versions : toutes les versions d'un même produit partagent ce familyId (= id de la V1). */
  familyId: string;
  version: string;            // "V1", "V2"…
  versionDate: string;        // AAAA-MM-JJ
  versionNotes: string;       // ce qui change dans cette version (procédé, usine, matière…)
  isCurrentVersion: boolean;  // la version affichée dans le catalogue et utilisée par défaut
  supplierName: string;       // libellé tel qu'il apparaît sur les factures / chez l'usine
  sku: string;                // référence interne (code)
  description: string;
  factoryId: string | null;   // usine de fabrication principale
  components: ProductComponent[]; // sous-références et quantités
  /** Vrai si le prix usine de cette référence comprend déjà ses sous-références (l'usine fournit tout). */
  componentsIncludedInPrice: boolean;
  /** Photo de la marchandise : id d'un document image (synchronisé comme les PDF). */
  photoDocumentId?: string | null;
  /** Produit final : ce qui se vend et arrive en France dans le conteneur (par opposition aux composants / matières). */
  isFinished?: boolean;
  /** Coûts additionnels par unité : assemblage, transport interne, réparation, contrôle qualité, emballage… */
  extraCosts: ExtraCost[];
  /** @deprecated remplacé par extraCosts (conservé pour la migration). */
  assemblyCostEur: number;
  hsCode: string;          // code douanier (SH / HS)
  dutyRatePct: number;     // droits de douane à l'import (%), par défaut UE
  unitWeightKg: number;
  unitsPerCarton: number;
  cartonCbm: number;       // volume d'un carton (m³)
  notes: string;
}

/** Plan technique (dessin) d'un produit, avec versions successives. */
export interface Drawing {
  id: string;
  productId: string;
  version: string;         // "V1", "V2.1"…
  title: string;
  changelog: string;       // ce qui change par rapport à la version précédente
  status: 'brouillon' | 'valide' | 'envoye_usine' | 'approuve_usine';
  documentId: string | null; // fichier PDF / image associé
  createdAt: string;
}

/** Commentaire daté sur une usine (retour d'expérience, qualité, délais…). */
export interface FactoryComment { id: string; date: string; text: string; rating: number }

export interface Factory {
  id: string;
  name: string;
  city: string;
  province: string;
  address: string;
  website: string;
  wechat: string;
  email: string;
  phone: string;
  specialties: string;     // ce qu'ils fabriquent
  rating: number;          // 0-5 étoiles
  notes: string;
  comments: FactoryComment[];
}

export interface Contact {
  id: string;
  ownerType: 'factory' | 'partner';
  ownerId: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  wechat: string;
  whatsapp: string;
}

/** Transporteur (freight forwarder) ou agent de sourcing / contrôle qualité en Chine. */
export interface Partner {
  id: string;
  type: 'transporteur' | 'agent';
  name: string;
  city: string;
  email: string;
  phone: string;
  wechat: string;
  services: string;
  notes: string;
  /** Bilan IA des échanges emails : résumé et choses à faire. */
  insights: { summary: string; actions: { id: string; text: string; done: boolean; dueDate: string; mailId: string | null }[]; analyzedAt: string };
}

/** Prix proposé par une usine pour un produit à une date donnée (historique des prix). */
export interface Quote {
  id: string;
  productId: string;
  factoryId: string;
  date: string;
  unitPrice: number;
  currency: Currency;
  moq: number;
  incoterm: 'EXW' | 'FOB' | 'CIF' | 'DDP';
  leadTimeDays: number;
  documentId: string | null;
  notes: string;
}

export interface OrderLine {
  productId: string;        // '' pour une prestation (confection, assemblage…) sans référence
  qty: number;
  unitPrice: number;
  currency: Currency;
  /** Libellé libre : prestation ou ligne sans référence. */
  label?: string;
  /** Prestation (service facturé) et non une marchandise. */
  isService?: boolean;
}

export interface Order {
  id: string;
  projectId: string;
  factoryId: string;
  reference: string;       // n° de PI / facture usine
  date: string;
  status: 'devis' | 'pi_recue' | 'acompte_paye' | 'en_production' | 'prete' | 'expediee' | 'livree';
  lines: OrderLine[];
  depositPct: number;
  depositPaid: boolean;
  balancePaid: boolean;
  productionDays: number;
  expectedReadyDate: string;
  invoiceDocumentId: string | null;
  proformaDocumentId: string | null;
  packingListDocumentId: string | null;
  notes: string;
}

export interface Shipment {
  id: string;
  /** Projet / conteneur auquel cette expédition appartient (facultatif). */
  projectId: string | null;
  reference: string;
  orderIds: string[];
  partnerId: string | null; // transporteur
  agentId: string | null;   // agent chinois qui fait le lien
  mode: 'mer' | 'air' | 'rail' | 'express';
  incoterm: 'EXW' | 'FOB' | 'CIF' | 'DDP';
  status: 'planifiee' | 'collectee' | 'en_transit' | 'dedouanement' | 'livree';
  etd: string;
  eta: string;
  cbm: number;
  weightKg: number;
  freightCost: number;      // fret principal
  insuranceCost: number;
  originFees: number;       // frais départ (THC, docs, camion usine → port)
  destinationFees: number;  // frais arrivée (THC, dédouanement, livraison)
  currency: Currency;
  trackingRef: string;
  documentId: string | null;
  notes: string;
}

/** Prix de vente et frais d'un produit sur un marché. */
export interface MarketPrice {
  id: string;
  productId: string;
  market: Market;
  sellPrice: number;        // prix public TTC
  currency: Currency;
  vatPct: number;           // TVA / sales tax
  platformFeePct: number;   // commission marketplace, paiement…
  lastMileCost: number;     // expédition au client final
  date: string;
}

export type DocumentKind =
  | 'facture' | 'proforma' | 'bon_de_commande' | 'packing_list' | 'catalogue' | 'plan_technique'
  | 'devis_transport' | 'contact' | 'capture_ecran' | 'autre';

export interface LinkedEntity { type: 'project' | 'product' | 'factory' | 'partner' | 'order' | 'shipment' | 'drawing'; id: string }

export interface DocumentRecord {
  id: string;
  fileName: string;
  mimeType: string;
  storedPath: string;       // chemin du fichier copié dans les données de l'app
  sizeBytes: number;
  kind: DocumentKind;
  extracted: Record<string, unknown> | null; // résultat brut de la lecture IA
  summary: string;
  linkedTo: LinkedEntity[];
  createdAt: string;
}

export interface Settings {
  anthropicApiKey: string;
  model: string;
  /** Taux de change : combien vaut 1 unité de la devise en EUR. */
  fxToEur: Record<Currency, number>;
  /** Date de la dernière mise à jour automatique des taux (AAAA-MM-JJ). */
  fxUpdatedAt?: string;
  /** Mettre à jour les taux automatiquement à chaque ouverture (défaut : oui). */
  fxAuto?: boolean;
  defaultDutyRatePct: number;
  defaultVat: Record<Market, number>;
  /** Signature des messages de négociation. */
  companyName: string;
  senderName: string;
  /** Boîte Gmail (IMAP + mot de passe d'application) pour récupérer les échanges avec les transporteurs. */
  gmail: {
    /** 'oauth' = connexion Google (recommandé), 'imap' = mot de passe d'application. */
    mode: 'oauth' | 'imap';
    email: string; appPassword: string; keywords: string; lastSync: string;
    /** Libellé Gmail (dossier) à lire : si renseigné, Bao lit tous les emails de ce libellé, sans filtrer par expéditeur ni mot-clé. */
    label: string;
    /** Connexion Google (API Gmail) : identifiants OAuth « application de bureau » créés sur console.cloud.google.com, et jeton obtenu. */
    clientId: string; clientSecret: string; refreshToken: string;
    /** Profondeur d'historique lue à chaque synchronisation (jours). Les emails déjà récupérés sont ignorés grâce à leur identifiant. */
    historyDays: number;
    /** Emails supprimés dans Bao : on ne les re-télécharge pas. */
    skipIds: string[];
  };
  /** Espace partagé actif (Supabase, voir `cloudConfig.ts`) : propre au poste, jamais envoyé sur le serveur. */
  cloud: { orgId: string; orgName: string };
}

/** Email récupéré depuis la boîte Gmail (échanges transporteurs / agents). */
export interface MailAttachment { index: number; filename: string; mimeType: string; size: number; documentId: string | null }
export interface MailMessage {
  id: string;               // `${mailbox}:${uid}`
  uid: number;
  mailbox: string;
  date: string;             // ISO
  from: string;             // adresse
  fromName: string;
  to: string;
  subject: string;
  text: string;             // texte brut (tronqué)
  attachments: MailAttachment[];
  partnerId: string | null; // transporteur / agent associé
  shipmentId: string | null;
  read: boolean;
  /** Archivé : masqué de la liste principale (reste consultable via le filtre « Archivés »). */
  archived?: boolean;
}

export interface Database {
  version: number;
  projects: Project[];
  folders: Folder[];
  products: Product[];
  drawings: Drawing[];
  factories: Factory[];
  contacts: Contact[];
  partners: Partner[];
  quotes: Quote[];
  orders: Order[];
  shipments: Shipment[];
  marketPrices: MarketPrice[];
  documents: DocumentRecord[];
  mails: MailMessage[];
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  anthropicApiKey: '',
  model: 'claude-sonnet-4-5',
  fxToEur: { EUR: 1, USD: 0.92, GBP: 1.17, CNY: 0.13 },
  defaultDutyRatePct: 4,
  defaultVat: { FR: 20, UK: 20, US: 0 },
  companyName: 'Wall Up',
  senderName: 'Théo',
  cloud: { orgId: '', orgName: '' },
  gmail: { mode: 'oauth', email: '', appPassword: '', clientId: '', clientSecret: '', refreshToken: '', label: '', historyDays: 730, skipIds: [], keywords: 'shipping, freight, fret, container, conteneur, B/L, bill of lading, booking, ETA, ETD, forwarder, transitaire, douane, customs, port, Le Havre, Shenzhen', lastSync: '' },
};

export function emptyDatabase(): Database {
  return {
    version: 1,
    projects: [], folders: [], products: [], drawings: [], factories: [], contacts: [], partners: [],
    quotes: [], orders: [], shipments: [], marketPrices: [], documents: [], mails: [],
    settings: { ...DEFAULT_SETTINGS, fxToEur: { ...DEFAULT_SETTINGS.fxToEur }, defaultVat: { ...DEFAULT_SETTINGS.defaultVat } },
  };
}

/** Complète une base lue sur disque (champs ajoutés au fil des versions). */
export function normalizeDatabase(raw: Partial<Database>): Database {
  const base = emptyDatabase();
  const db: Database = {
    ...base,
    ...raw,
    settings: {
      ...DEFAULT_SETTINGS, ...(raw.settings ?? {}),
      fxToEur: { ...DEFAULT_SETTINGS.fxToEur, ...(raw.settings?.fxToEur ?? {}) },
      defaultVat: { ...DEFAULT_SETTINGS.defaultVat, ...(raw.settings?.defaultVat ?? {}) },
      gmail: { ...DEFAULT_SETTINGS.gmail, ...(raw.settings?.gmail ?? {}) },
      cloud: { ...DEFAULT_SETTINGS.cloud, ...(raw.settings?.cloud ?? {}) },
    },
  };
  db.mails = db.mails ?? [];
  db.folders = db.folders ?? [];
  db.projects = db.projects.map((pr) => { const part = pr as Partial<Project>; return { ...pr, targetDate: part.targetDate ?? '', container: part.container ?? '', notes: part.notes ?? '', flows: part.flows ?? [], layout: part.layout ?? {}, contents: part.contents ?? [], consolidatorFactoryId: part.consolidatorFactoryId ?? null, docLinks: part.docLinks ?? [], negotiations: part.negotiations ?? [] }; });
  db.partners = db.partners.map((p) => ({ ...p, insights: (p as Partial<Partner>).insights ?? { summary: '', actions: [], analyzedAt: '' } }));
  db.factories = db.factories.map((f) => ({ ...f, rating: (f as Partial<Factory>).rating ?? 0, comments: (f as Partial<Factory>).comments ?? [] }));
  db.orders = db.orders.map((o) => ({ ...o, proformaDocumentId: (o as Partial<Order>).proformaDocumentId ?? null }));
  const SHIP_STATUS = ['planifiee', 'collectee', 'en_transit', 'dedouanement', 'livree'];
  db.shipments = db.shipments.map((sh) => ({ ...sh, projectId: (sh as Partial<Shipment>).projectId ?? null, status: SHIP_STATUS.includes(sh.status) ? sh.status : 'planifiee', orderIds: sh.orderIds ?? [], notes: sh.notes ?? '', trackingRef: sh.trackingRef ?? '' }));
  // Migration : chaque ancienne « gamme » devient un dossier.
  for (const g of db.projects) {
    if (!db.folders.some((f) => f.id === `folder-${g.id}`) && (db.products as Partial<Product>[]).some((p) => p.projectId === g.id && !p.folderId)) {
      db.folders.push({ id: `folder-${g.id}`, name: g.name, parentId: null });
    }
  }
  db.products = db.products.map((p) => {
    const partial = p as Partial<Product>;
    const comps = (partial.components ?? []).map((c) => ({ role: 'base' as const, optionGroup: '', isDefault: false, ...(c as Partial<ProductComponent>), productId: c.productId, qty: c.qty }));
    return {
      ...p,
      projectId: partial.projectId ?? null,
      folderId: partial.folderId ?? (partial.projectId && db.folders.some((f) => f.id === `folder-${partial.projectId}`) ? `folder-${partial.projectId}` : null),
      supplierName: partial.supplierName ?? '',
      familyId: partial.familyId ?? p.id,
      version: partial.version ?? 'V1',
      versionDate: partial.versionDate ?? '',
      versionNotes: partial.versionNotes ?? '',
      isCurrentVersion: partial.isCurrentVersion ?? true,
      description: partial.description ?? '',
      factoryId: partial.factoryId ?? null,
      components: comps,
      componentsIncludedInPrice: partial.componentsIncludedInPrice ?? false,
      isFinished: partial.isFinished ?? false,
      // Migration : l'ancien « coût additionnel » unique devient une ligne « Assemblage ».
      extraCosts: (partial.extraCosts ?? (partial.assemblyCostEur ? [{ id: `xc-${p.id}`, label: 'Assemblage', amount: partial.assemblyCostEur, currency: 'EUR' as const, amountEur: partial.assemblyCostEur, note: '' }] : [])).map((x) => { const xc = x as Partial<ExtraCost>; return { ...x, amount: xc.amount ?? xc.amountEur ?? 0, currency: xc.currency ?? 'EUR', amountEur: xc.amountEur ?? xc.amount ?? 0 }; }),
      assemblyCostEur: 0,
    };
  });
  return db;
}

/** Résultat de l'analyse IA d'un lot d'emails transporteurs. */
export interface MailAnalysis {
  partners: { existingId: string | null; name: string; type: 'transporteur' | 'agent'; email: string; phone: string; wechat: string; city: string; services: string; contactName: string; contactRole: string; summary: string; actions: { text: string; dueDate: string; mailId: string }[]; mailIds: string[] }[];
  shipments: { existingId: string | null; partnerName: string; reference: string; containerNo: string; trackingRef: string; mode: 'mer' | 'air' | 'rail' | 'express'; incoterm: 'EXW' | 'FOB' | 'CIF' | 'DDP'; origin: string; destination: string; etd: string; eta: string; status: 'planifiee' | 'collectee' | 'en_transit' | 'dedouanement' | 'livree'; cbm: number | null; weightKg: number | null; freightCost: number | null; insuranceCost: number | null; originFees: number | null; destinationFees: number | null; currency: 'USD' | 'EUR' | 'GBP' | 'CNY'; notes: string; mailIds: string[]; invoiceTotal?: number | null; invoiceRef?: string; invoiceCurrency?: 'USD' | 'EUR' | 'GBP' | 'CNY' }[];
  overview: string;
}

/** Mise à jour de l'application (Releases GitHub). */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  state: 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'opened' | 'error';
  url: string | null;
  notes: string;
  progress: number;
  error: string;
  platform: 'windows' | 'mac' | 'linux';
}

/** Résultat de la lecture IA d'un document importé. */
export interface ExtractionResult {
  kind: DocumentKind;
  summary: string;
  confidence: number;
  data: Record<string, unknown>;
}

/** API exposée au renderer par le preload Electron (window.docker). */
export interface DockerApi {
  loadDb(): Promise<Database>;
  saveDb(db: Database): Promise<void>;
  importFiles(): Promise<DocumentRecord[]>;                           // ouvre une boîte de dialogue
  importDropped(files: { name: string; mimeType: string; base64: string }[]): Promise<DocumentRecord[]>;
  openDocument(id: string): Promise<void>;
  readDocumentBase64(id: string): Promise<{ mimeType: string; base64: string } | null>;
  extractDocument(id: string): Promise<ExtractionResult>;
  testApiKey(key: string): Promise<{ ok: boolean; message: string }>;
  /** Assistant intégré : envoie la conversation, exécute les outils côté principal, renvoie la réponse. */
  chat(messages: { role: 'user' | 'assistant'; content: string }[], context: { page: string; id?: string; selectionLabel?: string }): Promise<{ text: string; traces: { tool: string; summary: string }[]; navigate?: { page: string; id?: string } }>;
  /** Gmail (IMAP) : test de connexion, récupération des échanges, import d'une pièce jointe. */
  mailTest(gmail: Settings['gmail']): Promise<{ ok: boolean; message: string }>;
  /** Connexion Google (OAuth) : ouvre le navigateur, renvoie le jeton et l'adresse du compte. */
  mailConnectGoogle(clientId: string, clientSecret: string): Promise<{ ok: boolean; message: string; refreshToken?: string; email?: string }>;
  mailSync(params: { senders: string[]; keywords: string[]; sinceDays: number; knownIds: string[] }): Promise<{ messages: MailMessage[]; scanned: number; remaining: number }>;
  /** Liste des libellés (dossiers) de la boîte, pour en choisir un dans Réglages. */
  mailLabels(): Promise<string[]>;
  mailAttachment(mailId: string, index: number): Promise<DocumentRecord | null>;
  /** Import de fichiers .eml (message téléchargé depuis Gmail) déposés dans Bao. */
  mailImportEml(files: { name: string; base64: string }[]): Promise<MailMessage[]>;
  /** Analyse IA d'un lot d'emails : transporteurs, contacts, expéditions, bilan, choses à faire. */
  mailAnalyze(mailIds: string[]): Promise<MailAnalysis>;
  /** Compte & synchronisation. */
  cloudStatus(): Promise<CloudStatus>;
  cloudSignUp(email: string, password: string, name: string): Promise<CloudStatus>;
  cloudSignIn(email: string, password: string): Promise<CloudStatus>;
  cloudSignOut(): Promise<CloudStatus>;
  cloudCreateOrg(name: string): Promise<CloudStatus>;
  cloudJoinOrg(code: string): Promise<CloudStatus>;
  cloudSelectOrg(orgId: string): Promise<CloudStatus>;
  cloudLeaveOrg(orgId: string): Promise<CloudStatus>;
  cloudRegenerateCode(): Promise<CloudStatus>;
  /** Modifier son compte : nom, email (confirmation par email selon les réglages Supabase), mot de passe. */
  cloudUpdateAccount(patch: { name?: string; email?: string; password?: string; currentPassword?: string }): Promise<CloudStatus>;
  /** Taux de change du jour (EUR pour 1 unité) depuis un service public ; null si hors ligne. */
  fetchRates(): Promise<{ rates: Partial<Record<Currency, number>>; date: string } | null>;
  /** Mises à jour : vérification, téléchargement (Windows) / ouverture du lien (Mac), installation. */
  updateStatus(): Promise<UpdateStatus>;
  updateCheck(): Promise<UpdateStatus>;
  updateDownload(): Promise<UpdateStatus>;
  updateInstall(): Promise<void>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void;
  cloudSyncNow(): Promise<CloudStatus>;
  /** Force l'envoi de toutes les données de ce poste vers l'espace (fusion complète, rien n'est écrasé côté serveur). */
  cloudPushLocal(): Promise<CloudStatus>;
  /** Le poste reçoit une base fusionnée depuis le serveur (temps réel ou après une synchro). */
  onRemoteDb(cb: (db: Database) => void): () => void;
  isDemo: boolean;
}

export interface CloudStatus {
  /** Première vérification de session terminée (avant : on ne sait pas encore si l'utilisateur est connecté). */
  ready: boolean;
  configured: boolean;
  user: { id: string; email: string; name: string } | null;
  orgs: { id: string; name: string; role: string; inviteCode: string }[];
  activeOrgId: string;
  members: { userId: string; email: string; name: string; role: string }[];
  version: number;
  lastSync: string;
  syncing: boolean;
  error: string;
  /** Dernier état connu de l'espace sur le serveur : nombre de fiches par collection (après la dernière synchro). */
  remoteCounts: Record<string, number>;
  /** Fichiers envoyés sur le serveur / fichiers présents localement. */
  filesUploaded: number;
  filesLocal: number;
}
