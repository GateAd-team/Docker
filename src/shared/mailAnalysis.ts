/**
 * Analyse IA d'un lot d'emails transporteurs / agents : instructions et schéma de l'outil de réponse.
 * Partagé entre le process principal (appel API) et l'interface (revue des propositions).
 */
import type { Database, MailMessage, Shipment } from './types';

export const MAIL_ANALYSIS_SYSTEM = `Tu es l'assistant logistique de "Bao", un logiciel de gestion des importations depuis la Chine (société : Wall Up, France).
On te donne des emails échangés avec des transporteurs (freight forwarders), transitaires, agents de sourcing / contrôle qualité en Chine, leurs PIÈCES JOINTES PDF (devis de fret, booking, bill of lading, factures, packing lists, rapports d'inspection — lis-les en entier : c'est là que sont les prix, volumes, poids, numéros de conteneur, dates et statut du transit) et ce que Bao connaît déjà.
Ta mission : en extraire TOUTES les informations utiles, sans rien inventer, et répondre UNIQUEMENT via l'outil enregistrer_analyse_emails.

Règles :
- partners : un par société (pas par personne). Si elle correspond à un partenaire connu (même nom / même domaine d'email), renseigne existingId, sinon null. type : 'transporteur' (fret, transit, douane, livraison) ou 'agent' (sourcing, inspection, suivi d'usine, consolidation). Complète email, téléphone, WeChat, ville, services (ce qu'ils font, en français, court), contactName / contactRole (l'interlocuteur principal).
  summary : bilan en français (5 à 10 lignes) de la relation : ce qui a été fait, prix pratiqués, délais constatés, problèmes, ton de la relation.
  actions : ce que l'on attend de MOI ou ce que j'attends d'EUX (documents à envoyer, paiement, confirmation, relance…), avec dueDate (AAAA-MM-JJ) si une date est mentionnée sinon "", et mailId de l'email source.
  mailIds : les ids des emails qui concernent ce partenaire.
- shipments : une entrée par expédition / conteneur réellement évoquée (booking, B/L, numéro de conteneur, ETD/ETA, devis de fret accepté). existingId si elle correspond à une expédition connue (même n° de conteneur, de suivi, de booking ou de référence, ou même trajet à la même période) — IMPORTANT : ne crée JAMAIS de doublon ; si un email est déjà rattaché à une expédition Bao (« Expédition Bao : id »), c'est forcément celle-là (existingId). Une seule entrée par conteneur réel, en fusionnant les informations de tous les emails et PDF. reference : libellé court (ex. "FCL 40HQ Shenzhen → Le Havre sept. 2026"). Statut : planifiee (devis / booking pas parti), collectee (marchandise chez le transitaire), en_transit (parti), dedouanement, livree. Montants : nombres (null si inconnu), currency de l'email. FACTURES : si une facture de transport (PDF joint, ou montants détaillés dans l'email) est présente, reporte EXACTEMENT ses montants dans SA devise (freightCost = fret / ocean freight, originFees = frais au départ, destinationFees = frais à l'arrivée : THC, dédouanement, livraison, insuranceCost = assurance) et renseigne invoiceTotal = le total de la facture tel qu'imprimé (le total HT si TVA, sinon le total), invoiceRef = son numéro, invoiceCurrency = sa devise ; la somme freightCost + originFees + destinationFees + insuranceCost doit être égale à invoiceTotal (mets dans freightCost ce que tu ne sais pas classer). Une facture remplace toujours un devis ou une estimation antérieure. notes : n° B/L, navire, port, frais annexes, incidents.
- overview : 3 à 6 lignes en français, vue d'ensemble : où en est la logistique, ce qui presse.
- Dates au format AAAA-MM-JJ. Pas de texte en dehors de l'outil.`;

