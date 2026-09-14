/**
 * Compte & synchronisation (Supabase) : connexion, organisations (espace partagé entre plusieurs utilisateurs),
 * synchronisation de la base (fusion à trois voies, verrouillage optimiste, temps réel) et des fichiers.
 * Tout passe par le process principal ; le renderer ne voit que `CloudStatus` et reçoit la base fusionnée.
 */
import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './store';
import { mergeDatabases, toShared } from '../src/shared/sync';
import { normalizeDatabase, type CloudStatus, type Database, type DocumentRecord } from '../src/shared/types';

interface Deps {
  getDb: () => Database;
  /** Remplace la base locale (déjà fusionnée) et prévient le renderer. */
  setDb: (db: Database, fromRemote: boolean) => void;
}

const sessionPath = () => path.join(dataDir(), 'cloud-session.json');
const basePath = () => path.join(dataDir(), 'cloud-base.json');
const uploadedPath = () => path.join(dataDir(), 'cloud-uploaded.json');

/** Stockage de session pour supabase-js côté Node (persisté dans le dossier de données). */
const fileStorage = {
  getItem: (k: string) => { try { const all = JSON.parse(fs.readFileSync(sessionPath(), 'utf8')); return all[k] ?? null; } catch { return null; } },
  setItem: (k: string, v: string) => { let all: Record<string, string> = {}; try { all = JSON.parse(fs.readFileSync(sessionPath(), 'utf8')); } catch { /* vide */ } all[k] = v; fs.writeFileSync(sessionPath(), JSON.stringify(all)); },
  removeItem: (k: string) => { let all: Record<string, string> = {}; try { all = JSON.parse(fs.readFileSync(sessionPath(), 'utf8')); } catch { /* vide */ } delete all[k]; fs.writeFileSync(sessionPath(), JSON.stringify(all)); },
};

export class Cloud {
  private client: SupabaseClient | null = null;
  private url = ''; private key = '';
  private channel: RealtimeChannel | null = null;
  private status: CloudStatus = { configured: false, user: null, orgs: [], activeOrgId: '', members: [], version: 0, lastSync: '', syncing: false, error: '' };
  private pushTimer: NodeJS.Timeout | null = null;
  private busy: Promise<void> = Promise.resolve();
  private deps: Deps;
  private onStatus: (s: CloudStatus) => void;

  constructor(deps: Deps, onStatus: (s: CloudStatus) => void) { this.deps = deps; this.onStatus = onStatus; }

