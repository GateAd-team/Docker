/**
 * Assistant intégré : consignes, outils et exécution des outils sur la base.
 * Tout est pur (pas de dépendance Electron) : `runTool` prend une base et renvoie la base modifiée.
 */
import type { Database, Product } from './types';
import { formatEur, shipmentTotalEur, unitCost, orderTotalEur } from './finance';
import { explodeNeeds, factoryLinePrice, includedInParentPrice, proposeContents } from './importFlows';
import { projectFinance } from './projectFinance';
import { suggestShipmentUpdate } from './mailAnalysis';

export type Collection = 'projects' | 'products' | 'folders' | 'factories' | 'contacts' | 'partners' | 'quotes' | 'orders' | 'shipments' | 'marketPrices' | 'drawings' | 'documents' | 'mails';
const COLLECTIONS: Collection[] = ['projects', 'products', 'folders', 'factories', 'contacts', 'partners', 'quotes', 'orders', 'shipments', 'marketPrices', 'drawings', 'documents', 'mails'];

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatContext { page: string; id?: string; selectionLabel?: string }
export interface ToolTrace { tool: string; summary: string }
export interface ChatResult { text: string; traces: ToolTrace[]; navigate?: { page: string; id?: string } }

export const ASSISTANT_SYSTEM = `Tu es l'assistant intégré de "Docker", un logiciel de gestion des importations depuis la Chine (catalogue de marchandises, usines, logistique, finance).
Tu parles français, tu es direct et concis, tu tutoies l'utilisateur. Tu agis directement dans le logiciel grâce aux outils.
Un « état du logiciel » (importations, usines, expéditions, emails, chiffres clés) t'est donné après ces consignes : appuie-toi dessus pour répondre tout de suite aux questions de suivi, et utilise les outils de synthèse (analyser_importation, expedition, point_du_jour) plutôt que de lire fiche par fiche. Les outils de synthèse contiennent déjà les calculs du logiciel (coûts, transport réparti au volume, marges, besoins par usine, statut de transit, emails) : ne recalcule pas toi-même ce qu'ils renvoient.

Modèle de données (collections et champs principaux) :
- products (référence du catalogue) : id, name (nom interne), familyId (famille de versions : toutes les versions d'un même produit partagent le familyId de la V1), version ('V1','V2'…), versionDate, versionNotes (ce qui change), isCurrentVersion (une seule par famille), supplierName (libellé facture), sku (code interne), description, folderId, factoryId, components [{productId, qty, role:'base'|'option', optionGroup, isDefault}], componentsIncludedInPrice (vrai si le prix usine comprend déjà les sous-références), isFinished (produit final vendu / chargé dans le conteneur, par opposition aux composants), extraCosts [{id, label, amount, currency (EUR|USD|CNY|GBP), amountEur, note}] (coûts additionnels par unité dans leur devise : assemblage, transport interne, réparation, contrôle qualité…), hsCode, dutyRatePct, unitWeightKg, unitsPerCarton, cartonCbm, notes.
  Coût de revient = prix usine (logistique + douane) + sous-références (sauf componentsIncludedInPrice) + somme des extraCosts. Pour ajouter un coût, passe le tableau extraCosts complet avec un id quelconque pour la nouvelle ligne. Une référence peut être composée d'autres références. Les composants 'option' se regroupent par optionGroup (ex. "Housse") ; celui avec isDefault compte dans le coût standard.
- folders : id, name, parentId (dossiers imbriqués pour ranger les références).
- factories (usines) : id, name, city, province, address, website, wechat, email, phone, specialties, rating (0-5 étoiles), notes, comments [{id, date, text, rating}] (commentaires datés : qualité, délais… ; pour en ajouter un, passe le tableau complet).
- contacts : id, ownerType 'factory'|'partner', ownerId, name, role, email, phone, wechat, whatsapp.
- partners (transporteurs / agents) : id, type 'transporteur'|'agent', name, city, email, phone, wechat, services, notes.
- quotes (prix usine, historique) : id, productId, factoryId, date (AAAA-MM-JJ), unitPrice, currency (USD|EUR|GBP|CNY), moq, incoterm (EXW|FOB|CIF|DDP), leadTimeDays, notes.
- projects (« importations » dans l'interface = un conteneur / un départ groupé qui rassemble les commandes de plusieurs usines) : id, name, description, status (idee|rd|sourcing|production|transport|vente|archive), targetDate (départ visé), container ('40HQ', '20GP', 'LCL'…), notes, flows [{id, fromFactoryId, to (id d'usine ou 'FR' = France/conteneur), lines [{productId, qty}], date, status (prevu|envoye|recu), note}] (arborescence des flux entre usines : A envoie ses produits à B, B assemble et envoie à C, C charge le conteneur pour la France ; pour ajouter un flux, passe le tableau flows complet), contents [{productId, qty}] (liste de courses : produits finis voulus en France ; l'arborescence des flux se déduit des compositions), negotiations [{id, factoryId, status (a_lancer|en_cours|accord|abandon), lines [{productId, qty, lastPrice, targetPrice, offeredPrice, agreedPrice}] (USD), messages [{id, date, from ('moi'|'usine'), text}], notes}] (négociation de prix par usine).
- orders (commandes) : id, projectId (importation / conteneur), factoryId, reference, date, status (devis|pi_recue|acompte_paye|en_production|prete|expediee|livree), lines [{productId, qty, unitPrice, currency}], depositPct, depositPaid, balancePaid, productionDays, expectedReadyDate, notes.
- shipments (expéditions) : id, projectId (importation), reference, orderIds[], partnerId, agentId, mode (mer|air|rail|express), incoterm, status (planifiee|collectee|en_transit|dedouanement|livree), etd, eta, cbm, weightKg, freightCost, insuranceCost, originFees, destinationFees, currency, trackingRef, notes.
- marketPrices (prix de vente) : id, productId, market (FR|UK|US), sellPrice (TTC), currency, vatPct, platformFeePct, lastMileCost.
- drawings (plans techniques, versions) : id, productId, version, title, changelog, status (brouillon|valide|envoye_usine|approuve_usine), documentId.
- documents (fichiers importés, lecture seule) : id, fileName, kind, summary, linkedTo.
- mails (emails Gmail récupérés avec les transporteurs / agents, lecture seule sauf partnerId, shipmentId, read) : id, date, from, fromName, subject, text, attachments [{filename, documentId}], partnerId, shipmentId, read. Utile pour résumer où en est une expédition (ETA, documents demandés, frais).

Règles :
- Commence toujours par chercher (rechercher / lister) avant de créer, pour ne pas faire de doublons ; modifie plutôt que recréer.
- Pour les ids, utilise ceux renvoyés par les outils. Ne les invente jamais.
- Pour supprimer, demande confirmation sauf si l'utilisateur l'a clairement demandé dans son message.
- Après avoir agi, résume en une ou deux phrases ce que tu as fait (les fiches se mettent à jour toutes seules à l'écran). Propose de naviguer vers la fiche si utile.
- Les montants sont des nombres. Les dates au format AAAA-MM-JJ.
- Si une demande est ambiguë, pose UNE question courte.
- Réponds avec des chiffres précis (€, dates, quantités) et cite les fiches concernées. Pas de généralités : tout ce que tu dis doit venir des outils ou de l'état du logiciel.
- Quand l'utilisateur est sur une page ou une fiche (contexte), c'est d'elle qu'il parle sauf indication contraire.`;