export const MAIL_ANALYSIS_TOOL = {
  name: 'enregistrer_analyse_emails',
  description: "Enregistre les transporteurs, agents, expéditions et actions extraits des emails.",
  input_schema: {
    type: 'object' as const,
    properties: {
      partners: { type: 'array', items: { type: 'object', properties: {
        existingId: { type: ['string', 'null'] }, name: { type: 'string' }, type: { type: 'string', enum: ['transporteur', 'agent'] },
        email: { type: 'string' }, phone: { type: 'string' }, wechat: { type: 'string' }, city: { type: 'string' }, services: { type: 'string' },
        contactName: { type: 'string' }, contactRole: { type: 'string' }, summary: { type: 'string' },
        actions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, dueDate: { type: 'string' }, mailId: { type: 'string' } }, required: ['text'] } },
        mailIds: { type: 'array', items: { type: 'string' } },
      }, required: ['name', 'type'] } },
      shipments: { type: 'array', items: { type: 'object', properties: {
        existingId: { type: ['string', 'null'] }, partnerName: { type: 'string' }, reference: { type: 'string' }, containerNo: { type: 'string' }, trackingRef: { type: 'string' },
        mode: { type: 'string', enum: ['mer', 'air', 'rail', 'express'] }, incoterm: { type: 'string', enum: ['EXW', 'FOB', 'CIF', 'DDP'] },
        origin: { type: 'string' }, destination: { type: 'string' }, etd: { type: 'string' }, eta: { type: 'string' },
        status: { type: 'string', enum: ['planifiee', 'collectee', 'en_transit', 'dedouanement', 'livree'] },
        cbm: { type: ['number', 'null'] }, weightKg: { type: ['number', 'null'] }, freightCost: { type: ['number', 'null'] }, insuranceCost: { type: ['number', 'null'] }, originFees: { type: ['number', 'null'] }, destinationFees: { type: ['number', 'null'] },
        currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'CNY'] }, notes: { type: 'string' }, mailIds: { type: 'array', items: { type: 'string' } },
        invoiceTotal: { type: ['number', 'null'], description: 'Total de la facture de transport, si une facture est présente' }, invoiceRef: { type: 'string' }, invoiceCurrency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'CNY'] },
      }, required: ['reference', 'status'] } },
      overview: { type: 'string' },
    },
    required: ['partners', 'shipments', 'overview'],
  },
};

/** Texte envoyé à l'IA : contexte connu + emails (tronqués). */
export function buildMailAnalysisPrompt(db: Pick<Database, 'partners' | 'shipments' | 'contacts'>, mails: MailMessage[]): string {
  const known = db.partners.map((p) => `- ${p.id} · ${p.name} (${p.type}) ${p.email || ''} ${p.city || ''}${db.contacts.filter((c) => c.ownerType === 'partner' && c.ownerId === p.id).map((c) => ` · contact ${c.name} ${c.email}`).join('')}`).join('\n') || '(aucun)';
  const ships = db.shipments.map((s) => `- ${s.id} · ${s.reference} · statut ${s.status} · suivi ${s.trackingRef || '—'} · ETD ${s.etd || '—'} ETA ${s.eta || '—'}${s.notes ? ` · ${s.notes.slice(0, 120)}` : ''}`).join('\n') || '(aucune)';
  const body = mails.map((m) => `=== EMAIL id=${m.id}\nDate : ${m.date.slice(0, 10)}\nDe : ${m.fromName} <${m.from}>\nÀ : ${m.to}\nObjet : ${m.subject}${m.shipmentId ? `\nExpédition Bao : ${m.shipmentId}` : ''}\nPièces jointes : ${m.attachments.map((a) => a.filename).join(', ') || 'aucune'}\n\n${m.text.slice(0, 5000)}`).join('\n\n');
  return `Partenaires déjà connus :\n${known}\n\nExpéditions déjà connues :\n${ships}\n\nEmails à analyser (${mails.length}) :\n\n${body}`;
}

/* ------------------------------------------------------------------------------------------------
 * Rattachement automatique email ↔ expédition et lecture du statut, sans IA (règles simples).
 * ---------------------------------------------------------------------------------------------- */

type ShipmentLike = { id: string; reference: string; trackingRef: string; status: 'planifiee' | 'collectee' | 'en_transit' | 'dedouanement' | 'livree'; etd: string; eta: string; notes: string };

