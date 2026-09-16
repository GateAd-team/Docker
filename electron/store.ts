/**
 * Stockage local : un fichier JSON dans le dossier de données de l'application
 * (+ un sous-dossier "files" pour les documents importés).
 * Simple, lisible, sauvegardable. À remplacer par SQLite si le volume grossit.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { emptyDatabase, normalizeDatabase, type Database, type DocumentRecord } from '../src/shared/types';

let migrated = false;

export function dataDir(): string {
  const dir = path.join(app.getPath('userData'), 'docker-data');
  // Version installée (dossier "Bao") lancée pour la première fois sur un poste qui utilisait l'ancien nom
  // ("Docker") ou la version de développement (dossier "docker-import-manager") : on récupère les données existantes.
  if (!migrated) {
    migrated = true;
    if (!fs.existsSync(path.join(dir, 'database.json'))) {
      for (const name of ['Docker', 'docker-import-manager']) {
        const legacy = path.join(path.dirname(app.getPath('userData')), name, 'docker-data');
        if (!fs.existsSync(path.join(legacy, 'database.json'))) continue;
        try { fs.cpSync(legacy, dir, { recursive: true }); } catch (e) { console.error('Migration des données impossible', e); }
        break;
      }
    }
  }
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  return dir;
}

function dbPath(): string {
  return path.join(dataDir(), 'database.json');
}

export function loadDb(): Database {
  const p = dbPath();
  if (!fs.existsSync(p)) return emptyDatabase();
  try {
    return normalizeDatabase(JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<Database>);
  } catch (e) {
    // Fichier corrompu : on le met de côté plutôt que de l'écraser.
    fs.renameSync(p, `${p}.corrompu-${Date.now()}`);
    return emptyDatabase();
  }
}

export function saveDb(db: Database): void {
  const p = dbPath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, p); // écriture atomique
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
};

export function mimeFor(fileName: string, fallback = 'application/octet-stream'): string {
  return MIME_BY_EXT[path.extname(fileName).toLowerCase()] ?? fallback;
}

/** Copie un fichier dans le dossier de l'app et renvoie la fiche document (non encore lue par l'IA). */
export function storeFile(sourcePath: string, originalName?: string): DocumentRecord {
  const id = newId();
  const name = originalName ?? path.basename(sourcePath);
  const dest = path.join(dataDir(), 'files', `${id}${path.extname(name).toLowerCase()}`);
  fs.copyFileSync(sourcePath, dest);
  return recordFor(id, name, dest);
}

export function storeBuffer(name: string, mimeType: string, buffer: Buffer): DocumentRecord {
  const id = newId();
  const ext = path.extname(name) || (mimeType === 'application/pdf' ? '.pdf' : mimeType.startsWith('image/') ? `.${mimeType.split('/')[1]}` : '');
  const dest = path.join(dataDir(), 'files', `${id}${ext}`);
  fs.writeFileSync(dest, buffer);
  return recordFor(id, name, dest, mimeType);
}

function recordFor(id: string, name: string, dest: string, mimeType?: string): DocumentRecord {
  return {
    id,
    fileName: name,
    mimeType: mimeType ?? mimeFor(name),
    storedPath: dest,
    sizeBytes: fs.statSync(dest).size,
    kind: 'autre',
    extracted: null,
    summary: '',
    linkedTo: [],
    createdAt: new Date().toISOString(),
  };
}