  /** (Re)configure le client quand l'URL / la clé changent dans les réglages. */
  async configure(): Promise<void> {
    const { url, anonKey, orgId } = this.deps.getDb().settings.cloud;
    if (url !== this.url || anonKey !== this.key) {
      this.url = url; this.key = anonKey;
      this.unsubscribe();
      this.client = url && anonKey ? createClient(url, anonKey, { auth: { storage: fileStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }) : null;
      this.status = { ...this.status, configured: !!this.client, user: null, orgs: [], members: [], error: '' };
    }
    this.status.activeOrgId = orgId;
    if (this.client) await this.refresh().catch((e) => this.fail(e));
    this.emit();
  }

  getStatus(): CloudStatus { return this.status; }
  private emit() { this.onStatus(this.status); }
  private fail(e: unknown) { this.status = { ...this.status, error: (e as Error).message || String(e) }; this.emit(); }
  private need(): SupabaseClient { if (!this.client) throw new Error("Renseigne l'URL et la clé Supabase dans Réglages › Compte."); return this.client; }

  /** Recharge utilisateur, organisations, membres ; (ré)abonne le temps réel ; lance une synchro si connecté. */
  async refresh(): Promise<CloudStatus> {
    const c = this.need();
    const { data: { user } } = await c.auth.getUser();
    if (!user) { this.unsubscribe(); this.status = { ...this.status, user: null, orgs: [], members: [], error: '' }; this.emit(); return this.status; }
    const { data: prof } = await c.from('profiles').select('name').eq('id', user.id).maybeSingle();
    this.status.user = { id: user.id, email: user.email ?? '', name: prof?.name ?? '' };
    const { data: mem, error } = await c.from('org_members').select('role, organizations(id, name, invite_code)').eq('user_id', user.id);
    if (error) throw error;
    type Row = { role: string; organizations: { id: string; name: string; invite_code: string } | { id: string; name: string; invite_code: string }[] | null };
    this.status.orgs = ((mem ?? []) as Row[]).flatMap((m) => { const o = Array.isArray(m.organizations) ? m.organizations[0] : m.organizations; return o ? [{ id: o.id, name: o.name, role: m.role, inviteCode: o.invite_code }] : []; });
    if (!this.status.orgs.some((o) => o.id === this.status.activeOrgId)) this.status.activeOrgId = this.status.orgs[0]?.id ?? '';
    await this.loadMembers();
    this.status.error = '';
    this.emit();
    if (this.status.activeOrgId) { this.subscribe(); await this.sync(); }
    return this.status;
  }

  private async loadMembers() {
    if (!this.status.activeOrgId || !this.client) { this.status.members = []; return; }
    const { data } = await this.client.rpc('org_members_list', { p_org: this.status.activeOrgId });
    this.status.members = ((data ?? []) as { user_id: string; email: string; name: string; role: string }[]).map((m) => ({ userId: m.user_id, email: m.email, name: m.name, role: m.role }));
  }

  async signUp(email: string, password: string, name: string): Promise<CloudStatus> {
    const c = this.need();
    const { error } = await c.auth.signUp({ email, password, options: { data: { name } } });
    if (error) throw new Error(describe(error.message));
    const { data: s } = await c.auth.getSession();
    if (!s.session) { this.status.error = ''; this.emit(); throw new Error('Compte créé : confirme ton adresse depuis l\'email reçu, puis connecte-toi.'); }
    return this.refresh();
  }
  async signIn(email: string, password: string): Promise<CloudStatus> {
    const c = this.need();
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw new Error(describe(error.message));
    return this.refresh();
  }
  async signOut(): Promise<CloudStatus> {
    const c = this.need();
    this.unsubscribe();
    await c.auth.signOut();
    this.status = { ...this.status, user: null, orgs: [], members: [], activeOrgId: '', error: '' };
    this.emit();
    return this.status;
  }
  async createOrg(name: string): Promise<CloudStatus> {
    const c = this.need();
    const { data, error } = await c.rpc('create_organization', { p_name: name.trim() });
    if (error) throw new Error(describe(error.message));
    const row = (Array.isArray(data) ? data[0] : data) as { id: string };
    return this.selectOrg(row.id, true);
  }
  async joinOrg(code: string): Promise<CloudStatus> {
    const c = this.need();
    const { data, error } = await c.rpc('join_organization', { p_code: code.trim() });
    if (error) throw new Error(describe(error.message));
    const row = (Array.isArray(data) ? data[0] : data) as { id: string };
    return this.selectOrg(row.id, false);
  }
  /** Change d'organisation active. `seedFromLocal` : première création → la base locale actuelle devient l'espace partagé. */
  async selectOrg(orgId: string, seedFromLocal = false): Promise<CloudStatus> {
    this.unsubscribe();
    this.status.activeOrgId = orgId;
    // Nouvelle organisation : la « base » de fusion repart de zéro (tout le local est considéré comme nouveau, ou tout le remote, selon le cas)
    if (seedFromLocal) this.writeBase(emptyShared()); else this.writeBase(emptyShared());
    try { fs.unlinkSync(uploadedPath()); } catch { /* absent */ }
    const db = this.deps.getDb();
    const org = this.status.orgs.find((o) => o.id === orgId);
    this.deps.setDb({ ...db, settings: { ...db.settings, cloud: { ...db.settings.cloud, orgId, orgName: org?.name ?? '' } } }, false);
    return this.refresh();
  }
  async leaveOrg(orgId: string): Promise<CloudStatus> {
    const c = this.need();
    if (!this.status.user) throw new Error('Non connecté');
    const { error } = await c.from('org_members').delete().eq('org_id', orgId).eq('user_id', this.status.user.id);
    if (error) throw new Error(describe(error.message));
    if (this.status.activeOrgId === orgId) { this.unsubscribe(); this.status.activeOrgId = ''; const db = this.deps.getDb(); this.deps.setDb({ ...db, settings: { ...db.settings, cloud: { ...db.settings.cloud, orgId: '', orgName: '' } } }, false); }
    return this.refresh();
  }
  async regenerateCode(): Promise<CloudStatus> {
    const c = this.need();
    const { error } = await c.rpc('regenerate_invite_code', { p_org: this.status.activeOrgId });
    if (error) throw new Error(describe(error.message));
    return this.refresh();
  }

  // ------------------------------------------------------------------ synchronisation

  /** Appelé à chaque enregistrement local : synchro différée (1,5 s) pour grouper les modifications. */
  scheduleSync(): void {
    if (!this.client || !this.status.user || !this.status.activeOrgId) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => { this.pushTimer = null; this.sync().catch((e) => this.fail(e)); }, 1500);
  }