const norm = (s: string) => s.toLowerCase().replace(/[\s\-_./]/g, '');

/** Trouve l'expédition dont le n° de conteneur / suivi / référence apparaît dans l'email. */
export function shipmentForMail(m: { subject: string; text: string }, shipments: ShipmentLike[]): string | null {
  const hay = norm(`${m.subject} ${m.text}`);
  const hits: { id: string; len: number }[] = [];
  for (const s of shipments) {
    const keys = [s.trackingRef, ...(s.notes.match(/\b[A-Z]{4}\s?\d{7}\b/g) ?? [])].map((k) => norm(k)).filter((k) => k.length >= 6);
    // La référence ne compte que si elle ressemble à un identifiant (pas une phrase)
    if (s.reference && /\d/.test(s.reference) && s.reference.length >= 6 && s.reference.length <= 30) keys.push(norm(s.reference));
    for (const k of keys) if (hay.includes(k)) hits.push({ id: s.id, len: k.length });
  }
  if (!hits.length) return null;
  return hits.sort((a, b) => b.len - a.len)[0].id;
}

const STATUS_ORDER: ShipmentLike['status'][] = ['planifiee', 'collectee', 'en_transit', 'dedouanement', 'livree'];
const STATUS_RULES: { status: ShipmentLike['status']; re: RegExp }[] = [
  { status: 'livree', re: /\b(delivered|livr[ée]e?s?\b|delivery (completed|done)|pod\b|proof of delivery|r[ée]ceptionn[ée])/i },
  { status: 'dedouanement', re: /\b(customs clearance|cleared customs|customs (hold|inspection|release)|d[ée]douan|arrived at (the )?(port|pod|le havre|marseille|fos|anvers|antwerp|rotterdam)|discharged|vessel (has )?arrived|arriv[ée]e? au port|import declaration|dap\b)/i },
  { status: 'en_transit', re: /\b(departed|sailed|on board|onboard|shipped on board|vessel (has )?(left|departed)|in transit|en transit|parti(e)? du port|has left|b\/?l (issued|released)|bill of lading (issued|released)|telex release|sea ?waybill)/i },
  { status: 'collectee', re: /\b(picked ?up|collected|received at (our )?warehouse|cargo received|goods received|gate[- ]?in|container (loaded|stuffed)|loading (completed|done)|marchandise (collect[ée]e|enlev[ée]e)|enl[èe]vement effectu[ée])/i },
];

const MONTHS: Record<string, number> = { jan: 1, janv: 1, feb: 2, fev: 2, fév: 2, mar: 3, mars: 3, apr: 4, avr: 4, may: 5, mai: 5, jun: 6, juin: 6, jul: 7, juil: 7, aug: 8, aou: 8, aoû: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, déc: 12 };
function parseDateNear(text: string, label: RegExp, refYear: number): string {
  const m = text.match(label);
  if (!m) return '';
  const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40);
  const pad = (n: number) => String(n).padStart(2, '0');
  let d: RegExpMatchArray | null;
  if ((d = after.match(/(\d{4})-(\d{2})-(\d{2})/))) return `${d[1]}-${d[2]}-${d[3]}`;
  if ((d = after.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/))) { const y = d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3]); return `${y}-${pad(Number(d[2]))}-${pad(Number(d[1]))}`; }
  if ((d = after.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-zéû]{3,5})\.?\s*(\d{4})?/i))) { const mo = MONTHS[d[2].toLowerCase()]; if (mo) return `${d[3] ? Number(d[3]) : refYear}-${pad(mo)}-${pad(Number(d[1]))}`; }
  if ((d = after.match(/([a-zéû]{3,5})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/i))) { const mo = MONTHS[d[1].toLowerCase()]; if (mo) return `${d[3] ? Number(d[3]) : refYear}-${pad(mo)}-${pad(Number(d[2]))}`; }
  return '';
}

export interface ShipmentUpdateSuggestion { status: ShipmentLike['status'] | null; etd: string; eta: string; evidence: string }

