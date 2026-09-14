import type { Order, Project, Shipment, Drawing } from '../shared/types';

export const PROJECT_STATUS: { value: Project['status']; label: string; tone: '' | 'blue' | 'green' | 'amber' | 'red' }[] = [
  { value: 'idee', label: 'En préparation', tone: '' },
  { value: 'rd', label: 'R&D', tone: 'blue' },
  { value: 'sourcing', label: 'Devis / commandes', tone: 'blue' },
  { value: 'production', label: 'En production', tone: 'amber' },
  { value: 'transport', label: 'En transit', tone: 'amber' },
  { value: 'vente', label: 'Livré', tone: 'green' },
  { value: 'archive', label: 'Archivé', tone: '' },
];

export const ORDER_STATUS: { value: Order['status']; label: string; tone: '' | 'blue' | 'green' | 'amber' | 'red' }[] = [
  { value: 'devis', label: 'Devis', tone: '' },
  { value: 'pi_recue', label: 'PI reçue', tone: 'blue' },
  { value: 'acompte_paye', label: 'Acompte payé', tone: 'blue' },
  { value: 'en_production', label: 'En production', tone: 'amber' },
  { value: 'prete', label: 'Prête', tone: 'amber' },
  { value: 'expediee', label: 'Expédiée', tone: 'green' },
  { value: 'livree', label: 'Livrée', tone: 'green' },
];

export const SHIPMENT_STATUS: { value: Shipment['status']; label: string; tone: '' | 'blue' | 'green' | 'amber' | 'red' }[] = [
  { value: 'planifiee', label: 'Planifiée', tone: '' },
  { value: 'collectee', label: 'Collectée', tone: 'blue' },
  { value: 'en_transit', label: 'En transit', tone: 'amber' },
  { value: 'dedouanement', label: 'Dédouanement', tone: 'amber' },
  { value: 'livree', label: 'Livrée', tone: 'green' },
];

export const DRAWING_STATUS: { value: Drawing['status']; label: string; tone: '' | 'blue' | 'green' | 'amber' | 'red' }[] = [
  { value: 'brouillon', label: 'Brouillon', tone: '' },
  { value: 'valide', label: 'Validé', tone: 'blue' },
  { value: 'envoye_usine', label: "Envoyé à l'usine", tone: 'amber' },
  { value: 'approuve_usine', label: "Approuvé par l'usine", tone: 'green' },
];

export const MODE_LABELS = { mer: 'Maritime', air: 'Aérien', rail: 'Ferroviaire', express: 'Express' } as const;
export const MARKET_LABELS = { FR: 'France', UK: 'Royaume-Uni', US: 'États-Unis' } as const;

export function statusOf<T extends string>(list: { value: T; label: string; tone: '' | 'blue' | 'green' | 'amber' | 'red' }[], v: T) {
  return list.find((x) => x.value === v) ?? { value: v, label: v, tone: '' as const };
}
