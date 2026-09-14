/**
 * Accès à la boîte Gmail, en lecture seule, de deux façons :
 *  - « Connexion Google » (OAuth 2.0 + API Gmail) : identifiants d'application de bureau créés par l'utilisateur
 *    sur console.cloud.google.com, consentement dans le navigateur, jeton stocké localement. Recommandé.
 *  - IMAP + mot de passe d'application : pour les comptes qui le permettent.
 * Plus l'import de fichiers .eml (message téléchargé depuis Gmail) sans aucune connexion.
 * Rien ne part ailleurs que vers Google ; rien n'est envoyé ni supprimé.
 */
import http from 'node:http';
import { shell } from 'electron';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { storeBuffer } from './store';
import type { DocumentRecord, MailMessage, Settings } from '../src/shared/types';

type Gmail = Settings['gmail'];
const MAX_TEXT = 20000;
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

// ---------------------------------------------------------------- Analyse commune

function toMessage(mailbox: string, uid: number | string, parsed: ParsedMail): MailMessage {
  const from = parsed.from?.value?.[0];
  const to = Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : parsed.to?.text ?? '';
  const text = (parsed.text || (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : '') || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  return {
    id: `${mailbox}:${uid}`, uid: typeof uid === 'number' ? uid : 0, mailbox,
    date: (parsed.date ?? new Date()).toISOString(),
    from: (from?.address ?? '').toLowerCase(), fromName: from?.name ?? '',
    to, subject: parsed.subject ?? '(sans objet)', text,
    attachments: (parsed.attachments ?? []).map((a, index) => ({ index, filename: a.filename ?? `piece-jointe-${index + 1}`, mimeType: a.contentType, size: a.size, documentId: null })),
    partnerId: null, shipmentId: null, read: false,
  };
}

/** Import de fichiers .eml déposés dans Docker (Gmail : ⋮ → « Télécharger le message »). */
export async function importEml(files: { name: string; base64: string }[]): Promise<MailMessage[]> {
  const out: MailMessage[] = [];
  for (const f of files) {
    const buf = Buffer.from(f.base64, 'base64');
    const parsed = await simpleParser(buf);
    const id = parsed.messageId?.replace(/[<>]/g, '') || `${f.name}-${buf.length}`;
    const m = toMessage('eml', id, parsed);
    // Les pièces jointes sont enregistrées tout de suite (on n'a pas de serveur où les rechercher plus tard).
    m.attachments = (parsed.attachments ?? []).map((a, index) => { const doc = storeBuffer(a.filename ?? `piece-jointe-${index + 1}`, a.contentType, a.content); return { index, filename: doc.fileName, mimeType: a.contentType, size: a.size, documentId: doc.id }; });
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------- Connexion Google (OAuth 2.0 + API Gmail)

/** Ouvre le navigateur pour le consentement Google et récupère un refresh token via un serveur local éphémère. */
export async function connectGoogle(clientId: string, clientSecret: string): Promise<{ ok: boolean; message: string; refreshToken?: string; email?: string }> {
  if (!clientId || !clientSecret) return { ok: false, message: 'Renseigne l\'ID client et le secret client OAuth (voir la marche à suivre).' };
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout;
    const finish = (r: { ok: boolean; message: string; refreshToken?: string; email?: string }) => { if (done) return; done = true; clearTimeout(timer); setTimeout(() => server.close(), 500); resolve(r); };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;max-width:520px"><h2>${title}</h2><p>${body}</p><p style="color:#888">Tu peux fermer cet onglet et revenir dans Docker.</p></body>`;
      if (error || !code) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page('Connexion refusée', error ?? 'Aucun code reçu.')); finish({ ok: false, message: `Google a refusé la connexion : ${error ?? 'aucun code'}` }); return; }
      try {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: `http://127.0.0.1:${port}`, grant_type: 'authorization_code' }) });
        const tok = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
        if (!tok.access_token) throw new Error(tok.error_description ?? tok.error ?? 'pas de jeton');
        const prof = (await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json()) as { emailAddress?: string };
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page('Docker est connecté ✅', `Compte : ${prof.emailAddress ?? ''}`));
        if (!tok.refresh_token) finish({ ok: false, message: 'Google n\'a pas renvoyé de jeton durable. Retire l\'accès de Docker sur myaccount.google.com/permissions puis recommence.' });
        else finish({ ok: true, message: `Connecté à ${prof.emailAddress ?? 'Gmail'}.`, refreshToken: tok.refresh_token, email: prof.emailAddress });
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page('Erreur', (e as Error).message));
        finish({ ok: false, message: `Échange du jeton impossible : ${(e as Error).message}` });
      }
    });
    timer = setTimeout(() => finish({ ok: false, message: 'Temps écoulé (5 min) : la connexion n\'a pas été validée dans le navigateur.' }), 5 * 60 * 1000);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent' }).toString();
      shell.openExternal(auth.toString());
    });
  });
}