/** Ce qu'un email dit de l'expédition : nouveau statut (seulement s'il fait avancer), ETD / ETA lues dans le texte. */
export function suggestShipmentUpdate(m: { date: string; subject: string; text: string }, shipment: ShipmentLike): ShipmentUpdateSuggestion {
  const text = `${m.subject}\n${m.text}`;
  const year = Number(m.date.slice(0, 4)) || new Date().getFullYear();
  let status: ShipmentLike['status'] | null = null; let evidence = '';
  for (const r of STATUS_RULES) { const hit = text.match(r.re); if (hit) { if (STATUS_ORDER.indexOf(r.status) > STATUS_ORDER.indexOf(shipment.status)) { status = r.status; evidence = hit[0]; } break; } }
  const etd = parseDateNear(text, /\b(etd|estimated (time of )?departure|d[ée]part pr[ée]vu|departure date|sailing date|vessel departs?|d[ée]part le)\s*[:\-–]?\s*/i, year);
  const eta = parseDateNear(text, /\b(eta|estimated (time of )?arrival|arriv[ée]e pr[ée]vue|arrival date|arriving|arrival at [a-z ]+|arrivera le)\s*[:\-–]?\s*/i, year);
  return { status, etd: etd && etd !== shipment.etd ? etd : '', eta: eta && eta !== shipment.eta ? eta : '', evidence };
}

/**
 * Montants d'une expédition proposés par l'analyse d'emails. Si une facture est présente (invoiceTotal), ses montants
 * remplacent ce qui était connu (devis, estimation) et le total est forcé à celui de la facture ; sinon on complète
 * seulement les montants manquants.
 */
export function shipmentCostsFromAnalysis(
  current: Pick<Shipment, 'freightCost' | 'insuranceCost' | 'originFees' | 'destinationFees' | 'currency' | 'notes'>,
  sh: { freightCost?: number | null; insuranceCost?: number | null; originFees?: number | null; destinationFees?: number | null; currency?: Shipment['currency']; invoiceTotal?: number | null; invoiceRef?: string; invoiceCurrency?: Shipment['currency'] },
): Pick<Shipment, 'freightCost' | 'insuranceCost' | 'originFees' | 'destinationFees' | 'currency'> & { invoiceNote: string } {
  const n = (v: number | null | undefined) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  if (n(sh.invoiceTotal) > 0) {
    const total = n(sh.invoiceTotal);
    let freight = n(sh.freightCost), ins = n(sh.insuranceCost), org = n(sh.originFees), dst = n(sh.destinationFees);
    const others = ins + org + dst;
    if (Math.abs(freight + others - total) > 0.01) {
      if (others <= total) freight = Math.round((total - others) * 100) / 100;   // le fret absorbe l'écart
      else { freight = total; ins = 0; org = 0; dst = 0; }                        // détail incohérent : tout dans le fret
    }
    const invoiceNote = `Facture ${sh.invoiceRef || 'transport'} : ${total} ${sh.invoiceCurrency ?? sh.currency ?? current.currency}.`;
    return { freightCost: freight, insuranceCost: ins, originFees: org, destinationFees: dst, currency: sh.invoiceCurrency ?? sh.currency ?? current.currency, invoiceNote: current.notes.includes(invoiceNote) ? '' : invoiceNote };
  }
  const had = current.freightCost || current.insuranceCost || current.originFees || current.destinationFees;
  return {
    freightCost: current.freightCost || n(sh.freightCost), insuranceCost: current.insuranceCost || n(sh.insuranceCost),
    originFees: current.originFees || n(sh.originFees), destinationFees: current.destinationFees || n(sh.destinationFees),
    currency: had ? current.currency : (sh.currency ?? current.currency), invoiceNote: '',
  };
}

/* ------------------------------------------------------------------------------------------------
 * Doublons d'expéditions : détection et fusion.
 * ---------------------------------------------------------------------------------------------- */


const containerNos = (s: Shipment) => [s.trackingRef, ...(s.notes.match(/\b[A-Z]{4}\s?\d{7}\b/g) ?? []), ...(s.reference.match(/\b[A-Z]{4}\s?\d{7}\b/g) ?? [])].map(norm).filter((k) => k.length >= 6);

