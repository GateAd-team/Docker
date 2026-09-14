/**
 * Lecture des documents avec l'API Claude.
 * Un PDF est envoyé tel quel (bloc "document"), une image en bloc "image".
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './store';
import type { DocumentRecord, ExtractionResult, MailAnalysis, MailMessage, Settings } from '../src/shared/types';
import { MAIL_ANALYSIS_SYSTEM, MAIL_ANALYSIS_TOOL, buildMailAnalysisPrompt } from '../src/shared/mailAnalysis';
import { EXTRACTION_INSTRUCTIONS, EXTRACTION_TOOL } from '../src/shared/extraction';
import { ASSISTANT_SYSTEM, ASSISTANT_TOOLS, buildOverview, contextLine, runTool, type ChatContext, type ChatMessage, type ToolTrace } from '../src/shared/assistant';
import type { Database } from '../src/shared/types';

const MAX_BYTES = 30 * 1024 * 1024;

export async function extractDocument(doc: DocumentRecord, settings: Settings): Promise<ExtractionResult> {
  if (!settings.anthropicApiKey) throw new Error("Aucune clé API Claude : renseigne-la dans Réglages.");
  if (doc.sizeBytes > MAX_BYTES) throw new Error('Fichier trop volumineux (max 30 Mo).');

  const client = new Anthropic({ apiKey: settings.anthropicApiKey });
  const base64 = fs.readFileSync(doc.storedPath).toString('base64');

  const fileBlock: Anthropic.Messages.ContentBlockParam =
    doc.mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: doc.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: base64 } };

  const response = await client.messages.create({
    model: settings.model || 'claude-sonnet-4-5',
    max_tokens: 4096,
    system: EXTRACTION_INSTRUCTIONS,
    tools: [EXTRACTION_TOOL as Anthropic.Messages.Tool],
    tool_choice: { type: 'tool', name: EXTRACTION_TOOL.name },
    messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: `Nom du fichier : ${doc.fileName}` }] }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') throw new Error("L'IA n'a pas renvoyé de résultat structuré.");
  const input = toolUse.input as ExtractionResult;
  return {
    kind: input.kind ?? 'autre',
    summary: input.summary ?? '',
    confidence: typeof input.confidence === 'number' ? input.confidence : 0.5,
    data: input.data ?? {},
  };
}

export async function testApiKey(key: string, model: string): Promise<{ ok: boolean; message: string }> {
  try {
    const client = new Anthropic({ apiKey: key });
    await client.messages.create({ model: model || 'claude-sonnet-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] });
    return { ok: true, message: 'Clé valide, connexion réussie.' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Boucle de conversation avec outils : le modèle appelle des outils qui modifient la base, jusqu'à sa réponse finale. */
