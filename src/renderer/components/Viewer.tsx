import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api } from '../api';
import { useStore } from '../store';
import { KIND_LABELS } from '../../shared/extraction';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

/** Visionneur intégré : PDF rendus page par page (pdf.js) et photos, sans quitter Docker. */
const ViewerCtx = createContext<{ open: (documentId: string) => void }>({ open: () => {} });
export const useViewer = () => useContext(ViewerCtx);

export function ViewerProvider({ children }: { children: React.ReactNode }) {
  const [docId, setDocId] = useState<string | null>(null);
  return (
    <ViewerCtx.Provider value={{ open: setDocId }}>
      {children}
      {docId && <ViewerModal documentId={docId} onClose={() => setDocId(null)} />}
    </ViewerCtx.Provider>
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function ViewerModal({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { db } = useStore();
  const doc = db.documents.find((d) => d.id === documentId);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'image'; src: string } | { status: 'pdf'; pdf: pdfjs.PDFDocumentProxy; pages: number }>({ status: 'loading' });
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    let pdfDoc: pdfjs.PDFDocumentProxy | null = null;
    setState({ status: 'loading' }); setZoom(1);
    (async () => {
      try {
        const r = await api.readDocumentBase64(documentId);
        if (!r) throw new Error("Fichier introuvable sur le disque (il a peut-être été déplacé ou supprimé).");
        if (cancelled) return;
        if (r.mimeType === 'application/pdf' || doc?.fileName.toLowerCase().endsWith('.pdf')) {
          pdfDoc = await pdfjs.getDocument({ data: base64ToBytes(r.base64) }).promise;
          if (cancelled) { pdfDoc.destroy(); return; }
          setState({ status: 'pdf', pdf: pdfDoc, pages: pdfDoc.numPages });
        } else {
          setState({ status: 'image', src: `data:${r.mimeType || 'image/png'};base64,${r.base64}` });
        }
      } catch (e) {
        if (!cancelled) setState({ status: 'error', message: (e as Error).message || String(e) });
      }
    })();
    return () => { cancelled = true; pdfDoc?.destroy(); };
  }, [documentId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!doc) return null;
  const size = doc.sizeBytes > 1e6 ? `${(doc.sizeBytes / 1e6).toFixed(1)} Mo` : `${Math.round(doc.sizeBytes / 1e3)} Ko`;

  return (
    <div className="viewer-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="viewer">
        <div className="viewer-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.fileName}</div>
            <div className="small muted">{KIND_LABELS[doc.kind]} · {size}{state.status === 'pdf' ? ` · ${state.pages} page${state.pages > 1 ? 's' : ''}` : ''}{doc.summary ? ` · ${doc.summary}` : ''}</div>
          </div>
          <div className="row-flex" style={{ flex: 'none' }}>
            <button className="btn small" onClick={() => setZoom((z) => Math.max(0.4, +(z / 1.25).toFixed(2)))}>−</button>
            <span className="small muted" style={{ minWidth: 42, textAlign: 'center' }}>{Math.round(zoom * 100)} %</span>
            <button className="btn small" onClick={() => setZoom((z) => Math.min(4, +(z * 1.25).toFixed(2)))}>+</button>
            <button className="btn small" onClick={() => api.openDocument(doc.id)}>Ouvrir avec l'application par défaut</button>
            <button className="btn small" onClick={onClose}>Fermer (Échap)</button>
          </div>
        </div>
        <div className="viewer-body" style={{ overflow: 'auto' }}>
          {state.status === 'loading' && <div className="empty"><span className="spinner" /> Chargement…</div>}
          {state.status === 'error' && <div className="empty" style={{ color: 'var(--bad)' }}>Impossible d'afficher ce fichier : {state.message}</div>}
          {state.status === 'image' && (
            <div style={{ padding: 16, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', minHeight: '100%' }}>
              <img src={state.src} alt={doc.fileName} style={{ width: zoom === 1 ? 'auto' : `${zoom * 100}%`, maxWidth: zoom <= 1 ? '100%' : 'none', maxHeight: zoom <= 1 ? 'calc(94vh - 90px)' : 'none', background: '#fff', boxShadow: '0 2px 12px rgba(0,0,0,.2)' }} onError={() => setState({ status: 'error', message: "l'image n'a pas pu être décodée (format non pris en charge ?)" })} />
            </div>
          )}
          {state.status === 'pdf' && <PdfPages pdf={state.pdf} pages={state.pages} zoom={zoom} />}
        </div>
      </div>
    </div>
  );
}

/** Rend chaque page du PDF dans un canvas, adapté à la largeur disponible × zoom. */
function PdfPages({ pdf, pages, zoom }: { pdf: pdfjs.PDFDocumentProxy; pages: number; zoom: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  useEffect(() => {
    const el = container.current; if (!el) return;
    const update = () => setWidth(Math.max(300, el.clientWidth - 48));
    update();
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={container} style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: '100%', minWidth: 0, boxSizing: 'border-box' }}>
      {Array.from({ length: pages }, (_, i) => <PdfPage key={i} pdf={pdf} index={i + 1} targetWidth={Math.min(width, 1100) * zoom} />)}
    </div>
  );
}

function PdfPage({ pdf, index, targetWidth }: { pdf: pdfjs.PDFDocumentProxy; index: number; targetWidth: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let task: pdfjs.RenderTask | null = null;
    (async () => {
      try {
        const page = await pdf.getPage(index);
        if (cancelled || !canvas.current) return;
        const base = page.getViewport({ scale: 1 });
        const scale = targetWidth / base.width;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });
        const c = canvas.current;
        c.width = Math.floor(viewport.width); c.height = Math.floor(viewport.height);
        c.style.width = `${Math.floor(viewport.width / dpr)}px`; c.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('canvas indisponible');
        task = page.render({ canvasContext: ctx, viewport });
        await task.promise;
      } catch (e) {
        if (!cancelled && (e as Error).name !== 'RenderingCancelledException') setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, index, targetWidth]);
  return (
    <div style={{ position: 'relative' }}>
      <canvas ref={canvas} style={{ background: '#fff', boxShadow: '0 2px 12px rgba(0,0,0,.25)', display: 'block', maxWidth: '100%', height: 'auto' }} />
      {err && <div className="small" style={{ color: 'var(--bad)' }}>Page {index} : {err}</div>}
      <div className="small muted" style={{ textAlign: 'center', marginTop: 4 }}>{index}</div>
    </div>
  );
}

/** Aperçu compact d'un document (utilisé dans la fenêtre de validation des lectures IA). */
export function DocumentPreview({ documentId, height = 340 }: { documentId: string; height?: number }) {
  const { db } = useStore();
  const doc = db.documents.find((d) => d.id === documentId);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'image'; src: string } | { status: 'pdf'; pdf: pdfjs.PDFDocumentProxy; pages: number }>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false; let pdfDoc: pdfjs.PDFDocumentProxy | null = null;
    setState({ status: 'loading' });
    (async () => {
      try {
        const r = await api.readDocumentBase64(documentId);
        if (!r) throw new Error('fichier introuvable');
        if (cancelled) return;
        if (r.mimeType === 'application/pdf' || doc?.fileName.toLowerCase().endsWith('.pdf')) {
          pdfDoc = await pdfjs.getDocument({ data: base64ToBytes(r.base64) }).promise;
          if (cancelled) { pdfDoc.destroy(); return; }
          setState({ status: 'pdf', pdf: pdfDoc, pages: pdfDoc.numPages });
        } else setState({ status: 'image', src: `data:${r.mimeType || 'image/png'};base64,${r.base64}` });
      } catch (e) { if (!cancelled) setState({ status: 'error', message: (e as Error).message }); }
    })();
    return () => { cancelled = true; pdfDoc?.destroy(); };
  }, [documentId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="preview" style={{ height: height || '100%', overflow: 'auto' }}>
      {state.status === 'loading' && <div className="empty"><span className="spinner" /></div>}
      {state.status === 'error' && <div className="empty small" style={{ color: 'var(--bad)' }}>Aperçu indisponible : {state.message}</div>}
      {state.status === 'image' && <img src={state.src} alt="" />}
      {state.status === 'pdf' && <PdfPages pdf={state.pdf} pages={state.pages} zoom={1} />}
    </div>
  );
}
