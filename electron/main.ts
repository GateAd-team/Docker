import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { loadDb, saveDb, storeFile, storeBuffer } from './store';
import { analyzeMails, chat, extractDocument, testApiKey } from './ai';
import { connectGoogle, fetchAttachment, importEml, listLabels, syncMail, testMail } from './mail';
import { Cloud } from './cloud';
import { Updater } from './updater';
import type { CloudStatus, Database } from '../src/shared/types';

let db: Database;
let win: BrowserWindow | null = null;
const send = (channel: string, payload: unknown) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload); };
const cloud = new Cloud(
  {
    getDb: () => db,
    setDb: (next, fromRemote) => { db = next; saveDb(db); if (fromRemote) send('db:remote', db); },
  },
  (s: CloudStatus) => send('cloud:status', s),
);

/** Icône de l'application (bateau à l'encre de Chine) : build/icon.png en développement, ressources de l'app une fois empaquetée. */
function iconPath(): string | undefined {
  for (const c of [path.join(__dirname, '../../build/icon.png'), path.join(process.resourcesPath ?? '', 'build/icon.png'), path.join(app.getAppPath(), 'build/icon.png')]) if (fs.existsSync(c)) return c;
  return undefined;
}

function createWindow() {
  const icon = iconPath();
  if (process.platform === 'darwin' && icon && app.dock) app.dock.setIcon(icon);
  win = new BrowserWindow({
    icon,
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    title: 'Bao',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true, // lecteur PDF interne de Chromium (utilisé par « Ouvrir avec… » et en secours)
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

app.whenReady().then(() => {
  db = loadDb();

  ipcMain.handle('db:load', () => db);
  ipcMain.handle('db:save', (_e, next: Database) => { db = next; saveDb(db); cloud.scheduleSync(); });
  cloud.configure().catch(() => undefined);
  // Taux de change : mise à jour automatique à chaque ouverture (sauf si désactivé dans Réglages).
  if (db.settings.fxAuto !== false) fetchRates().then((r) => {
    if (!r) return;
    db = { ...db, settings: { ...db.settings, fxToEur: { ...db.settings.fxToEur, ...r.rates }, fxUpdatedAt: r.date } };
    saveDb(db); send('db:remote', db); cloud.scheduleSync();
  }).catch(() => undefined);

  ipcMain.handle('cloud:status', () => cloud.getStatus());
  ipcMain.handle('cloud:signUp', (_e, email: string, password: string, name: string) => cloud.signUp(email, password, name));
  ipcMain.handle('cloud:signIn', (_e, email: string, password: string) => cloud.signIn(email, password));
  ipcMain.handle('cloud:signOut', () => cloud.signOut());
  ipcMain.handle('cloud:createOrg', (_e, name: string) => cloud.createOrg(name));
  ipcMain.handle('cloud:joinOrg', (_e, code: string) => cloud.joinOrg(code));
  ipcMain.handle('cloud:selectOrg', (_e, orgId: string) => cloud.selectOrg(orgId));
  ipcMain.handle('cloud:leaveOrg', (_e, orgId: string) => cloud.leaveOrg(orgId));
  ipcMain.handle('cloud:regenerateCode', () => cloud.regenerateCode());
  ipcMain.handle('cloud:updateAccount', (_e, patch) => cloud.updateAccount(patch));
  ipcMain.handle('fx:fetch', () => fetchRates());
  const updater = new Updater((s) => send('update:status', s));
  ipcMain.handle('update:status', () => updater.get());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('cloud:syncNow', async () => { await cloud.sync(); return cloud.getStatus(); });
  ipcMain.handle('cloud:pushLocal', async () => { await cloud.pushLocal(); return cloud.getStatus(); });

  ipcMain.handle('files:import', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Importer des documents',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (res.canceled) return [];
    return res.filePaths.map((p) => storeFile(p));
  });

  ipcMain.handle('files:importDropped', (_e, files: { name: string; mimeType: string; base64: string }[]) =>
    files.map((f) => storeBuffer(f.name, f.mimeType, Buffer.from(f.base64, 'base64'))),
  );

  ipcMain.handle('files:open', async (_e, id: string) => {
    const doc = db.documents.find((d) => d.id === id);
    const p = doc ? await cloud.ensureLocalFile(doc) : null;
    if (p) shell.openPath(p);
  });

  ipcMain.handle('files:read', async (_e, id: string) => {
    const doc = db.documents.find((d) => d.id === id);
    const p = doc ? await cloud.ensureLocalFile(doc) : null;
    if (!doc || !p) return null;
    return { mimeType: doc.mimeType, base64: fs.readFileSync(p).toString('base64') };
  });

  ipcMain.handle('ai:extract', async (_e, id: string) => {
    const doc = db.documents.find((d) => d.id === id);
    if (!doc) throw new Error('Document introuvable.');
    const p = await cloud.ensureLocalFile(doc);
    if (!p) throw new Error('Fichier introuvable sur ce poste (pas encore synchronisé ?).');
    return extractDocument({ ...doc, storedPath: p }, db.settings);
  });

  ipcMain.handle('ai:testKey', (_e, key: string) => testApiKey(key, db.settings.model));

  ipcMain.handle('ai:chat', async (_e, messages, context) => {
    const r = await chat(messages, context, db);
    if (r.db !== db) { db = r.db; saveDb(db); }
    return { text: r.text, traces: r.traces, navigate: r.navigate };
  });

  ipcMain.handle('mail:test', (_e, gmail) => testMail(gmail));
  ipcMain.handle('mail:connectGoogle', (_e, clientId: string, clientSecret: string) => connectGoogle(clientId, clientSecret));
  ipcMain.handle('mail:sync', (_e, params) => syncMail(db.settings.gmail, params));
  ipcMain.handle('mail:attachment', (_e, mailId: string, index: number) => fetchAttachment(db.settings.gmail, mailId, index));
  ipcMain.handle('mail:importEml', (_e, files) => importEml(files));
  ipcMain.handle('mail:labels', () => listLabels(db.settings.gmail));
  ipcMain.handle('mail:analyze', async (_e, mailIds: string[]) => {
    const mails = db.mails.filter((m) => mailIds.includes(m.id));
    // Pièces jointes déjà importées mais absentes de ce poste : on les récupère du serveur avant l'analyse.
    for (const m of mails) for (const a of m.attachments) { const doc = a.documentId ? db.documents.find((d) => d.id === a.documentId) : null; if (doc) await cloud.ensureLocalFile(doc); }
    return analyzeMails(mails, db, (mailId, index) => fetchAttachment(db.settings.gmail, mailId, index));
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/** Taux de change du jour (Banque centrale européenne via frankfurter.app) : EUR pour 1 unité de devise. */
async function fetchRates(): Promise<{ rates: Partial<Record<'USD' | 'GBP' | 'CNY', number>>; date: string } | null> {
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD,GBP,CNY');
    if (!r.ok) return null;
    const j = (await r.json()) as { date: string; rates: Record<string, number> };
    const rates: Partial<Record<'USD' | 'GBP' | 'CNY', number>> = {};
    for (const [k, v] of Object.entries(j.rates)) if (v > 0) rates[k as 'USD'] = Math.round((1 / v) * 10000) / 10000;
    return { rates, date: j.date };
  } catch { return null; }
}