async function accessToken(g: Gmail): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' }) });
  const tok = (await r.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tok.access_token) throw new Error(`Connexion Google expirée ou révoquée (${tok.error_description ?? tok.error ?? '?'}) : reconnecte ton compte dans Réglages.`);
  return tok.access_token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Appel API Gmail avec gestion du quota : en cas de 403 « quota exceeded » ou 429, on attend puis on réessaie. */
async function gapi<T>(token: string, path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  if (params) url.search = new URLSearchParams(params).toString();
  const waits = [3000, 10000, 30000, 65000];
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) return (await r.json()) as T;
    const body = (await r.text()).slice(0, 300);
    const quota = r.status === 429 || (r.status === 403 && /quota|rate/i.test(body));
    if (quota && attempt < waits.length) { await sleep(waits[attempt]); continue; }
    if (quota) throw new Error('Gmail limite le nombre de requêtes par minute et Docker a attendu trop longtemps. Relance la synchronisation dans une minute : elle reprendra là où elle s\'est arrêtée (les emails déjà récupérés sont conservés).');
    throw new Error(`API Gmail : ${r.status} ${body}`);
  }
}

interface GPart { partId?: string; mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { size?: number; data?: string; attachmentId?: string }; parts?: GPart[] }
const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function gmailMessage(id: string, payload: GPart, internalDate: string): MailMessage {
  const h = (n: string) => payload.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? '';
  let text = ''; let html = '';
  const atts: MailMessage['attachments'] = [];
  const walk = (p: GPart) => {
    if (p.filename && p.body?.attachmentId) atts.push({ index: atts.length, filename: p.filename, mimeType: p.mimeType ?? 'application/octet-stream', size: p.body.size ?? 0, documentId: null });
    else if (p.mimeType === 'text/plain' && p.body?.data) text += b64url(p.body.data).toString('utf8');
    else if (p.mimeType === 'text/html' && p.body?.data) html += b64url(p.body.data).toString('utf8');
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const body = (text || html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  const fromRaw = h('From');
  const m = fromRaw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  return {
    id: `gmail:${id}`, uid: 0, mailbox: 'gmail', date: new Date(Number(internalDate)).toISOString(),
    from: (m ? m[2] : fromRaw).trim().toLowerCase(), fromName: (m ? m[1] : '').trim(),
    to: h('To'), subject: h('Subject') || '(sans objet)', text: body, attachments: atts, partnerId: null, shipmentId: null, read: false,
  };
}

async function googleLabels(token: string): Promise<{ id: string; name: string }[]> {
  const r = await gapi<{ labels?: { id: string; name: string; type: string }[] }>(token, 'labels');
  return (r.labels ?? []).filter((l) => l.type === 'user').map((l) => ({ id: l.id, name: l.name })).sort((a, b) => a.name.localeCompare(b.name));
}

async function syncGoogle(g: Gmail, params: { senders: string[]; keywords: string[]; sinceDays: number; knownIds: string[] }): Promise<{ messages: MailMessage[]; scanned: number; remaining: number }> {
  const token = await accessToken(g);
  const newer = `newer_than:${Math.max(1, Math.min(3650, params.sinceDays))}d`;
  let q: string;
  let labelIds: string | undefined;
  if (g.label.trim()) {
    // Libellé choisi : on lit tout ce qu'il contient (c'est l'utilisateur qui a fait le tri).
    const labels = await googleLabels(token);
    const found = labels.find((l) => l.name.toLowerCase() === g.label.trim().toLowerCase()) ?? labels.find((l) => l.name.toLowerCase().endsWith(`/${g.label.trim().toLowerCase()}`));
    if (!found) throw new Error(`Libellé « ${g.label} » introuvable dans Gmail. Libellés disponibles : ${labels.map((l) => l.name).join(', ') || 'aucun'}.`);
    labelIds = found.id;
    q = newer;
  } else {
    const senders = params.senders.map((s) => s.trim().toLowerCase()).filter(Boolean);
    const keywords = params.keywords.map((k) => k.trim()).filter((k) => k.length >= 3);
    const terms = [...senders.flatMap((s) => [`from:${s}`, `to:${s}`]), ...keywords.map((k) => `subject:"${k.replace(/"/g, '')}"`)];
    if (!terms.length) return { messages: [], scanned: 0, remaining: 0 };
    q = `{${terms.join(' ')}} ${newer}`;
  }
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const r = await gapi<{ messages?: { id: string }[]; nextPageToken?: string }>(token, 'messages', { q, maxResults: '100', ...(labelIds ? { labelIds } : {}), ...(pageToken ? { pageToken } : {}) });
    ids.push(...(r.messages ?? []).map((m) => m.id));
    pageToken = r.nextPageToken;
  } while (pageToken && ids.length < 2000);
  const known = new Set(params.knownIds);
  const messages: MailMessage[] = [];
  // Quota Gmail : chaque lecture coûte des « unités » par minute ; on lit par lots de 80 avec une petite pause,
  // et on s'arrête proprement si le quota est atteint (la synchro suivante reprend le reste).
  const fresh = ids.filter((x) => !known.has(`gmail:${x}`));
  const todo = fresh.slice(0, 160);
  for (let i = 0; i < todo.length; i++) {
    try {
      const full = await gapi<{ id: string; internalDate: string; payload: GPart }>(token, `messages/${todo[i]}`, { format: 'full' });
      messages.push(gmailMessage(full.id, full.payload, full.internalDate));
    } catch (e) {
      if (messages.length && /limite le nombre de requêtes/.test((e as Error).message)) break; // on garde ce qu'on a
      throw e;
    }
    if (i % 20 === 19) await sleep(1500);
  }
  return { messages, scanned: ids.length, remaining: fresh.length - messages.length };
}

async function attachmentGoogle(g: Gmail, messageId: string, index: number): Promise<DocumentRecord | null> {
  const token = await accessToken(g);
  const full = await gapi<{ payload: GPart }>(token, `messages/${messageId}`, { format: 'full' });
  const atts: { filename: string; mimeType: string; attachmentId: string }[] = [];
  const walk = (p: GPart) => { if (p.filename && p.body?.attachmentId) atts.push({ filename: p.filename, mimeType: p.mimeType ?? 'application/octet-stream', attachmentId: p.body.attachmentId }); for (const c of p.parts ?? []) walk(c); };
  walk(full.payload);
  const a = atts[index];
  if (!a) return null;
  const data = await gapi<{ data: string }>(token, `messages/${messageId}/attachments/${a.attachmentId}`);
  return storeBuffer(a.filename, a.mimeType, b64url(data.data));
}

// ---------------------------------------------------------------- IMAP (mot de passe d'application)

const MAILBOXES = ['[Gmail]/Tous les messages', '[Gmail]/All Mail', 'INBOX'];
function imapClient(email: string, appPassword: string) {
  return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, pass: appPassword.replace(/\s+/g, '') }, logger: false });
}
async function openAllMail(c: ImapFlow): Promise<string> {
  let path = 'INBOX';
  try {
    const boxes = await c.list();
    const all = boxes.find((b) => b.specialUse === '\\All') ?? boxes.find((b) => MAILBOXES.includes(b.path));
    if (all) path = all.path;
  } catch { /* LIST refusé : on reste sur INBOX */ }
  await c.mailboxOpen(path, { readOnly: true });
  return path;
}
function describeError(e: unknown): string {
  const err = e as Error & { authenticationFailed?: boolean; responseText?: string; serverResponseCode?: string; code?: string };
  const detail = [err.responseText, err.serverResponseCode].filter(Boolean).join(' ');
  if (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|auth/i.test(`${err.message} ${detail}`)) {
    return `Identifiants refusés par Gmail${detail ? ` (${detail})` : ''}. Le plus simple : passe en mode « Connexion Google » (bouton ci-dessus), qui ne demande ni validation en deux étapes ni mot de passe d'application.`;
  }
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || /ENOTFOUND|ECONN|ETIMEDOUT/.test(err.message)) return `Impossible de joindre imap.gmail.com (${err.code ?? err.message}) : vérifie la connexion internet, un pare-feu ou un antivirus qui bloque le port 993.`;
  return `Connexion impossible : ${err.message}${detail ? ` — ${detail}` : ''}`;
}
async function syncImap(g: Gmail, params: { senders: string[]; keywords: string[]; sinceDays: number; knownIds: string[] }): Promise<{ messages: MailMessage[]; scanned: number; remaining: number }> {
  const c = imapClient(g.email, g.appPassword);
  try { await c.connect(); } catch (e) { throw new Error(describeError(e)); }
  try {
    const since = new Date(Date.now() - params.sinceDays * 86400000);
    const uids = new Set<number>();
    let mailbox: string;
    if (g.label.trim()) {
      const boxes = await c.list();
      const found = boxes.find((b) => b.path.toLowerCase() === g.label.trim().toLowerCase() || b.name.toLowerCase() === g.label.trim().toLowerCase());
      if (!found) throw new Error(`Libellé « ${g.label} » introuvable. Disponibles : ${boxes.map((b) => b.path).join(', ')}.`);
      mailbox = found.path;
      await c.mailboxOpen(mailbox, { readOnly: true });
      for (const uid of (await c.search({ since }, { uid: true })) || []) uids.add(uid);
    } else {
      mailbox = await openAllMail(c);
      for (const s of params.senders.map((x) => x.trim().toLowerCase()).filter(Boolean)) for (const q of [{ since, from: s }, { since, to: s }]) for (const uid of (await c.search(q, { uid: true })) || []) uids.add(uid);
      for (const k of params.keywords.map((x) => x.trim()).filter((x) => x.length >= 3)) for (const uid of (await c.search({ since, subject: k }, { uid: true })) || []) uids.add(uid);
    }
    const known = new Set(params.knownIds);
    const fresh = [...uids].filter((uid) => !known.has(`${mailbox}:${uid}`)).sort((a, b) => b - a);
    const wanted = fresh.slice(0, 300);
    const messages: MailMessage[] = [];
    for (const uid of wanted) {
      const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      messages.push(toMessage(mailbox, uid, await simpleParser(msg.source)));
    }
    return { messages, scanned: uids.size, remaining: fresh.length - messages.length };
  } finally { await c.logout().catch(() => undefined); }
}
async function attachmentImap(g: Gmail, mailId: string, index: number): Promise<DocumentRecord | null> {
  const sep = mailId.lastIndexOf(':');
  const mailbox = mailId.slice(0, sep), uid = Number(mailId.slice(sep + 1));
  const c = imapClient(g.email, g.appPassword);
  try { await c.connect(); } catch (e) { throw new Error(describeError(e)); }
  try {
    await c.mailboxOpen(mailbox, { readOnly: true });
    const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const a = ((await simpleParser(msg.source)).attachments ?? [])[index];
    return a ? storeBuffer(a.filename ?? `piece-jointe-${index + 1}`, a.contentType, a.content) : null;
  } finally { await c.logout().catch(() => undefined); }
}