export async function chat(messages: ChatMessage[], context: ChatContext, db: Database): Promise<{ text: string; traces: ToolTrace[]; navigate?: { page: string; id?: string }; db: Database }> {
  if (!db.settings.anthropicApiKey) throw new Error("Aucune clé API Claude : renseigne-la dans Réglages.");
  const client = new Anthropic({ apiKey: db.settings.anthropicApiKey });
  const history: Anthropic.Messages.MessageParam[] = messages.slice(-20).map((m, i, arr) => ({
    role: m.role,
    content: i === arr.length - 1 && m.role === 'user' ? `${contextLine(context)}\n${m.content}` : m.content,
  }));
  const traces: ToolTrace[] = [];
  let navigate: { page: string; id?: string } | undefined;
  let current = db;

  for (let round = 0; round < 12; round++) {
    const response = await client.messages.create({
      model: db.settings.model || 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: [{ type: 'text', text: ASSISTANT_SYSTEM }, { type: 'text', text: `ÉTAT DU LOGICIEL\n\n${buildOverview(current)}`, cache_control: { type: 'ephemeral' } }],
      tools: ASSISTANT_TOOLS as Anthropic.Messages.Tool[],
      messages: history,
    });
    const toolUses = response.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const text = response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { text: text || '(pas de réponse)', traces, navigate, db: current };
    }
    history.push({ role: 'assistant', content: response.content });
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      try {
        const out = runTool(current, tu.name, tu.input as Record<string, unknown>);
        current = out.db;
        if (out.navigate) navigate = out.navigate;
        traces.push({ tool: tu.name, summary: out.summary });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out.result).slice(0, 12000) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Erreur : ${(e as Error).message}`, is_error: true });
      }
    }
    history.push({ role: 'user', content: results });
  }
  return { text: "J'ai atteint la limite d'actions pour un seul message. Dis-moi si je continue.", traces, navigate, db: current };
}

/** Analyse un lot d'emails transporteurs : partenaires, expéditions, bilan, actions. */
/** Retrouve sur le disque une pièce jointe déjà stockée (document importé ou pièce d'un .eml). */
function storedFile(db: Database, documentId: string): string | null {
  const doc = db.documents.find((d) => d.id === documentId);
  if (doc && fs.existsSync(doc.storedPath)) return doc.storedPath;
  const dir = path.join(dataDir(), 'files');
  try { const f = fs.readdirSync(dir).find((n) => n.startsWith(documentId)); return f ? path.join(dir, f) : null; } catch { return null; }
}

const PDF_MAX_EACH = 8 * 1024 * 1024, PDF_MAX_TOTAL = 28 * 1024 * 1024, PDF_MAX_COUNT = 15;

/**
 * Analyse un lot d'emails transporteurs : partenaires, expéditions, bilan, actions.
 * Les PDF joints (devis, booking, B/L, factures de fret, packing lists…) sont envoyés à l'IA avec les emails :
 * c'est souvent là que sont les prix, volumes et dates.
 */
export async function analyzeMails(mails: MailMessage[], db: Database, fetchPdf?: (mailId: string, index: number) => Promise<DocumentRecord | null>): Promise<MailAnalysis> {
  const settings = db.settings;
  if (!settings.anthropicApiKey) throw new Error("Aucune clé API Claude : renseigne-la dans Réglages.");
  if (!mails.length) throw new Error('Aucun email à analyser.');
  const client = new Anthropic({ apiKey: settings.anthropicApiKey });
  const content: Anthropic.Messages.ContentBlockParam[] = [{ type: 'text', text: buildMailAnalysisPrompt(db, mails) }];
  let total = 0, count = 0;
  const skipped: string[] = [];
  for (const m of [...mails].sort((a, b) => b.date.localeCompare(a.date))) {
    for (const a of m.attachments) {
      const isPdf = a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename);
      if (!isPdf) continue;
      if (count >= PDF_MAX_COUNT || a.size > PDF_MAX_EACH || total + a.size > PDF_MAX_TOTAL) { skipped.push(a.filename); continue; }
      try {
        let file = a.documentId ? storedFile(db, a.documentId) : null;
        if (!file && fetchPdf) { const doc = await fetchPdf(m.id, a.index); if (doc) file = doc.storedPath; }
        if (!file) { skipped.push(a.filename); continue; }
        const data = fs.readFileSync(file).toString('base64');
        content.push({ type: 'text', text: `=== PIÈCE JOINTE de l'email id=${m.id} (${m.date.slice(0, 10)} · ${m.subject}) : ${a.filename}` });
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
        total += a.size; count++;
      } catch { skipped.push(a.filename); }
    }
  }
  if (skipped.length) content.push({ type: 'text', text: `(Pièces jointes non lues, trop volumineuses ou indisponibles : ${skipped.join(', ')})` });
  const response = await client.messages.create({
    model: settings.model || 'claude-sonnet-4-5',
    max_tokens: 8192,
    system: MAIL_ANALYSIS_SYSTEM,
    tools: [MAIL_ANALYSIS_TOOL as Anthropic.Messages.Tool],
    tool_choice: { type: 'tool', name: MAIL_ANALYSIS_TOOL.name },
    messages: [{ role: 'user', content }],
  });
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') throw new Error("L'IA n'a pas renvoyé de résultat structuré.");
  const input = toolUse.input as Partial<MailAnalysis>;
  return { partners: input.partners ?? [], shipments: input.shipments ?? [], overview: input.overview ?? '' };
}