  /** Synchro complète : lit le serveur, fusionne avec le local, renvoie le résultat au serveur (avec vérification de version), puis les fichiers. */
  sync(): Promise<void> {
    const run = async () => {
      const c = this.client; const org = this.status.activeOrgId;
      if (!c || !this.status.user || !org) return;
      this.status.syncing = true; this.status.error = ''; this.emit();
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          const { data: ws, error } = await c.from('workspaces').select('data, version').eq('org_id', org).maybeSingle();
          if (error) throw new Error(describe(error.message));
          const remoteShared = (ws?.data ?? {}) as Partial<Database>;
          const remoteVersion = ws?.version ?? 0;
          const local = this.deps.getDb();
          const base = this.readBase();
          const remoteEmpty = Object.keys(remoteShared).length === 0;
          const merged = mergeDatabases(base, local, remoteEmpty ? {} : remoteShared);
          if (merged.remoteChanges) this.deps.setDb(merged.db, true);
          if (merged.localChanges || remoteEmpty) {
            const { data: res, error: e2 } = await c.rpc('save_workspace', { p_org: org, p_data: toShared(merged.db), p_expected_version: remoteVersion });
            if (e2) throw new Error(describe(e2.message));
            const row = (Array.isArray(res) ? res[0] : res) as { ok: boolean; version: number };
            if (!row.ok) { continue; } // quelqu'un a écrit entre-temps : on recommence avec sa version
            this.status.version = row.version;
          } else this.status.version = remoteVersion;
          this.writeBase(toShared(merged.db) as unknown as Database);
          break;
        }
        this.status.lastSync = new Date().toISOString();
        await this.syncFiles().catch((e) => { this.status.error = `Fichiers : ${(e as Error).message}`; });
      } finally { this.status.syncing = false; this.emit(); }
    };
    this.busy = this.busy.then(run, run);
    return this.busy;
  }

  /** Envoie les fichiers locaux pas encore sur le serveur. Les fichiers manquants en local sont téléchargés à la demande (voir `ensureLocalFile`). */
  private async syncFiles() {
    const c = this.client; const org = this.status.activeOrgId;
    if (!c || !org) return;
    const uploaded = this.readUploaded();
    let changed = false;
    for (const doc of this.deps.getDb().documents) {
      if (uploaded.has(doc.id)) continue;
      const local = localFilePath(doc);
      if (!local || !fs.existsSync(local)) continue;
      const { error } = await c.storage.from('files').upload(`${org}/${path.basename(local)}`, fs.readFileSync(local), { contentType: doc.mimeType, upsert: true });
      if (error && !/already exists/i.test(error.message)) throw new Error(error.message);
      uploaded.add(doc.id); changed = true;
    }
    if (changed) fs.writeFileSync(uploadedPath(), JSON.stringify([...uploaded]));
  }

  /** Garantit qu'un document est disponible sur ce poste (téléchargé depuis le serveur si besoin). Renvoie son chemin local ou null. */
  async ensureLocalFile(doc: DocumentRecord): Promise<string | null> {
    const local = localFilePath(doc);
    if (local && fs.existsSync(local)) return local;
    if (doc.storedPath && fs.existsSync(doc.storedPath)) return doc.storedPath;
    const c = this.client; const org = this.status.activeOrgId;
    if (!c || !org || !local) return null;
    const { data, error } = await c.storage.from('files').download(`${org}/${path.basename(local)}`);
    if (error || !data) return null;
    fs.writeFileSync(local, Buffer.from(await data.arrayBuffer()));
    return local;
  }

  private subscribe() {
    const c = this.client; const org = this.status.activeOrgId;
    if (!c || !org) return;
    this.unsubscribe();
    this.channel = c.channel(`workspace-${org}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'workspaces', filter: `org_id=eq.${org}` }, (payload) => {
        const v = (payload.new as { version?: number }).version ?? 0;
        if (v !== this.status.version) this.sync().catch((e) => this.fail(e));
      })
      .subscribe();
  }
  private unsubscribe() { if (this.channel && this.client) { this.client.removeChannel(this.channel); } this.channel = null; }

  private readBase(): Database { try { return normalizeDatabase(JSON.parse(fs.readFileSync(basePath(), 'utf8'))); } catch { return normalizeDatabase(emptyShared()); } }
  private writeBase(shared: Database | Record<string, unknown>) { fs.writeFileSync(basePath(), JSON.stringify(shared)); }
  private readUploaded(): Set<string> { try { return new Set(JSON.parse(fs.readFileSync(uploadedPath(), 'utf8'))); } catch { return new Set(); } }
}

function emptyShared(): Record<string, unknown> { return {}; }

/** Chemin local canonique d'un document : <données>/files/<id><ext> — identique sur tous les postes, quel que soit le chemin d'origine. */
export function localFilePath(doc: DocumentRecord): string | null {
  const ext = path.extname(doc.storedPath || doc.fileName) || (doc.mimeType === 'application/pdf' ? '.pdf' : '');
  return path.join(dataDir(), 'files', `${doc.id}${ext}`);
}

function describe(msg: string): string {
  if (/Invalid login credentials/i.test(msg)) return 'Email ou mot de passe incorrect.';
  if (/Email not confirmed/i.test(msg)) return 'Adresse email pas encore confirmée : ouvre le lien reçu par email.';
  if (/User already registered/i.test(msg)) return 'Un compte existe déjà avec cette adresse : connecte-toi.';
  if (/Password should be/i.test(msg)) return 'Mot de passe trop court (6 caractères minimum).';
  if (/fetch failed|ENOTFOUND|ECONN/i.test(msg)) return 'Impossible de joindre le serveur : vérifie l\'URL Supabase et la connexion internet.';
  return msg;
}