// ---------------------------------------------------------------- Points d'entrée

const usesGoogle = (g: Gmail) => g.mode === 'oauth' && !!g.refreshToken && !!g.clientId && !!g.clientSecret;

export async function testMail(g: Gmail): Promise<{ ok: boolean; message: string }> {
  if (usesGoogle(g)) {
    try { const token = await accessToken(g); const prof = await gapi<{ emailAddress: string; messagesTotal: number }>(token, 'profile'); return { ok: true, message: `Connecté à ${prof.emailAddress} — ${prof.messagesTotal} messages.` }; }
    catch (e) { return { ok: false, message: (e as Error).message }; }
  }
  if (g.mode === 'oauth') return { ok: false, message: 'Compte Google non connecté : renseigne l\'ID client et le secret, puis clique « Connecter mon compte Google ».' };
  if (!g.email || !g.appPassword) return { ok: false, message: 'Renseigne l\'adresse Gmail et le mot de passe d\'application.' };
  const c = imapClient(g.email, g.appPassword);
  try { await c.connect(); const path = await openAllMail(c); const n = c.mailbox && typeof c.mailbox === 'object' ? c.mailbox.exists : 0; await c.logout(); return { ok: true, message: `Connecté à ${g.email} — ${n} messages dans « ${path} ».` }; }
  catch (e) { return { ok: false, message: describeError(e) }; }
  finally { try { c.close(); } catch { /* ignore */ } }
}

/** Libellés / dossiers disponibles dans la boîte (pour le choix dans Réglages). */
export async function listLabels(g: Gmail): Promise<string[]> {
  if (usesGoogle(g)) return (await googleLabels(await accessToken(g))).map((l) => l.name);
  if (!g.email || !g.appPassword) return [];
  const c = imapClient(g.email, g.appPassword);
  try { await c.connect(); } catch (e) { throw new Error(describeError(e)); }
  try { return (await c.list()).filter((b) => !b.path.startsWith('[Gmail]')).map((b) => b.path).sort(); } finally { await c.logout().catch(() => undefined); }
}

export function syncMail(g: Gmail, params: { senders: string[]; keywords: string[]; sinceDays: number; knownIds: string[] }) {
  return usesGoogle(g) ? syncGoogle(g, params) : syncImap(g, params);
}

export function fetchAttachment(g: Gmail, mailId: string, index: number): Promise<DocumentRecord | null> {
  if (mailId.startsWith('gmail:')) return attachmentGoogle(g, mailId.slice('gmail:'.length), index);
  if (mailId.startsWith('eml:')) return Promise.resolve(null); // déjà importées à la lecture du fichier
  return attachmentImap(g, mailId, index);
}
