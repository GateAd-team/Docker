/**
 * Jeu de données d'exemple (inspiré de vrais documents d'importation Wall Up),
 * utilisé en mode démo (navigateur) et via "Charger l'exemple" dans Réglages.
 */
import { emptyDatabase, type Database } from '../shared/types';

export function seedDatabase(): Database {
  const db = emptyDatabase();
  const now = new Date().toISOString();

  db.projects.push(
    { id: 'proj-wall', name: 'Conteneur 40HQ — septembre 2026', description: 'Premier conteneur Wall : cadres (Vangarden) + chariots (Decoout), groupage chez Kuo Ching.', status: 'transport', targetDate: '2026-08-28', container: '40HQ', notes: '', flows: [
      { id: 'fl-1', fromFactoryId: 'fac-vangarden', to: 'fac-kuoching', lines: [{ productId: 'prod-bigframe', qty: 356 }, { productId: 'prod-smallframe', qty: 80 }], date: '2026-06-15', status: 'recu', note: 'Camion Vangarden → Kuo Ching (67,20 USD).' },
      { id: 'fl-2', fromFactoryId: 'fac-decoout', to: 'fac-kuoching', lines: [{ productId: 'prod-trolley', qty: 32 }], date: '2026-08-12', status: 'recu', note: '' },
      { id: 'fl-3', fromFactoryId: 'fac-kuoching', to: 'FR', lines: [{ productId: 'prod-bigframe', qty: 356 }, { productId: 'prod-smallframe', qty: 80 }, { productId: 'prod-trolley', qty: 32 }], date: '2026-08-28', status: 'envoye', note: 'Chargement 40HQ, départ Shenzhen.' },
    ], layout: {}, contents: [{ productId: 'prod-bigframe', qty: 356 }, { productId: 'prod-smallframe', qty: 80 }, { productId: 'prod-trolley', qty: 32 }], consolidatorFactoryId: 'fac-kuoching', docLinks: [], negotiations: [], createdAt: now, updatedAt: now },
    { id: 'proj-oct', name: 'Conteneur octobre 2026', description: 'Housses Kuo Ching + réassort fixations Onmuse.', status: 'production', targetDate: '2026-10-15', container: '40HQ', notes: 'Attendre la fin de production des housses avant de réserver.', flows: [
      { id: 'fl-4', fromFactoryId: 'fac-yidartex', to: 'fac-kuoching', lines: [{ productId: 'prod-fabric', qty: 2400 }], date: '2026-09-05', status: 'envoye', note: 'Rouleaux de tissu pour la confection des housses.' },
      { id: 'fl-5', fromFactoryId: 'fac-kuoching', to: 'FR', lines: [{ productId: 'prod-cover', qty: 1000 }], date: '2026-10-15', status: 'prevu', note: '' },
    ], layout: {}, contents: [{ productId: 'prod-wall-1m', qty: 200 }, { productId: 'prod-cover', qty: 1000 }], consolidatorFactoryId: 'fac-kuoching', docLinks: [], negotiations: [], createdAt: now, updatedAt: now },
  );

  db.folders.push(
    { id: 'fold-wall', name: 'Wall — modules', parentId: null },
    { id: 'fold-composants', name: 'Composants', parentId: null },
    { id: 'fold-housses', name: 'Housses', parentId: 'fold-composants' },
    { id: 'fold-fixations', name: 'Fixations', parentId: 'fold-composants' },
    { id: 'fold-accessoires', name: 'Accessoires', parentId: null },
  );

  const base = { description: '', familyId: '', version: 'V1', versionDate: '', versionNotes: '', isCurrentVersion: true, supplierName: '', folderId: null as string | null, factoryId: null as string | null, components: [] as Database['products'][number]['components'], componentsIncludedInPrice: false, extraCosts: [] as Database['products'][number]['extraCosts'], assemblyCostEur: 0 };
  const b = (productId: string, qty: number) => ({ productId, qty, role: 'base' as const, optionGroup: '', isDefault: false });
  const opt = (productId: string, qty: number, optionGroup: string, isDefault = false) => ({ productId, qty, role: 'option' as const, optionGroup, isDefault });
  db.products.push(
    { ...base, id: 'prod-wall-1m', projectId: null, isFinished: true, name: 'Wall 1 m', sku: 'WU-WALL-100', description: 'Module de cloison 1 m : plaque EPP habillée d\'une housse textile sur cadre aluminium.', hsCode: '9403.20', dutyRatePct: 0, unitWeightKg: 0, unitsPerCarton: 0, cartonCbm: 0, notes: 'Assemblé chez Kuo Ching (pose de la housse sur le cadre + EPP).', factoryId: 'fac-kuoching', extraCosts: [{ id: 'xc-1', label: 'Assemblage', amount: 10, currency: 'USD', amountEur: 9.2, note: 'Main-d\'œuvre Kuo Ching' }, { id: 'xc-2', label: 'Emballage carton', amount: 1.5, currency: 'EUR', amountEur: 1.5, note: '' }], components: [b('prod-epp', 1), b('prod-bigframe', 1), b('prod-fix-i', 4), opt('prod-cover', 1, 'Housse', true), opt('prod-cover-white', 1, 'Housse'), opt('prod-cover-m1', 1, 'Housse')], folderId: 'fold-wall' },
    { ...base, id: 'prod-epp', projectId: null, name: 'Plaque EPP 2000×1000×40', sku: 'WU-EPP-2010', supplierName: 'EPP board 2000*1000*40mm black', folderId: 'fold-composants', factoryId: 'fac-qianda', description: 'Mousse EPP densité 30 g/l, noire.', hsCode: '3921.11', dutyRatePct: 6.5, unitWeightKg: 2.4, unitsPerCarton: 10, cartonCbm: 0.85, notes: '' },
    { ...base, id: 'prod-bigframe', projectId: null, name: 'Grand cadre 2000×1000×40', sku: 'WU-FR-2010', supplierName: 'Big Frame 2000mm x 1000mm x 40mm + black powder coating', folderId: 'fold-composants', factoryId: 'fac-vangarden', description: 'Tube 20×40×1.2 mm, thermolaqué noir, perçages Ø5/Ø10.', hsCode: '7610.90', dutyRatePct: 6, unitWeightKg: 4, unitsPerCarton: 6, cartonCbm: 0.522, notes: '' },
    { ...base, id: 'prod-smallframe', projectId: null, name: 'Petit cadre 2000×500×40', sku: 'WU-FR-2005', supplierName: 'Little Frame 2000mm x 500mm x 40mm + black powder coating', folderId: 'fold-composants', factoryId: 'fac-vangarden', hsCode: '7610.90', dutyRatePct: 6, unitWeightKg: 3, unitsPerCarton: 1, cartonCbm: 0.0435, notes: '' },
    { ...base, id: 'prod-cover', projectId: null, name: 'Housse textile Wall 1 m — anthracite', sku: 'WU-CV-100', supplierName: 'Screen cover 2000x1000 dark grey', factoryId: 'fac-kuoching', description: 'Housse tendue, fermeture invisible, confectionnée par Kuo Ching.', hsCode: '6307.90', dutyRatePct: 6.3, unitWeightKg: 1.2, unitsPerCarton: 20, cartonCbm: 0.12, notes: '', components: [b('prod-fabric', 2.4)], folderId: 'fold-housses' },
    { ...base, id: 'prod-cover-white', projectId: null, folderId: 'fold-housses', name: 'Housse textile Wall 1 m — blanche', sku: 'WU-CV-100-W', factoryId: 'fac-kuoching', supplierName: 'Screen cover white 2000x1000', description: 'Même housse, coloris blanc.', hsCode: '6307.90', dutyRatePct: 6.3, unitWeightKg: 1.2, unitsPerCarton: 20, cartonCbm: 0.12, notes: '', components: [b('prod-fabric', 2.4)] },
    { ...base, id: 'prod-cover-m1', projectId: null, folderId: 'fold-housses', name: 'Housse textile Wall 1 m — M1 (traitement feu)', sku: 'WU-CV-100-M1', factoryId: 'fac-kuoching', supplierName: 'Screen cover fire retardant 2000x1000', description: 'Housse en tissu traité non feu classé M1, pour les salons et ERP.', hsCode: '6307.90', dutyRatePct: 6.3, unitWeightKg: 1.3, unitsPerCarton: 20, cartonCbm: 0.12, notes: '' },
    { ...base, id: 'prod-fabric', projectId: null, name: 'Tissu polyester 150 g/m² (au mètre)', sku: 'WU-TX-150', supplierName: 'Fabric polyester 150gsm', folderId: 'fold-composants', factoryId: 'fac-yidartex', description: 'Rouleau 1,5 m de laize, coloris anthracite.', hsCode: '5407.61', dutyRatePct: 8, unitWeightKg: 0.23, unitsPerCarton: 100, cartonCbm: 0.09, notes: 'Prix au mètre linéaire.' },
    { ...base, id: 'prod-trolley', projectId: null, isFinished: true, name: 'Chariot de transport Wall', sku: 'WU-TR-01', supplierName: 'Trolley-Bulk Order 4900112', folderId: 'fold-accessoires', factoryId: 'fac-decoout', description: 'Acier noir, 4 roues 10 cm, fond bois plastique.', hsCode: '8716.80', dutyRatePct: 1.7, unitWeightKg: 36, unitsPerCarton: 1, cartonCbm: 1.0, notes: '' },
    { ...base, id: 'prod-fix-i', projectId: null, name: 'Pièce de fixation en I', sku: 'WU-FIX-I', supplierName: 'I-type fixing bracket', folderId: 'fold-fixations', factoryId: 'fac-onmuse', description: 'Tôle pliée, 2 versions : acier ép. 2 / alu 6082-T6 ép. 3.', hsCode: '7326.90', dutyRatePct: 2.7, unitWeightKg: 0.15, unitsPerCarton: 200, cartonCbm: 0.03, notes: '' },
    { ...base, id: 'prod-fix-x', projectId: null, name: 'Pièce de fixation en X', sku: 'WU-FIX-X', supplierName: 'X-type fixing bracket', folderId: 'fold-fixations', factoryId: 'fac-onmuse', description: 'Plan en croix 198 mm, bouche centrale 42 mm.', hsCode: '7326.90', dutyRatePct: 2.7, unitWeightKg: 0.2, unitsPerCarton: 150, cartonCbm: 0.03, notes: '' },
  );

  db.products = db.products.map((p) => ({ ...p, familyId: (p as { familyId?: string }).familyId ?? p.id }));
  // Exemple de versions : le grand cadre a une V2 chez une autre usine.
  db.products.push({ ...db.products.find((p) => p.id === 'prod-bigframe')!, id: 'prod-bigframe-v2', familyId: 'prod-bigframe', version: 'V2', versionDate: '2026-08-01', versionNotes: 'Tube 20×40×1,5 mm (plus rigide), soudure TIG, passage chez Onmuse.', isCurrentVersion: true, factoryId: 'fac-onmuse', supplierName: 'Big Frame 2000x1000x40 1.5mm TIG' });
  db.products = db.products.map((p) => (p.id === 'prod-bigframe' ? { ...p, versionDate: '2026-02-12', versionNotes: 'Première version, tube 1,2 mm.', isCurrentVersion: false } : p));
  db.drawings.push(
    { id: 'dr-1', productId: 'prod-fix-i', version: 'V1', title: 'Fixation I — acier 42 mm', changelog: 'Première version, tôle acier pliée ép. 2 mm, perçage Ø5 axe à 15 du bord.', status: 'envoye_usine', documentId: null, createdAt: '2026-03-02T10:00:00Z' },
    { id: 'dr-2', productId: 'prod-fix-i', version: 'V2', title: 'Fixation I — aluminium 6082-T6 42 mm', changelog: 'Passage en aluminium 6082-T6, épaisseur 3 mm pour compenser la rigidité.', status: 'approuve_usine', documentId: null, createdAt: '2026-04-05T10:00:00Z' },
    { id: 'dr-3', productId: 'prod-fix-x', version: 'V1', title: 'Fixation X — acier 42 mm', changelog: 'Plan en croix, bras 40 mm, R5.', status: 'envoye_usine', documentId: null, createdAt: '2026-03-02T10:00:00Z' },
    { id: 'dr-4', productId: 'prod-fix-x', version: 'V2', title: 'Fixation X — aluminium 42 mm', changelog: 'Version aluminium ép. 3 mm, largeur totale 48 mm.', status: 'valide', documentId: null, createdAt: '2026-04-05T10:00:00Z' },
  );

  db.factories.push(
    { id: 'fac-vangarden', name: 'Foshan Vangarden Furniture Co., Ltd', city: 'Foshan', province: 'Guangdong', address: '3-No. 8, Guihe Road, Shitang Village, Lishui Town, Nanhai District', website: '', wechat: '', email: '', phone: '', specialties: 'Cadres aluminium thermolaqués, structures métalliques', rating: 4, comments: [{ id: 'fc-1', date: '2026-06-15', text: 'Cadres nickel, soudures propres, emballage soigné. Réactifs sur WeChat.', rating: 5 }, { id: 'fc-2', date: '2026-05-02', text: 'Premier échantillon avec 2 mm d\'écart sur le perçage, corrigé au 2e essai.', rating: 3 }], notes: 'Livre chez Kuo Ching pour le groupage.' },
    { id: 'fac-decoout', name: 'Henan Decoout Technology Co., Ltd', city: 'Zhengzhou', province: 'Henan', address: 'No. 2018-037, 2nd Floor, No. 73, Wenhua Road, Jinshui District', website: '', wechat: '', email: 'sales16@defaico.com', phone: '+86 133 2381 2647', specialties: 'Chariots, mobilier métallique', rating: 4, comments: [{ id: 'fc-3', date: '2026-08-12', text: 'Chariots solides mais 10 jours de retard sur la date annoncée.', rating: 3 }], notes: '' },
    { id: 'fac-qianda', name: 'Foshan Qianda Packaging Technology Co., Ltd', city: 'Foshan', province: 'Guangdong', address: "No.1 Ge'an Industrial Avenue, Lecong Town, Shunde District", website: '', wechat: '', email: 'topsun852@gmail.com', phone: '+86 159 1906 6330', specialties: 'Mousse EPP, emballage technique', rating: 3, comments: [], notes: '' },
    { id: 'fac-onmuse', name: 'Guangdong Onmuse Furniture Technology Co., Ltd', city: 'Zhaoqing', province: 'Guangdong', address: '2# No.1 Xinglong 3rd Street, Linjiang Industrial Park, Hi-Tech District', website: '', wechat: '', email: '', phone: '', specialties: 'Pièces métalliques, fixations', rating: 4, comments: [], notes: '' },
    { id: 'fac-yidartex', name: 'Anji Yidartex Weave Technology Co., Ltd', city: 'Huzhou', province: 'Zhejiang', address: 'Northwest Industrial Park, Anji Economic Development Area', website: '', wechat: '', email: '', phone: '', specialties: 'Tissus techniques, tissage', rating: 3, comments: [], notes: '' },
    { id: 'fac-kuoching', name: 'Foshan Kuo Ching Furniture Co., Ltd', city: 'Foshan', province: 'Guangdong', address: 'Qihang Avenue, Jiujiang Town, Nanhai District', website: '', wechat: '', email: '', phone: '+86 757 8651 8889', specialties: 'Housses textiles, confection', rating: 4, comments: [], notes: 'Point de groupage conteneur.' },
  );

  db.contacts.push(
    { id: 'ct-1', ownerType: 'factory', ownerId: 'fac-decoout', name: 'Iris Liu', role: 'Sales', email: 'sales16@defaico.com', phone: '+86 133 2381 2647', wechat: '', whatsapp: '' },
    { id: 'ct-2', ownerType: 'factory', ownerId: 'fac-onmuse', name: 'Frank', role: 'Sales', email: '', phone: '', wechat: '', whatsapp: '' },
    { id: 'ct-3', ownerType: 'partner', ownerId: 'par-agent', name: 'Lily Chen', role: 'Agent sourcing & QC', email: '', phone: '', wechat: 'lily_sourcing', whatsapp: '' },
  );

  db.partners.push(
    { id: 'par-fwd', type: 'transporteur', name: 'Sino-Euro Freight', city: 'Shenzhen', email: 'ops@sinoeuro-freight.example', phone: '', wechat: '', services: 'Fret maritime FCL/LCL Chine → Le Havre, dédouanement, livraison.', notes: '', insights: { summary: '', actions: [], analyzedAt: '' } },
    { id: 'par-agent', type: 'agent', name: 'Lily Sourcing', city: 'Foshan', email: '', phone: '', wechat: 'lily_sourcing', services: 'Suivi des usines, contrôle qualité avant chargement, consolidation.', notes: '', insights: { summary: '', actions: [], analyzedAt: '' } },
  );

  db.quotes.push(
    { id: 'q-1', productId: 'prod-bigframe', factoryId: 'fac-vangarden', date: '2026-02-12', unitPrice: 28.5, currency: 'USD', moq: 200, incoterm: 'EXW', leadTimeDays: 35, documentId: null, notes: 'Premier devis' },
    { id: 'q-2', productId: 'prod-bigframe', factoryId: 'fac-vangarden', date: '2026-05-10', unitPrice: 26.1, currency: 'USD', moq: 300, incoterm: 'EXW', leadTimeDays: 30, documentId: null, notes: 'Prix négocié sur la commande de 356 pcs' },
    { id: 'q-3', productId: 'prod-trolley', factoryId: 'fac-decoout', date: '2026-04-10', unitPrice: 171.6, currency: 'USD', moq: 20, incoterm: 'FOB', leadTimeDays: 25, documentId: null, notes: 'PI Q7-20260410' },
    { id: 'q-5', productId: 'prod-epp', factoryId: 'fac-qianda', date: '2026-05-29', unitPrice: 12.48, currency: 'USD', moq: 500, incoterm: 'FOB', leadTimeDays: 25, documentId: null, notes: 'Facture du 29/05' },
    { id: 'q-6', productId: 'prod-fabric', factoryId: 'fac-yidartex', date: '2026-04-27', unitPrice: 2.85, currency: 'USD', moq: 3000, incoterm: 'FOB', leadTimeDays: 20, documentId: null, notes: 'PI YD260427, prix au mètre' },
    { id: 'q-7', productId: 'prod-fix-i', factoryId: 'fac-onmuse', date: '2026-04-10', unitPrice: 0.95, currency: 'USD', moq: 2000, incoterm: 'FOB', leadTimeDays: 15, documentId: null, notes: 'Facture 260411' },
    { id: 'q-8', productId: 'prod-cover-m1', factoryId: 'fac-kuoching', date: '2026-08-06', unitPrice: 14.2, currency: 'USD', moq: 300, incoterm: 'FOB', leadTimeDays: 25, documentId: null, notes: 'Tissu M1' },
    { id: 'q-9', productId: 'prod-cover-white', factoryId: 'fac-kuoching', date: '2026-08-06', unitPrice: 8.76, currency: 'USD', moq: 500, incoterm: 'FOB', leadTimeDays: 20, documentId: null, notes: '' },
    { id: 'q-10', productId: 'prod-bigframe-v2', factoryId: 'fac-onmuse', date: '2026-08-01', unitPrice: 29.4, currency: 'USD', moq: 300, incoterm: 'FOB', leadTimeDays: 28, documentId: null, notes: 'V2 tube 1,5 mm' },
    { id: 'q-4', productId: 'prod-cover', factoryId: 'fac-kuoching', date: '2026-08-06', unitPrice: 8.76, currency: 'USD', moq: 500, incoterm: 'FOB', leadTimeDays: 20, documentId: null, notes: '' },
  );

  db.orders.push(
    {
      id: 'ord-1', projectId: 'proj-wall', factoryId: 'fac-vangarden', reference: '20260510-001', date: '2026-05-10', status: 'expediee',
      lines: [
        { productId: 'prod-bigframe', qty: 356, unitPrice: 26.1, currency: 'USD' },
        { productId: 'prod-smallframe', qty: 80, unitPrice: 22.08, currency: 'USD' },
      ],
      depositPct: 30, depositPaid: true, balancePaid: true, productionDays: 30, expectedReadyDate: '2026-06-12', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null,
      notes: 'Frais supplémentaires : installation 681 USD, transport vers Kuo Ching 67,20 USD. 456 pcs / 10 colis / 36,08 m³.',
    },
    {
      id: 'ord-2', projectId: 'proj-wall', factoryId: 'fac-decoout', reference: 'Q7-20260410', date: '2026-07-16', status: 'expediee',
      lines: [{ productId: 'prod-trolley', qty: 32, unitPrice: 171.6, currency: 'USD' }],
      depositPct: 30, depositPaid: true, balancePaid: true, productionDays: 25, expectedReadyDate: '2026-08-10', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null,
      notes: '32 colis, 110×66.5×202 cm, 31 m³.',
    },
    {
      id: 'ord-3', projectId: 'proj-oct', factoryId: 'fac-kuoching', reference: '20260806', date: '2026-08-06', status: 'en_production',
      lines: [{ productId: 'prod-cover', qty: 1000, unitPrice: 8.76, currency: 'USD' }],
      depositPct: 30, depositPaid: true, balancePaid: false, productionDays: 20, expectedReadyDate: '2026-09-20', invoiceDocumentId: null, proformaDocumentId: null, packingListDocumentId: null, notes: 'Complète le conteneur.',
    },
  );

  db.shipments.push({
    id: 'shp-1', projectId: 'proj-wall', reference: 'FCL-2026-09 (40HQ)', orderIds: ['ord-1', 'ord-2'], partnerId: 'par-fwd', agentId: 'par-agent', mode: 'mer', incoterm: 'FOB',
    status: 'en_transit', etd: '2026-08-28', eta: '2026-10-05', cbm: 67, weightKg: 3000,
    freightCost: 4200, insuranceCost: 120, originFees: 650, destinationFees: 1100, currency: 'USD', trackingRef: 'MSKU1234567', documentId: null, notes: 'Groupage Kuo Ching → Le Havre.',
  });

  db.marketPrices.push(
    { id: 'mp-0', productId: 'prod-wall-1m', market: 'FR', sellPrice: 390, currency: 'EUR', vatPct: 20, platformFeePct: 0, lastMileCost: 25, date: '2026-06-01' },
    { id: 'mp-1', productId: 'prod-bigframe', market: 'FR', sellPrice: 149, currency: 'EUR', vatPct: 20, platformFeePct: 3, lastMileCost: 12, date: '2026-06-01' },
    { id: 'mp-2', productId: 'prod-bigframe', market: 'UK', sellPrice: 139, currency: 'GBP', vatPct: 20, platformFeePct: 12, lastMileCost: 14, date: '2026-06-01' },
    { id: 'mp-3', productId: 'prod-bigframe', market: 'US', sellPrice: 179, currency: 'USD', vatPct: 0, platformFeePct: 15, lastMileCost: 18, date: '2026-06-01' },
    { id: 'mp-4', productId: 'prod-trolley', market: 'FR', sellPrice: 590, currency: 'EUR', vatPct: 20, platformFeePct: 3, lastMileCost: 45, date: '2026-06-01' },
  );

  return db;
}
