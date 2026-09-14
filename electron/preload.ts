import { contextBridge, ipcRenderer } from 'electron';
import type { Database, DockerApi } from '../src/shared/types';

const api: DockerApi = {
  isDemo: false,
  loadDb: () => ipcRenderer.invoke('db:load'),
  saveDb: (db: Database) => ipcRenderer.invoke('db:save', db),
  importFiles: () => ipcRenderer.invoke('files:import'),
  importDropped: (files) => ipcRenderer.invoke('files:importDropped', files),
  openDocument: (id) => ipcRenderer.invoke('files:open', id),
  readDocumentBase64: (id) => ipcRenderer.invoke('files:read', id),
  extractDocument: (id) => ipcRenderer.invoke('ai:extract', id),
  testApiKey: (key) => ipcRenderer.invoke('ai:testKey', key),
  chat: (messages, context) => ipcRenderer.invoke('ai:chat', messages, context),
  mailTest: (gmail) => ipcRenderer.invoke('mail:test', gmail),
  mailConnectGoogle: (clientId, clientSecret) => ipcRenderer.invoke('mail:connectGoogle', clientId, clientSecret),
  mailSync: (params) => ipcRenderer.invoke('mail:sync', params),
  mailAttachment: (mailId, index) => ipcRenderer.invoke('mail:attachment', mailId, index),
  mailImportEml: (files) => ipcRenderer.invoke('mail:importEml', files),
  mailLabels: () => ipcRenderer.invoke('mail:labels'),
  mailAnalyze: (mailIds) => ipcRenderer.invoke('mail:analyze', mailIds),
  cloudStatus: () => ipcRenderer.invoke('cloud:status'),
  cloudSignUp: (email, password, name) => ipcRenderer.invoke('cloud:signUp', email, password, name),
  cloudSignIn: (email, password) => ipcRenderer.invoke('cloud:signIn', email, password),
  cloudSignOut: () => ipcRenderer.invoke('cloud:signOut'),
  cloudCreateOrg: (name) => ipcRenderer.invoke('cloud:createOrg', name),
  cloudJoinOrg: (code) => ipcRenderer.invoke('cloud:joinOrg', code),
  cloudSelectOrg: (orgId) => ipcRenderer.invoke('cloud:selectOrg', orgId),
  cloudLeaveOrg: (orgId) => ipcRenderer.invoke('cloud:leaveOrg', orgId),
  cloudRegenerateCode: () => ipcRenderer.invoke('cloud:regenerateCode'),
  cloudSyncNow: () => ipcRenderer.invoke('cloud:syncNow'),
  onRemoteDb: (cb) => { const h = (_e: unknown, d: Database) => cb(d); ipcRenderer.on('db:remote', h); return () => ipcRenderer.removeListener('db:remote', h); },
};
// Statut cloud poussé par le principal (connexion, synchro en cours, erreurs) : écouté par Réglages.
contextBridge.exposeInMainWorld('dockerCloud', { onStatus: (cb: (s: unknown) => void) => { const h = (_e: unknown, s: unknown) => cb(s); ipcRenderer.on('cloud:status', h); return () => ipcRenderer.removeListener('cloud:status', h); } });

contextBridge.exposeInMainWorld('docker', api);