export const ASSISTANT_TOOLS = [
  {
    name: 'rechercher',
    description: "Recherche par texte dans les références (nom, libellé fournisseur, code), usines, dossiers, transporteurs. Renvoie les fiches correspondantes avec leur id.",
    input_schema: { type: 'object' as const, properties: { texte: { type: 'string' } }, required: ['texte'] },
  },
  {
    name: 'lister',
    description: "Liste une collection (résumé compact avec ids). Filtre optionnel par égalité de champ, ex. {productId: '…'} ou {folderId: '…'}.",
    input_schema: { type: 'object' as const, properties: { collection: { type: 'string', enum: COLLECTIONS }, filtre: { type: 'object', additionalProperties: true }, limite: { type: 'number' } }, required: ['collection'] },
  },
  {
    name: 'lire',
    description: 'Renvoie une fiche complète par id.',
    input_schema: { type: 'object' as const, properties: { collection: { type: 'string', enum: COLLECTIONS }, id: { type: 'string' } }, required: ['collection', 'id'] },
  },
  {
    name: 'creer',
    description: 'Crée une fiche. Les champs absents prennent des valeurs par défaut. Renvoie la fiche créée avec son id.',
    input_schema: { type: 'object' as const, properties: { collection: { type: 'string', enum: COLLECTIONS.filter((c) => c !== 'documents' && c !== 'mails') }, donnees: { type: 'object', additionalProperties: true } }, required: ['collection', 'donnees'] },
  },
  {
    name: 'modifier',
    description: "Modifie les champs indiqués d'une fiche existante (les autres champs sont conservés). Pour components ou lines, passe le tableau complet.",
    input_schema: { type: 'object' as const, properties: { collection: { type: 'string', enum: COLLECTIONS }, id: { type: 'string' }, champs: { type: 'object', additionalProperties: true } }, required: ['collection', 'id', 'champs'] },
  },
  {
    name: 'supprimer',
    description: 'Supprime une fiche par id.',
    input_schema: { type: 'object' as const, properties: { collection: { type: 'string', enum: COLLECTIONS }, id: { type: 'string' } }, required: ['collection', 'id'] },
  },
  {
    name: 'dupliquer',
    description: "Duplique une référence (fiche, composition, prix usine et prix de vente) et renvoie la copie. Utile pour créer une variante (autre taille, autre couleur) à partir d'une référence existante ; modifie ensuite la copie.",
    input_schema: { type: 'object' as const, properties: { productId: { type: 'string' }, nouveauNom: { type: 'string' } }, required: ['productId'] },
  },
  {
    name: 'nouvelle_version',
    description: "Crée une nouvelle version (V suivante) d'une référence à partir de sa version actuelle : même fiche et composition, puis applique les champs indiqués (factoryId, description, versionNotes…). La nouvelle version devient la version actuelle.",
    input_schema: { type: 'object' as const, properties: { productId: { type: 'string' }, champs: { type: 'object', additionalProperties: true } }, required: ['productId'] },
  },
  {
    name: 'cout',
    description: "Calcule le coût de revient unitaire d'une référence (achat + logistique + douane, ou somme de sa composition) et ses marges par marché.",
    input_schema: { type: 'object' as const, properties: { productId: { type: 'string' } }, required: ['productId'] },
  },
  {
    name: 'analyser_importation',
    description: "Synthèse complète d'une importation (conteneur) : statut, liste de courses, besoins à commander chez chaque usine avec prix, commandes et leur avancement, expéditions (ETD/ETA/statut/coûts), analyse financière (coût marchandise, transport réparti au volume, douane, CA net HT, bénéfice avec et sans transport, marge, prix de vente manquants), négociations. À utiliser pour toute question sur un conteneur / une importation.",
    input_schema: { type: 'object' as const, properties: { projectId: { type: 'string' } }, required: ['projectId'] },
  },
  {
    name: 'expedition',
    description: "Détail d'une expédition : transporteur, agent, dates, statut, coûts, commandes embarquées, importation, et les emails qui lui sont rattachés (derniers échanges, statut que suggèrent les emails). À utiliser pour « où en est le conteneur / le transport ».",
    input_schema: { type: 'object' as const, properties: { shipmentId: { type: 'string' } }, required: ['shipmentId'] },
  },
  {
    name: 'point_du_jour',
    description: "Vue d'ensemble de tout ce qui est en cours : importations et leur avancement, commandes en production (dates de fin), expéditions en transit (ETA, retards), emails non lus, actions à faire issues des emails, marchandises sans prix de vente ou sans coût connu. À utiliser pour « où en est-on », « qu'est-ce qui presse », « résume ».",
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'naviguer',
    description: "Affiche une page du logiciel à l'utilisateur : merchandise (id = référence), factories (id = usine), logistics (id = expédition), finance (id = référence), documents, settings, dashboard.",
    input_schema: { type: 'object' as const, properties: { page: { type: 'string', enum: ['dashboard', 'merchandise', 'factories', 'projects', 'logistics', 'finance', 'documents', 'settings'] }, id: { type: 'string' } }, required: ['page'] },
  },
];

