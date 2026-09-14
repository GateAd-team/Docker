/**
 * Accès à l'API du process principal (window.docker, injectée par le preload Electron).
 * Si elle est absente (ouverture dans un simple navigateur via `npm run dev:web`),
 * on bascule en mode démo : données d'exemple en mémoire / localStorage, lecture IA simulée.
 */
import { normalizeDatabase, type CloudStatus, type Database, type DockerApi, type DocumentRecord, type ExtractionResult } from '../shared/types';
import { seedDatabase } from './seed';

declare global {
  interface Window { docker?: DockerApi }
}

const LS_KEY = 'docker-demo-db';
const demoFiles = new Map<string, { mimeType: string; base64: string }>();

function demoExtraction(doc: DocumentRecord): ExtractionResult {
  const n = doc.fileName.toLowerCase();
  if (n.includes('packing') || n.includes('paking') || n.includes('colisage')) {
    return {
      kind: 'packing_list', confidence: 0.9, summary: 'Packing list Henan Decoout — 32 chariots, 32 colis, 31 m³, 1 280 kg brut.',
      data: { supplier: { name: 'Henan Decoout Technology Co., Ltd' }, reference: 'Q7-20260410', date: '2026-07-16', lines: [{ description: 'Chariot de transport Wall', model: '4900112', qty: 32, cartons: 32, pcsPerCarton: 1, cartonDimsCm: '110×66.5×202', netKg: 1152, grossKg: 1280, cbm: 31, hsCode: '8716800000' }], totals: { qty: 32, cartons: 32, netKg: 1152, grossKg: 1280, cbm: 31 } },
    };
  }
  if (n.includes('plan') || n.includes('wufix') || n.includes('drawing') || n.includes('dessin')) {
    return {
      kind: 'plan_technique', confidence: 0.85, summary: 'Plan technique : pièce de fixation en I, tôle aluminium 6082-T6 pliée ép. 3 mm, aile 150×40, profil U 42 mm.',
      data: { title: 'Fixation I — alu 42 mm', partName: 'Pièce de fixation en I', version: '', language: 'FR', material: 'Aluminium 6082-T6', thicknessMm: 3, overallDimensionsMm: '150 × 46 × 42', bom: [{ item: 'Pièce de fixation en I — tôle pliée', qty: 1, material: 'Aluminium 6082-T6' }], notes: 'Cotes en mm, tolérances ±0,5. Perçage Ø5, axe à 15 du bord.' },
    };
  }
  if (n.includes('proforma') || n.includes('proformat')) {
    return { kind: 'proforma', confidence: 0.9, summary: 'Proforma Yidartex YD260427 : tissu polyester, 14 931 USD FOB.', data: { supplier: { name: 'Anji Yidartex Weave Technology Co., Ltd', address: 'Northwest Industrial Park, Anji', city: 'Huzhou', province: 'Zhejiang', country: 'Chine', phone: '', email: '', wechat: '', contactName: '', website: '' }, buyer: { name: 'Wall Up', contactName: '' }, invoiceNumber: '', proformaNumber: 'YD260427', date: '2026-04-27', isProforma: true, currency: 'USD', incoterm: 'FOB', paymentTerms: '30 % acompte', leadTimeDays: 20, lines: [{ description: 'Fabric polyester 150gsm', productName: 'Tissu polyester 150 g/m² (au mètre)', model: 'PL-150', productDescription: 'Tissu polyester 150 g/m², laize 1,5 m, coloris anthracite.', material: 'Polyester', dimensions: '', color: 'Anthracite', qty: 5000, unit: 'm', unitPrice: 2.85, amount: 14250, hsCode: '5407.61', suggestedDutyRatePct: 8, unitWeightKg: 0.23, pcsPerCarton: 100, cartonCbm: 0.09, cartonDimsCm: '' }], extraCosts: [{ label: 'Frais de teinture', amount: 681 }], totalAmount: 14931, totalQty: 5000, bank: '' } };
  }
  if (n.includes('transport') || n.includes('freight') || n.includes('fret')) {
    return {
      kind: 'devis_transport', confidence: 0.8, summary: 'Devis fret maritime 40HQ Shenzhen → Le Havre : 4 200 USD + frais.',
      data: { forwarder: { name: 'Sino-Euro Freight', city: 'Shenzhen', phone: '', email: 'ops@sinoeuro-freight.example', wechat: '', contactName: '' }, mode: 'mer', incoterm: 'FOB', origin: 'Shenzhen', destination: 'Le Havre', containerNo: 'MSKU1234567', etd: '2026-08-28', eta: '2026-10-05', docType: 'booking', status: 'en_transit', date: '2026-08-20', validUntil: '2026-09-15', currency: 'USD', freightCost: 4200, originFees: 650, destinationFees: 1100, insuranceCost: 120, transitDays: 38, cbm: 67, weightKg: 3000, details: [] },
    };
  }
  if (doc.mimeType.startsWith('image/')) {
    return { kind: 'capture_ecran', confidence: 0.6, summary: "Capture d'écran : conversation WeChat avec un fournisseur, prix indicatif 26,10 USD/pc pour 300 pcs.", data: { text: 'Prix indicatif 26,10 USD/pc à partir de 300 pcs, délai 30 jours.', prices: [{ item: 'Grand cadre', price: 26.1, currency: 'USD' }], contacts: [] } };
  }
  return {
    kind: 'facture', confidence: 0.92, summary: 'Facture commerciale Foshan Vangarden n° 20260510-001 du 10/05/2026 : 456 cadres aluminium, 12 389,87 USD EXW.',
    data: {
      supplier: { name: 'Foshan Vangarden Furniture Co., Ltd', address: '3-No. 8, Guihe Road, Shitang Village, Lishui Town, Nanhai District', city: 'Foshan', province: 'Guangdong', country: 'Chine', phone: '', email: '', wechat: '', contactName: '', website: '' },
      buyer: { name: 'WallUp Paris', contactName: 'Arnaud Guiraudou' },
      invoiceNumber: '20260510-001', proformaNumber: '', date: '2026-05-10', isProforma: false, currency: 'USD', incoterm: 'EXW', paymentTerms: '', leadTimeDays: null,
      lines: [
        { description: 'Big Frame 2000mm x 1000mm x 40mm + black powder coating', productName: 'Grand cadre aluminium 2000×1000×40', model: 'BIG-FRAME', productDescription: 'Cadre en tube aluminium 20×40×1,2 mm, thermolaqué noir. Perçages Ø5 intérieur / Ø10 extérieur selon plan. Trois cadres intérieurs H640×W960, soudures planes pour insertion EPP.', material: 'Aluminium', dimensions: '2000 × 1000 × 40 mm', color: 'Noir', qty: 356, unit: 'pcs', unitPrice: 26.1, amount: 9291.6, hsCode: '7610.90', suggestedDutyRatePct: 6, unitWeightKg: 4, pcsPerCarton: 6, cartonCbm: 0.522, cartonDimsCm: '' },
        { description: 'Little Frame 2000mm x 500mm x 40mm + black powder coating', productName: 'Petit cadre aluminium 2000×500×40', model: 'LITTLE-FRAME', productDescription: 'Cadre en tube aluminium 20×40×1,2 mm, thermolaqué noir, perçages Ø5/Ø10. Cadres intérieurs H640×W460.', material: 'Aluminium', dimensions: '2000 × 500 × 40 mm', color: 'Noir', qty: 80, unit: 'pcs', unitPrice: 22.08, amount: 1766.79, hsCode: '7610.90', suggestedDutyRatePct: 6, unitWeightKg: 3, pcsPerCarton: 1, cartonCbm: 0.0435, cartonDimsCm: '' },
        { description: 'Magnetic Wallscable panel Frame 2000mm x 1000mm x 40mm', productName: 'Cadre panneau magnétique 2000×1000×40', model: 'MAG-FRAME', productDescription: 'Variante du grand cadre pour panneau magnétique, tube 20×40×1,2 mm thermolaqué noir.', material: 'Aluminium', dimensions: '2000 × 1000 × 40 mm', color: 'Noir', qty: 20, unit: 'pcs', unitPrice: 29.16, amount: 583.28, hsCode: '7610.90', suggestedDutyRatePct: 6, unitWeightKg: 4, pcsPerCarton: 2, cartonCbm: 0.428, cartonDimsCm: '' },
      ],
      extraCosts: [{ label: 'Installation', amount: 681 }, { label: 'Transport vers Kuo Ching', amount: 67.2 }],
      totalAmount: 12389.87, totalQty: 456, bank: '',
      packingList: { totals: { qty: 456, cartons: 10, netKg: 1744, grossKg: 1789.6, cbm: 36.08 }, lines: [] },
    },
  };
}

