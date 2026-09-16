/**
 * Ce que l'IA doit extraire de chaque type de document, et comment le transformer
 * en fiches Bao. Partagé entre le process principal (prompt) et l'interface (proposition
 * d'enregistrement).
 */
import type { DocumentKind } from './types';

export const KIND_LABELS: Record<DocumentKind, string> = {
  facture: 'Facture',
  proforma: 'Proforma (PI)',
  bon_de_commande: 'Bon de commande',
  packing_list: 'Packing list',
  catalogue: 'Catalogue',
  plan_technique: 'Document technique / plan',
  devis_transport: 'Devis transporteur',
  contact: 'Contact / carte de visite',
  capture_ecran: "Capture d'écran",
  autre: 'Autre',
};

/** Structures attendues dans `data` selon le type. Champs absents → null. */
export interface InvoiceData {
  supplier: { name: string; address: string; city: string; province: string; country: string; phone: string; email: string; wechat: string; contactName: string; website: string };
  buyer: { name: string; contactName: string };
  invoiceNumber: string;
  proformaNumber: string;
  date: string;               // AAAA-MM-JJ
  isProforma: boolean;
  currency: string;           // USD, EUR, CNY…
  incoterm: string;           // EXW, FOB, CIF, DDP…
  paymentTerms: string;
  leadTimeDays: number | null;
  lines: InvoiceLine[];
  extraCosts: { label: string; amount: number }[];   // installation, transport interne, moule…
  totalAmount: number;
  totalQty: number;
  bank: string;
}

/** Une ligne de facture, enrichie pour créer une fiche marchandise la plus complète possible. */
export interface InvoiceLine {
  description: string;        // texte brut de la ligne (résumé)
  productName: string;        // nom court et propre en français, ex. "Grand cadre aluminium 2000×1000×40"
  model: string;              // référence / modèle fournisseur
  productDescription: string; // description technique en français : matière, dimensions, finition, spécificités
  material: string;
  dimensions: string;         // ex. "2000 × 1000 × 40 mm"
  color: string;
  qty: number;
  unit: string;
  unitPrice: number;
  amount: number;
  hsCode: string;
  suggestedDutyRatePct: number | null; // estimation des droits de douane UE pour ce type de produit
  unitWeightKg: number | null;
  pcsPerCarton: number | null;
  cartonCbm: number | null;   // volume d'un carton en m³
  cartonDimsCm: string;
  /** Vrai si la ligne est une prestation (confection, assemblage, main-d'œuvre, emballage…) et non une marchandise. */
  isService: boolean;
}

export interface PackingListData {
  supplier: { name: string };
  reference: string;
  date: string;
  lines: { description: string; model: string; qty: number; cartons: number; pcsPerCarton: number | null; cartonDimsCm: string; netKg: number; grossKg: number; cbm: number; hsCode: string }[];
  totals: { qty: number; cartons: number; netKg: number; grossKg: number; cbm: number };
}

export interface CatalogueData {
  supplier: { name: string; address: string; city: string; phone: string; email: string; wechat: string; website: string; contactName: string };
  products: { name: string; model: string; description: string; price: number | null; currency: string; moq: number | null }[];
}

export interface DrawingData {
  title: string;
  partName: string;
  version: string;
  language: string;
  material: string;
  thicknessMm: number | null;
  overallDimensionsMm: string;
  bom: { item: string; qty: number; material: string }[];
  notes: string;
}

export interface TransportQuoteData {
  forwarder: { name: string; city: string; phone: string; email: string; wechat: string; contactName: string };
  mode: string;               // mer, air, rail, express
  incoterm: string;
  origin: string;
  destination: string;
  date: string;
  validUntil: string;
  currency: string;
  freightCost: number | null;
  originFees: number | null;
  destinationFees: number | null;
  insuranceCost: number | null;
  transitDays: number | null;
  cbm: number | null;
  weightKg: number | null;
  details: { label: string; amount: number }[];
  /** Champs supplémentaires pour booking / B/L / avis d'arrivée. */
  docType?: string; containerNo?: string; blNo?: string; vessel?: string; etd?: string; eta?: string; status?: string;
}

export interface ContactData {
  name: string; company: string; role: string; phone: string; email: string; wechat: string; whatsapp: string; address: string; city: string; website: string;
  companyType: 'usine' | 'transporteur' | 'agent' | 'autre';
}