/** État compact du logiciel, injecté dans les consignes pour que l'assistant réponde sans fouiller. */
export function buildOverview(db: Database): string {
  const today = new Date().toISOString().slice(0, 10);
  const name = (id: string | null | undefined, col: 'products' | 'factories' | 'partners' | 'projects') => (id ? (db[col] as { id: string; name: string }[]).find((x) => x.id === id)?.name ?? id : '—');
  const projects = db.projects.filter((p) => p.status !== 'archive').map((p) => {
    const orders = db.orders.filter((o) => o.projectId === p.id);
    const ships = db.shipments.filter((s) => s.projectId === p.id || s.orderIds.some((id) => orders.some((o) => o.id === id)));
    const f = p.contents.length ? projectFinance(db, p) : null;
    return `- ${p.name} (id ${p.id}) · statut ${p.status} · ${p.container || 'conteneur ?'} · départ visé ${p.targetDate || '?'} · ${orders.length} commande(s) [${[...new Set(orders.map((o) => name(o.factoryId, 'factories')))].join(', ')}] · ${ships.length} expédition(s)${ships.length ? ` [${ships.map((s) => `${s.reference || 'exp.'} ${s.status} ETD ${s.etd || '?'} ETA ${s.eta || '?'}`).join('; ')}]` : ''}${f ? ` · marchandise ${formatEur(f.goodsEur, 0)} · transport+douane ${formatEur(f.transportEur + f.dutyEur, 0)} · CA net HT ${formatEur(f.revenueEur, 0)} · bénéfice ${formatEur(f.profitEur, 0)}${f.missingPrices.length ? ` · ${f.missingPrices.length} sans prix de vente` : ''}` : ' · liste de courses vide'}`;
  });
  const factories = db.factories.map((f) => `- ${f.name} (id ${f.id})${f.city ? ` · ${f.city}` : ''} · ${db.products.filter((p) => p.factoryId === f.id && p.isCurrentVersion).length} référence(s)${f.rating ? ` · ${f.rating}★` : ''}`);
  const partners = db.partners.map((p) => `- ${p.name} (id ${p.id}, ${p.type})${p.insights.actions.filter((a) => !a.done).length ? ` · ${p.insights.actions.filter((a) => !a.done).length} action(s) à faire` : ''}`);
  const products = db.products.filter((p) => p.isCurrentVersion).slice(0, 80).map((p) => `- ${p.name} (id ${p.id})${p.sku ? ` · ${p.sku}` : ''} · usine ${name(p.factoryId, 'factories')}${p.components.length ? ` · ${p.components.length} sous-réf.` : ''}`);
  const unread = db.mails.filter((m) => !m.read && !m.archived).length;
  return [
    `Date du jour : ${today}. Société : ${db.settings.companyName || 'Wall Up'}.`,
    `IMPORTATIONS (${projects.length}) :\n${projects.join('\n') || '(aucune)'}`,
    `USINES (${factories.length}) :\n${factories.join('\n') || '(aucune)'}`,
    `TRANSPORTEURS / AGENTS (${partners.length}) :\n${partners.join('\n') || '(aucun)'}`,
    `RÉFÉRENCES (${db.products.filter((p) => p.isCurrentVersion).length}${db.products.filter((p) => p.isCurrentVersion).length > 80 ? ', 80 premières' : ''}) :\n${products.join('\n') || '(aucune)'}`,
    `EMAILS : ${db.mails.length} récupérés, ${unread} non lus. DOCUMENTS : ${db.documents.length}, dont ${db.documents.filter((d) => !d.extracted).length} à analyser.`,
  ].join('\n\n');
}