/** Paires d'expéditions qui parlent très probablement du même conteneur (même n° de conteneur / suivi, ou même référence). */
export function findDuplicateShipments(shipments: Shipment[]): [Shipment, Shipment][] {
  const out: [Shipment, Shipment][] = [];
  for (let i = 0; i < shipments.length; i++) for (let j = i + 1; j < shipments.length; j++) {
    const a = shipments[i], b = shipments[j];
    const ka = containerNos(a), kb = containerNos(b);
    const sameNo = ka.some((k) => kb.includes(k));
    const sameRef = !!a.reference && norm(a.reference) === norm(b.reference);
    if (sameNo || sameRef) out.push([a, b]);
  }
  return out;
}

const RANK: Shipment['status'][] = ['planifiee', 'collectee', 'en_transit', 'dedouanement', 'livree'];

/** Fusionne `other` dans `keep` : on garde les valeurs de `keep`, on complète avec celles de `other`, statut le plus avancé, commandes réunies. */
export function mergeShipments(keep: Shipment, other: Shipment): Shipment {
  const pick = <T,>(a: T, b: T, empty: T) => (a !== empty && a != null ? a : b);
  const notes = [keep.notes, other.notes].filter((n, i, arr) => n && arr.indexOf(n) === i && !(i === 1 && keep.notes.includes(n))).join('\n');
  return {
    ...keep,
    reference: pick(keep.reference, other.reference, ''),
    projectId: keep.projectId ?? other.projectId,
    orderIds: [...new Set([...keep.orderIds, ...other.orderIds])],
    partnerId: keep.partnerId ?? other.partnerId,
    agentId: keep.agentId ?? other.agentId,
    status: RANK.indexOf(other.status) > RANK.indexOf(keep.status) ? other.status : keep.status,
    etd: pick(keep.etd, other.etd, ''), eta: pick(keep.eta, other.eta, ''),
    cbm: pick(keep.cbm, other.cbm, 0), weightKg: pick(keep.weightKg, other.weightKg, 0),
    freightCost: pick(keep.freightCost, other.freightCost, 0), insuranceCost: pick(keep.insuranceCost, other.insuranceCost, 0),
    originFees: pick(keep.originFees, other.originFees, 0), destinationFees: pick(keep.destinationFees, other.destinationFees, 0),
    currency: keep.freightCost || keep.insuranceCost || keep.originFees || keep.destinationFees ? keep.currency : other.currency,
    trackingRef: pick(keep.trackingRef, other.trackingRef, ''),
    documentId: keep.documentId ?? other.documentId,
    notes,
  };
}

/** Applique la fusion dans la base : expéditions, emails et documents rattachés à `otherId` passent sur `keepId`. */
export function mergeShipmentsInDb<D extends { shipments: Shipment[]; mails: { shipmentId: string | null }[]; documents: { linkedTo: { type: string; id: string }[] }[] }>(d: D, keepId: string, otherId: string): D {
  const keep = d.shipments.find((s) => s.id === keepId), other = d.shipments.find((s) => s.id === otherId);
  if (!keep || !other || keepId === otherId) return d;
  const merged = mergeShipments(keep, other);
  return {
    ...d,
    shipments: d.shipments.filter((s) => s.id !== otherId).map((s) => (s.id === keepId ? merged : s)),
    mails: d.mails.map((m) => (m.shipmentId === otherId ? { ...m, shipmentId: keepId } : m)),
    documents: d.documents.map((doc) => ({ ...doc, linkedTo: doc.linkedTo.map((l) => (l.type === 'shipment' && l.id === otherId ? { ...l, id: keepId } : l)) })),
  };
}

/** Supprime une expédition proprement : les emails qui y étaient rattachés sont détachés. */
export function removeShipmentFromDb<D extends { shipments: Shipment[]; mails: { shipmentId: string | null }[] }>(d: D, id: string): D {
  return { ...d, shipments: d.shipments.filter((s) => s.id !== id), mails: d.mails.map((m) => (m.shipmentId === id ? { ...m, shipmentId: null } : m)) };
}