const demoCloud: CloudStatus = { ready: true, configured: false, user: new URLSearchParams(window.location.search).get('screen') === 'workspace' ? { id: 'demo', email: 'theo@wallup.fr', name: 'Théo' } : null, orgs: [], activeOrgId: '', members: [], version: 0, lastSync: '', syncing: false, error: '' };

const demoApi: DockerApi = {
  isDemo: true,
  async loadDb() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return normalizeDatabase(JSON.parse(raw) as Partial<Database>);
    } catch { /* ignore */ }
    return seedDatabase();
  },
  async saveDb(db) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch { /* ignore */ }
  },
  async importFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.accept = '.pdf,image/*';
      input.onchange = async () => {
        const files = Array.from(input.files ?? []);
        resolve(demoApi.importDropped(await Promise.all(files.map(fileToPayload))));
      };
      input.click();
    });
  },
  async importDropped(files) {
    return files.map((f) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      demoFiles.set(id, { mimeType: f.mimeType, base64: f.base64 });
      return {
        id, fileName: f.name, mimeType: f.mimeType, storedPath: `(démo) ${f.name}`, sizeBytes: Math.round(f.base64.length * 0.75),
        kind: 'autre', extracted: null, summary: '', linkedTo: [], createdAt: new Date().toISOString(),
      } satisfies DocumentRecord;
    });
  },
  async openDocument(id) {
    const f = demoFiles.get(id);
    if (f) window.open(`data:${f.mimeType};base64,${f.base64}`);
  },
  async readDocumentBase64(id) { return demoFiles.get(id) ?? null; },
  async extractDocument(id) {
    await new Promise((r) => setTimeout(r, 900));
    const db = await demoApi.loadDb();
    const doc = db.documents.find((d) => d.id === id);
    if (!doc) throw new Error('Document introuvable');
    return demoExtraction(doc);
  },
  async testApiKey() { return { ok: false, message: 'Mode démo : la lecture IA est simulée, aucune clé nécessaire.' }; },
  async mailTest() { return { ok: false, message: 'Mode démo : la connexion Gmail n\'est disponible que dans l\'application Docker.' }; },
  async mailConnectGoogle() { return { ok: false, message: 'Mode démo : la connexion Google n\'est disponible que dans l\'application Docker.' }; },
  async mailImportEml() { return []; },
  async mailLabels() { return ['Transporteurs', 'Usines', 'Douane']; },
  async mailAnalyze(mailIds) {
    await new Promise((r) => setTimeout(r, 900));
    return {
      overview: 'Le conteneur MSKU1234567 (40HQ Shenzhen → Le Havre) est en transit, ETA 5 octobre. Le transitaire attend les packing lists et factures des 3 fournisseurs pour le dédouanement : c\'est le point urgent. Côté agent, l\'inspection des housses chez Kuo Ching est faite (3 pièces rejetées).',
      partners: [
        { existingId: 'par-fwd', name: 'Sino-Euro Freight', type: 'transporteur', email: 'ops@sinoeuro-freight.example', phone: '', wechat: '', city: 'Shenzhen', services: 'Fret maritime FCL/LCL Chine → Le Havre, dédouanement import', contactName: 'Ops desk', contactRole: 'Opérations', summary: 'Transitaire du conteneur de septembre. Booking confirmé sur MSC (ETD 28/08, ETA 05/10), fret 4 200 USD + THC. Réactif, envoie les documents à temps. Demande les documents douaniers avant l\'arrivée.', actions: [{ text: 'Envoyer au courtier en douane les packing lists et factures commerciales des 3 fournisseurs', dueDate: '2026-10-01', mailId: 'demo:2' }], mailIds: mailIds.filter((id) => id !== 'demo:3') },
        { existingId: 'par-agent', name: 'Lily Sourcing', type: 'agent', email: 'lily@china-sourcing-agent.example', phone: '', wechat: 'lily_sourcing', city: 'Foshan', services: 'Inspection qualité avant chargement, suivi des usines', contactName: 'Lily', contactRole: 'Agent sourcing', summary: 'Inspection des 1 000 housses chez Kuo Ching réalisée : 3 rejetées pour couture. Photos envoyées.', actions: [{ text: 'Demander à Kuo Ching le remplacement des 3 housses rejetées avant chargement', dueDate: '', mailId: 'demo:3' }], mailIds: ['demo:3'] },
      ],
      shipments: [
        { existingId: 'shp-1', partnerName: 'Sino-Euro Freight', reference: 'FCL-2026-09 (40HQ)', containerNo: 'MSKU1234567', trackingRef: 'MSKU1234567', mode: 'mer', incoterm: 'FOB', origin: 'Shenzhen', destination: 'Le Havre', etd: '2026-08-28', eta: '2026-10-05', status: 'en_transit', cbm: null, weightKg: null, freightCost: 4200, insuranceCost: null, originFees: null, destinationFees: null, currency: 'USD', notes: 'Booking MSC confirmé. Documents douaniers attendus par le courtier.', mailIds: ['demo:1', 'demo:2'] },
      ],
    };
  },
  async mailSync() {
    const d = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
    return { scanned: 3, remaining: 0, messages: [
      { id: 'demo:1', uid: 1, mailbox: 'demo', date: d(12), from: 'ops@sinoeuro-freight.example', fromName: 'Sino-Euro Freight', to: 'contact@wallup.example', subject: 'Booking confirmation FCL 40HQ Shenzhen → Le Havre', text: 'Dear Théo,\nYour booking is confirmed on MSC for ETD 28 Aug, ETA Le Havre 5 Oct. Please find attached the booking confirmation and our invoice for freight 4200 USD + THC.\nBest regards,\nSino-Euro Freight', attachments: [{ index: 0, filename: 'booking-confirmation.pdf', mimeType: 'application/pdf', size: 84210, documentId: null }, { index: 1, filename: 'freight-invoice-0928.pdf', mimeType: 'application/pdf', size: 61200, documentId: null }], partnerId: null, shipmentId: null, read: false },
      { id: 'demo:2', uid: 2, mailbox: 'demo', date: d(4), from: 'ops@sinoeuro-freight.example', fromName: 'Sino-Euro Freight', to: 'contact@wallup.example', subject: 'RE: Container MSKU1234567 — customs clearance documents', text: 'Hi Théo, customs broker needs the packing list and commercial invoices of all 3 suppliers before arrival. ETA unchanged (5 Oct).', attachments: [], partnerId: null, shipmentId: null, read: false },
      { id: 'demo:3', uid: 3, mailbox: 'demo', date: d(40), from: 'lily@china-sourcing-agent.example', fromName: 'Lily (agent)', to: 'contact@wallup.example', subject: 'Inspection report Kuo Ching — covers', text: 'Inspection done today at Kuo Ching, 1000 covers OK, 3 rejected for stitching. Photos attached.', attachments: [{ index: 0, filename: 'inspection-photos.zip', mimeType: 'application/zip', size: 3400000, documentId: null }], partnerId: null, shipmentId: null, read: false },
    ] };
  },
  async mailAttachment() { return null; },
  async cloudStatus() { return demoCloud; },
  async cloudSignUp() { throw new Error('Mode démo : le compte n\'est disponible que dans l\'application Electron.'); },
  async cloudSignIn() { throw new Error('Mode démo : le compte n\'est disponible que dans l\'application Electron.'); },
  async cloudSignOut() { return demoCloud; },
  async cloudCreateOrg() { return demoCloud; },
  async cloudJoinOrg() { return demoCloud; },
  async cloudSelectOrg() { return demoCloud; },
  async cloudLeaveOrg() { return demoCloud; },
  async cloudRegenerateCode() { return demoCloud; },
  async cloudSyncNow() { return demoCloud; },
  onRemoteDb() { return () => undefined; },
  async chat(messages) {
    await new Promise((r) => setTimeout(r, 600));
    const last = messages[messages.length - 1]?.content ?? '';
    return { text: `Mode démo : l'assistant n'est pas connecté à Claude ici. Dans l'application Electron avec une clé API, je pourrais traiter « ${last.slice(0, 80)} » directement dans tes fiches.`, traces: [] };
  },
};

export async function fileToPayload(file: File): Promise<{ name: string; mimeType: string; base64: string }> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
  return { name: file.name, mimeType, base64: btoa(binary) };
}

export const api: DockerApi = window.docker ?? demoApi;