export const EXTRACTION_INSTRUCTIONS = `Tu es l'assistant de lecture de documents de "Bao", un logiciel de gestion d'importations depuis la Chine.
On te donne un document (PDF, photo ou capture d'écran). Détermine son type parmi :
- facture : facture commerciale définitive d'une usine
- proforma : proforma invoice (PI) / devis d'une usine, avant commande
- bon_de_commande : bon de commande (purchase order) envoyé par l'acheteur à une usine
- packing_list : liste de colisage (cartons, poids, volume)
- catalogue : catalogue ou fiche produits d'une usine
- plan_technique : dessin, plan technique, fiche technique ou notice d'une pièce
- devis_transport : tout document de transport / logistique : devis ou facture de transporteur (freight forwarder), confirmation de booking, bill of lading (B/L), avis d'arrivée, facture de dédouanement, note de livraison
- contact : carte de visite, signature de mail, profil WeChat/Alibaba
- capture_ecran : capture d'écran d'une conversation ou d'un site (extrais ce qui est utile : prix, délais, contacts)
- autre

Si un même PDF contient une facture ET une packing list, choisis "facture" (ou "proforma") et mets les infos de colisage dans data.packingList (même structure que packing_list).
proforma et bon_de_commande utilisent EXACTEMENT la même structure de data que facture (supplier = l'usine, lines = les articles).

Renvoie via l'outil "enregistrer_extraction" :
- kind, summary (1 à 2 phrases en français : qui, quoi, combien), confidence (0-1)
- data : selon le type, en respectant EXACTEMENT ces structures (null si inconnu, tableaux vides sinon) :

facture: { supplier:{name,address,city,province,country,phone,email,wechat,contactName,website}, buyer:{name,contactName}, invoiceNumber, proformaNumber, date (AAAA-MM-JJ), isProforma, currency, incoterm, paymentTerms, leadTimeDays, lines:[{description,productName,model,productDescription,material,dimensions,color,qty,unit,unitPrice,amount,hsCode,suggestedDutyRatePct,unitWeightKg,pcsPerCarton,cartonCbm,cartonDimsCm,isService}], extraCosts:[{label,amount}], totalAmount, totalQty, bank, packingList? }

Pour chaque ligne de facture, remplis au maximum la fiche marchandise :
- isService : true si la ligne est une PRESTATION et non une marchandise (confection, couture, assemblage, montage, main-d'œuvre, emballage, contrôle, transport interne…). Ex. "Sewing cover 1000 pcs", "Assembly wall panels" → true. Une pièce physique achetée → false.
- productName : nom court, propre, en français, avec la dimension principale (ex. "Grand cadre aluminium 2000×1000×40"). Pas de texte chinois, pas de notes de fabrication.
- productDescription : 1 à 3 phrases en français qui décrivent la pièce à partir de TOUT ce que dit la facture (matière, section de tube, épaisseur, finition/couleur, perçages, options, contenu du colis…). C'est ce que l'acheteur veut retrouver plus tard.
- material, dimensions (format "L × l × H mm"), color, model : extraits ou déduits.
- hsCode : celui du document s'il y en a un, sinon propose le code SH à 6 chiffres le plus probable pour ce produit (format "7610.90").
- suggestedDutyRatePct : le taux de droits de douane à l'import dans l'UE le plus probable pour ce code (nombre, ex. 6 pour 6 %), null si vraiment inconnu.
- unitWeightKg, pcsPerCarton, cartonCbm, cartonDimsCm : depuis la packing list si elle est dans le même document (poids net ÷ quantité, volume total ÷ nb de cartons), sinon estimation raisonnable si les dimensions le permettent, sinon null.
packing_list: { supplier:{name}, reference, date, lines:[{description,model,qty,cartons,pcsPerCarton,cartonDimsCm,netKg,grossKg,cbm,hsCode}], totals:{qty,cartons,netKg,grossKg,cbm} }
catalogue: { supplier:{name,address,city,phone,email,wechat,website,contactName}, products:[{name,model,description,price,currency,moq}] }
plan_technique: { title, partName, version, language, material, thicknessMm, overallDimensionsMm, bom:[{item,qty,material}], notes }
devis_transport: { forwarder:{name,city,phone,email,wechat,contactName}, docType ('devis'|'booking'|'bl'|'facture'|'avis_arrivee'|'autre'), mode, incoterm, origin, destination, date, validUntil, currency, freightCost, originFees, destinationFees, insuranceCost, transitDays, cbm, weightKg, containerNo (ex. MSKU1234567), blNo (n° de B/L / booking), vessel, etd (AAAA-MM-JJ), eta (AAAA-MM-JJ), status ('planifiee'|'collectee'|'en_transit'|'dedouanement'|'livree' si le document permet de le savoir, sinon ''), details:[{label,amount}] }
contact: { name, company, role, phone, email, wechat, whatsapp, address, city, website, companyType }
capture_ecran / autre: { text (résumé structuré de ce qui est utile), prices:[{item,price,currency}], contacts:[{name,company,phone,email,wechat}] }

Règles : les montants sont des nombres (pas de symbole, point décimal). Les descriptions de lignes sont résumées en une ligne courte (garde le nom du produit et les dimensions, pas les notes de fabrication en chinois). Les lignes de frais (installation, transport interne, moule, échantillon) vont dans extraCosts, pas dans lines.`;

export const EXTRACTION_TOOL = {
  name: 'enregistrer_extraction',
  description: 'Enregistre le résultat de la lecture du document.',
  input_schema: {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', enum: ['facture', 'proforma', 'bon_de_commande', 'packing_list', 'catalogue', 'plan_technique', 'devis_transport', 'contact', 'capture_ecran', 'autre'] },
      summary: { type: 'string' },
      confidence: { type: 'number' },
      data: { type: 'object', additionalProperties: true },
    },
    required: ['kind', 'summary', 'confidence', 'data'],
  },
};