function newId(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function defaults(db: Database, collection: Collection): Record<string, unknown> {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  switch (collection) {
    case 'products': return { projectId: null, folderId: null, name: '', supplierName: '', sku: '', description: '', factoryId: null, familyId: '', version: 'V1', versionDate: today, versionNotes: '', isCurrentVersion: true, components: [], componentsIncludedInPrice: false, isFinished: false, extraCosts: [], assemblyCostEur: 0, hsCode: '', dutyRatePct: db.settings.defaultDutyRatePct, unitWeightKg: 0, unitsPerCarton: 0, cartonCbm: 0, notes: '' };
    case 'folders': return { name: '', parentId: null };
    case 'factories': return { name: '', city: '', province: '', address: '', website: '', wechat: '', email: '', phone: '', specialties: '', rating: 0, notes: '', comments: [] };
    case 'contacts': return { ownerType: 'factory', ownerId: '', name: '', role: '', email: '', phone: '', wechat: '', whatsapp: '' };
    case 'partners': return { type: 'transporteur', name: '', city: '', email: '', phone: '', wechat: '', services: '', notes: '', insights: { summary: '', actions: [], analyzedAt: '' } };
    case 'quotes': return { productId: '', factoryId: '', date: today, unitPrice: 0, currency: 'USD', moq: 0, incoterm: 'FOB', leadTimeDays: 0, documentId: null, notes: '' };
    case 'projects': return { name: '', description: '', status: 'sourcing', targetDate: '', container: '', notes: '', flows: [], layout: {}, contents: [], consolidatorFactoryId: null, docLinks: [], negotiations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    case 'orders': return { projectId: '', factoryId: '', reference: '', date: today, status: 'devis', lines: [], depositPct: 30, depositPaid: false, balancePaid: false, productionDays: 30, expectedReadyDate: '', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null, notes: '' };
    case 'shipments': return { projectId: null, reference: '', orderIds: [], partnerId: null, agentId: null, mode: 'mer', incoterm: 'FOB', status: 'planifiee', etd: '', eta: '', cbm: 0, weightKg: 0, freightCost: 0, insuranceCost: 0, originFees: 0, destinationFees: 0, currency: 'USD', trackingRef: '', documentId: null, notes: '' };
    case 'marketPrices': return { productId: '', market: 'FR', sellPrice: 0, currency: 'EUR', vatPct: db.settings.defaultVat.FR, platformFeePct: 0, lastMileCost: 0, date: today };
    case 'drawings': return { productId: '', version: 'V1', title: '', changelog: '', status: 'brouillon', documentId: null, createdAt: now };
    default: return {};
  }
}

/** Résumé compact d'une fiche pour ne pas noyer le modèle. */
function brief(collection: Collection, r: Record<string, unknown>, db: Database): Record<string, unknown> {
  const pick = (...keys: string[]) => Object.fromEntries(keys.filter((k) => r[k] !== undefined && r[k] !== '' && r[k] !== null).map((k) => [k, r[k]]));
  switch (collection) {
    case 'products': return { ...pick('id', 'name', 'supplierName', 'sku', 'folderId', 'factoryId', 'hsCode'), nbComposants: (r.components as unknown[])?.length ?? 0, coutEur: unitCost(String(r.id), db)?.costEur ?? null };
    case 'folders': return pick('id', 'name', 'parentId');
    case 'factories': return pick('id', 'name', 'city', 'specialties');
    case 'projects': return pick('id', 'name', 'status', 'targetDate', 'container');
    case 'orders': return { ...pick('id', 'reference', 'projectId', 'factoryId', 'date', 'status', 'expectedReadyDate'), lignes: (r.lines as { productId: string; qty: number }[])?.map((l) => `${l.qty}×${l.productId}`) };
    case 'shipments': return pick('id', 'reference', 'status', 'mode', 'etd', 'eta', 'orderIds', 'partnerId');
    case 'documents': return pick('id', 'fileName', 'kind', 'summary');
    case 'mails': return { ...pick('id', 'date', 'from', 'fromName', 'subject', 'partnerId', 'shipmentId'), extrait: String(r.text ?? '').slice(0, 300) };
    default: return pick('id', 'name', 'productId', 'factoryId', 'market', 'sellPrice', 'unitPrice', 'currency', 'date', 'version', 'title', 'type', 'ownerId', 'status');
  }
}

export interface ToolOutcome { db: Database; result: unknown; summary: string; navigate?: { page: string; id?: string } }

export function runTool(db: Database, name: string, input: Record<string, unknown>): ToolOutcome {
  const col = input.collection as Collection;
  const list = (c: Collection) => (db[c] as unknown as Record<string, unknown>[]);
  const label = (c: Collection, r: Record<string, unknown>) => String(r.name ?? r.reference ?? r.fileName ?? r.title ?? r.id);

  switch (name) {
    case 'rechercher': {
      const t = norm(input.texte);
      const hits: Record<string, unknown>[] = [];
      for (const c of ['products', 'factories', 'folders', 'partners', 'orders', 'projects'] as Collection[]) {
        for (const r of list(c)) {
          if (Object.values(r).some((v) => typeof v === 'string' && norm(v).includes(t))) hits.push({ collection: c, ...brief(c, r, db) });
          if (hits.length >= 25) break;
        }
      }
      return { db, result: hits, summary: `recherche « ${input.texte} » : ${hits.length} résultat${hits.length > 1 ? 's' : ''}` };
    }
    case 'lister': {
      if (!COLLECTIONS.includes(col)) throw new Error(`Collection inconnue : ${col}`);
      const f = (input.filtre ?? {}) as Record<string, unknown>;
      const rows = list(col).filter((r) => Object.entries(f).every(([k, v]) => r[k] === v)).slice(0, Number(input.limite) || 50);
      return { db, result: rows.map((r) => brief(col, r, db)), summary: `liste ${col} (${rows.length})` };
    }
    case 'lire': {
      const r = list(col).find((x) => x.id === input.id);
      if (!r) throw new Error('Fiche introuvable');
      return { db, result: r, summary: `lecture ${col} « ${label(col, r)} »` };
    }
    case 'creer': {
      if (!COLLECTIONS.includes(col) || col === 'documents') throw new Error(`Création impossible dans ${col}`);
      const rec: Record<string, unknown> = { ...defaults(db, col), ...(input.donnees as Record<string, unknown>), id: newId() };
      if (col === 'products') { if (!rec.familyId) rec.familyId = rec.id; }
      if (col === 'products') rec.components = ((rec.components as Partial<Product['components'][number]>[]) ?? []).map((c) => ({ role: 'base', optionGroup: '', isDefault: false, qty: 1, ...c }));
      const next = { ...db, [col]: [...list(col), rec] } as Database;
      return { db: next, result: rec, summary: `créé ${singular(col)} « ${label(col, rec)} »` };
    }
    case 'modifier': {
      const rows = list(col);
      const idx = rows.findIndex((x) => x.id === input.id);
      if (idx < 0) throw new Error('Fiche introuvable');
      const patch = { ...(input.champs as Record<string, unknown>) }; delete patch.id;
      if (col === 'products' && Array.isArray(patch.components)) patch.components = (patch.components as Partial<Product['components'][number]>[]).map((c) => ({ role: 'base', optionGroup: '', isDefault: false, qty: 1, ...c }));
      const rec = { ...rows[idx], ...patch };
      const next = { ...db, [col]: rows.map((x, i) => (i === idx ? rec : x)) } as Database;
      return { db: next, result: rec, summary: `modifié ${singular(col)} « ${label(col, rec)} » (${Object.keys(patch).join(', ')})` };
    }
    case 'supprimer': {
      const rows = list(col);
      const rec = rows.find((x) => x.id === input.id);
      if (!rec) throw new Error('Fiche introuvable');
      let next = { ...db, [col]: rows.filter((x) => x.id !== input.id) } as Database;
      if (col === 'products') next = { ...next, products: next.products.map((p) => ({ ...p, components: p.components.filter((c) => c.productId !== input.id) })) };
      return { db: next, result: { ok: true }, summary: `supprimé ${singular(col)} « ${label(col, rec)} »` };
    }
    case 'dupliquer': {
      const src = db.products.find((p) => p.id === input.productId);
      if (!src) throw new Error('Référence introuvable');
      const nid = newId();
      const copy: Product = { ...src, id: nid, familyId: nid, version: 'V1', isCurrentVersion: true, name: String(input.nouveauNom || `${src.name} (copie)`), sku: src.sku ? `${src.sku}-COPIE` : '', components: src.components.map((c) => ({ ...c })), extraCosts: (src.extraCosts ?? []).map((x) => ({ ...x, id: newId() })) };
      const next: Database = {
        ...db,
        products: [...db.products, copy],
        quotes: [...db.quotes, ...db.quotes.filter((q) => q.productId === src.id).map((q) => ({ ...q, id: newId(), productId: nid }))],
        marketPrices: [...db.marketPrices, ...db.marketPrices.filter((m) => m.productId === src.id).map((m) => ({ ...m, id: newId(), productId: nid }))],
      };
      return { db: next, result: copy, summary: `dupliqué « ${src.name} » → « ${copy.name} »` };
    }
    case 'nouvelle_version': {
      const src = db.products.find((p) => p.id === input.productId);
      if (!src) throw new Error('Référence introuvable');
      const fam = src.familyId || src.id;
      const nid = newId();
      const num = (v: string) => Number((v.match(/\d+/) ?? ['0'])[0]) || 0;
      const ver = `V${Math.max(0, ...db.products.filter((p) => (p.familyId || p.id) === fam).map((p) => num(p.version))) + 1}`;
      const copy: Product = { ...src, ...(input.champs as Partial<Product> ?? {}), id: nid, familyId: fam, version: ver, versionDate: new Date().toISOString().slice(0, 10), isCurrentVersion: true, components: src.components.map((c) => ({ ...c })), extraCosts: (src.extraCosts ?? []).map((x) => ({ ...x, id: newId() })) };
      const next: Database = { ...db, products: [...db.products.map((p) => ((p.familyId || p.id) === fam ? { ...p, isCurrentVersion: false } : p)), copy] };
      return { db: next, result: copy, summary: `nouvelle version ${ver} de « ${src.name} »` };
    }
    case 'cout': {
      const r = unitCost(String(input.productId), db);
      const p = db.products.find((x) => x.id === input.productId);
      const prices = db.marketPrices.filter((m) => m.productId === input.productId);
      return { db, result: r ? { produit: p?.name, coutUnitaireEur: r.costEur, base: r.basis, source: r.source, composants: r.components, manquants: r.missing, prixDeVente: prices } : { erreur: 'Aucun prix ni composition connus pour cette référence' }, summary: `coût de « ${p?.name ?? input.productId} »` };
    }
    case 'analyser_importation': {
      const p = db.projects.find((x) => x.id === input.projectId);
      if (!p) throw new Error('Importation introuvable');
      const pname = (id: string) => db.products.find((x) => x.id === id)?.name ?? id;
      const fname = (id: string | null) => (id ? db.factories.find((x) => x.id === id)?.name ?? id : 'assemblé en France');
      const orders = db.orders.filter((o) => o.projectId === p.id);
      const ships = db.shipments.filter((s) => s.projectId === p.id || s.orderIds.some((id) => orders.some((o) => o.id === id)));
      const needs = explodeNeeds(db, p.contents);
      const byFactory: Record<string, unknown[]> = {};
      for (const n of needs) {
        if (includedInParentPrice(db, n)) continue;
        const key = fname(n.factoryId);
        const price = n.factoryId ? factoryLinePrice(db, n.productId, n.factoryId) : null;
        (byFactory[key] ??= []).push({ produit: pname(n.productId), qty: n.qty, pour: n.forProductId !== n.productId ? pname(n.forProductId) : 'produit fini', prixUnitaireEur: price ? Math.round(price.eur * 100) / 100 : null, source: price?.source ?? 'inconnu' });
      }
      const fin = p.contents.length ? projectFinance(db, p) : null;
      const proposed = orders.length ? proposeContents(db, p).map((x) => ({ produit: pname(x.productId), qty: x.qty, type: x.kind, pourquoi: x.reason })) : [];
      const result = {
        importation: { id: p.id, nom: p.name, statut: p.status, conteneur: p.container, departVise: p.targetDate, description: p.description, notes: p.notes, groupageChez: p.consolidatorFactoryId ? fname(p.consolidatorFactoryId) : null },
        listeDeCourses: p.contents.map((l) => ({ produit: pname(l.productId), qty: l.qty })),
        contenuDeduitDesCommandes: proposed,
        besoinsParUsine: byFactory,
        commandes: orders.map((o) => ({ id: o.id, reference: o.reference, usine: fname(o.factoryId), date: o.date, statut: o.status, finProductionPrevue: o.expectedReadyDate, acomptePaye: o.depositPaid, soldePaye: o.balancePaid, totalEur: Math.round(orderTotalEur(o, db.settings)), lignes: o.lines.map((l) => `${l.qty} × ${l.isService ? (l.label || 'prestation') : pname(l.productId)} à ${l.unitPrice} ${l.currency}`) })),
        expeditions: ships.map((s) => ({ id: s.id, reference: s.reference, statut: s.status, mode: s.mode, incoterm: s.incoterm, transporteur: s.partnerId ? db.partners.find((x) => x.id === s.partnerId)?.name : null, etd: s.etd, eta: s.eta, conteneurOuSuivi: s.trackingRef, cbm: s.cbm, coutTotalEur: Math.round(shipmentTotalEur(s, db.settings)), emailsRattaches: db.mails.filter((m) => m.shipmentId === s.id).length })),
        analyseFinanciere: fin ? { coutMarchandiseEur: Math.round(fin.goodsEur), transportEur: Math.round(fin.transportEur), douaneEur: Math.round(fin.dutyEur), chiffreAffairesNetHtEur: Math.round(fin.revenueEur), beneficeSansTransportEur: Math.round(fin.profitNoTransportEur), beneficeAvecTransportEur: Math.round(fin.profitEur), margePct: fin.marginPct != null ? Math.round(fin.marginPct) : null, volumeM3: Math.round(fin.totalCbm * 10) / 10, sansPrixDeVente: fin.missingPrices.map((x) => x.name), coutInconnu: fin.missingCosts.map((x) => x.name), parMarchandise: fin.lines.map((l) => ({ produit: l.name, qty: l.qty, achatUnitaireEur: Math.round(l.goodsUnitEur * 100) / 100, transportUnitaireEur: Math.round(l.transportUnitEur * 100) / 100, venteHtUnitaireEur: l.sellHtEur != null ? Math.round(l.sellHtEur * 100) / 100 : null, beneficeEur: l.profitEur != null ? Math.round(l.profitEur) : null, margePct: l.marginPct != null ? Math.round(l.marginPct) : null })) } : 'liste de courses vide : pas d\'analyse possible',
        negociations: p.negotiations.map((n) => ({ usine: fname(n.factoryId), statut: n.status, lignes: n.lines.map((l) => `${pname(l.productId)} ×${l.qty} : dernier ${l.lastPrice ?? '?'} / cible ${l.targetPrice ?? '?'} / offert ${l.offeredPrice ?? '?'} / convenu ${l.agreedPrice ?? '?'} USD`) })),
      };
      return { db, result, summary: `analyse de l'importation « ${p.name} »` };
    }
    case 'expedition': {
      const s = db.shipments.find((x) => x.id === input.shipmentId);
      if (!s) throw new Error('Expédition introuvable');
      const mails = db.mails.filter((m) => m.shipmentId === s.id).sort((a, b) => b.date.localeCompare(a.date));
      const project = db.projects.find((p) => p.id === s.projectId);
      const result = {
        expedition: { id: s.id, reference: s.reference, statut: s.status, mode: s.mode, incoterm: s.incoterm, etd: s.etd, eta: s.eta, conteneurOuSuivi: s.trackingRef, cbm: s.cbm, poidsKg: s.weightKg, couts: { fret: s.freightCost, assurance: s.insuranceCost, fraisDepart: s.originFees, fraisArrivee: s.destinationFees, devise: s.currency, totalEur: Math.round(shipmentTotalEur(s, db.settings)) }, notes: s.notes },
        transporteur: s.partnerId ? db.partners.find((x) => x.id === s.partnerId)?.name : null,
        agent: s.agentId ? db.partners.find((x) => x.id === s.agentId)?.name : null,
        importation: project ? { id: project.id, nom: project.name } : null,
        commandes: db.orders.filter((o) => s.orderIds.includes(o.id)).map((o) => ({ reference: o.reference, usine: db.factories.find((f) => f.id === o.factoryId)?.name, statut: o.status })),
        emails: mails.slice(0, 8).map((m) => ({ id: m.id, date: m.date.slice(0, 10), de: m.fromName || m.from, objet: m.subject, extrait: m.text.slice(0, 600), piecesJointes: m.attachments.map((a) => a.filename), ceQueSuggereCetEmail: suggestShipmentUpdate(m, s) })),
        nbEmails: mails.length,
      };
      return { db, result, summary: `expédition « ${s.reference || s.id} »` };
    }
    case 'point_du_jour': {
      const today = new Date().toISOString().slice(0, 10);
      const days = (d: string) => (d ? Math.round((new Date(d).getTime() - new Date(today).getTime()) / 86400000) : null);
      const fname = (id: string | null) => (id ? db.factories.find((x) => x.id === id)?.name ?? id : '?');
      const result = {
        date: today,
        importations: db.projects.filter((p) => p.status !== 'archive').map((p) => { const f = p.contents.length ? projectFinance(db, p) : null; return { id: p.id, nom: p.name, statut: p.status, departVise: p.targetDate, beneficeEur: f ? Math.round(f.profitEur) : null, sansPrixDeVente: f?.missingPrices.length ?? 0 }; }),
        commandesEnCours: db.orders.filter((o) => !['livree', 'expediee'].includes(o.status)).map((o) => ({ id: o.id, reference: o.reference, usine: fname(o.factoryId), statut: o.status, finProductionPrevue: o.expectedReadyDate, dansNJours: days(o.expectedReadyDate), acomptePaye: o.depositPaid, soldePaye: o.balancePaid, importation: db.projects.find((p) => p.id === o.projectId)?.name ?? null })),
        expeditionsEnCours: db.shipments.filter((s) => s.status !== 'livree').map((s) => ({ id: s.id, reference: s.reference, statut: s.status, etd: s.etd, eta: s.eta, etaDansNJours: days(s.eta), retard: days(s.eta) != null && (days(s.eta) as number) < 0, transporteur: db.partners.find((x) => x.id === s.partnerId)?.name ?? null, importation: db.projects.find((p) => p.id === s.projectId)?.name ?? null })),
        emailsNonLus: db.mails.filter((m) => !m.read && !m.archived).slice(0, 10).map((m) => ({ id: m.id, date: m.date.slice(0, 10), de: m.fromName || m.from, objet: m.subject })),
        actionsAFaire: db.partners.flatMap((p) => p.insights.actions.filter((a) => !a.done).map((a) => ({ partenaire: p.name, action: a.text, echeance: a.dueDate }))),
        documentsAAnalyser: db.documents.filter((d) => !d.extracted).map((d) => d.fileName),
        negociationsEnCours: db.projects.flatMap((p) => p.negotiations.filter((n) => n.status === 'en_cours').map((n) => ({ importation: p.name, usine: fname(n.factoryId) }))),
      };
      return { db, result, summary: 'point du jour' };
    }
    case 'naviguer':
      return { db, result: { ok: true }, summary: `ouvre ${String(input.page)}`, navigate: { page: String(input.page), id: input.id ? String(input.id) : undefined } };
    default:
      throw new Error(`Outil inconnu : ${name}`);
  }
}

function singular(c: Collection): string {
  return ({ products: 'la référence', folders: 'le dossier', factories: "l'usine", contacts: 'le contact', partners: 'le partenaire', quotes: 'le prix', orders: 'la commande', shipments: "l'expédition", marketPrices: 'le prix de vente', drawings: 'le plan', documents: 'le document' } as Record<Collection, string>)[c];
}

export function contextLine(ctx: ChatContext): string {
  const pages: Record<string, string> = { dashboard: 'Tableau de bord', merchandise: 'Marchandise', factories: 'Usines', projects: 'Importations', logistics: 'Logistique', finance: 'Finance', documents: 'Documents', settings: 'Réglages' };
  return `[Contexte : l'utilisateur est sur la page ${pages[ctx.page] ?? ctx.page}${ctx.selectionLabel ? `, fiche ouverte : « ${ctx.selectionLabel} » (id ${ctx.id})` : ctx.id ? ` (id ${ctx.id})` : ''}]`;
}
