/**
 * Mises à jour de Bao depuis les Releases GitHub du dépôt (voir .github/workflows/build.yml).
 * - Windows : téléchargement et installation automatiques (electron-updater, latest.yml de la release).
 * - macOS : l'app n'étant pas encore signée, electron-updater ne peut pas l'installer ; on ouvre le .dmg à télécharger.
 */
import { app, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../src/shared/types';

const REPO = { owner: 'GateAd-team', repo: 'Docker' };
const cmpVersions = (a: string, b: string) => { const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; };

export class Updater {
  private status: UpdateStatus = { current: app.getVersion(), state: 'idle', latest: null, url: null, notes: '', progress: 0, error: '', platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux' };
  constructor(private send: (s: UpdateStatus) => void) {
    autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', () => this.set({ state: 'ready', progress: 100 }));
    autoUpdater.on('error', (e) => this.set({ state: 'error', error: describe(e.message) }));
  }
  get() { return this.status; }
  private set(patch: Partial<UpdateStatus>) { this.status = { ...this.status, ...patch }; this.send(this.status); return this.status; }

  /** Interroge la dernière release GitHub (fonctionne pour tous les systèmes, sans signature). */
  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.set({ state: 'idle', error: 'Version de développement : les mises à jour se font avec git pull.' });
    this.set({ state: 'checking', error: '' });
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Bao' } });
      if (res.status === 404) return this.set({ state: 'uptodate', latest: null, error: 'Aucune version publiée (dépôt privé ou pas encore de release).' });
      if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
      const rel = await res.json() as { tag_name: string; body?: string; html_url: string; assets: { name: string; browser_download_url: string }[] };
      const latest = rel.tag_name.replace(/^v/, '');
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const asset = this.status.platform === 'windows' ? rel.assets.find((a) => a.name.endsWith('.exe'))
        : this.status.platform === 'mac' ? (rel.assets.find((a) => a.name.endsWith(`${arch}.dmg`)) ?? rel.assets.find((a) => a.name.endsWith('.dmg')))
        : rel.assets.find((a) => a.name.endsWith('.AppImage'));
      const newer = cmpVersions(latest, app.getVersion()) > 0;
      return this.set({ state: newer ? 'available' : 'uptodate', latest, url: asset?.browser_download_url ?? rel.html_url, notes: (rel.body ?? '').slice(0, 2000) });
    } catch (e) { return this.set({ state: 'error', error: describe((e as Error).message) }); }
  }

  /** Windows : télécharge l'installeur ; ailleurs : ouvre le lien de téléchargement dans le navigateur. */
  async download(): Promise<UpdateStatus> {
    if (this.status.platform !== 'windows') { if (this.status.url) await shell.openExternal(this.status.url); return this.set({ state: 'opened' }); }
    try {
      this.set({ state: 'downloading', progress: 0, error: '' });
      autoUpdater.setFeedURL({ provider: 'github', owner: REPO.owner, repo: REPO.repo });
      const r = await autoUpdater.checkForUpdates();
      if (!r?.updateInfo || cmpVersions(r.updateInfo.version, app.getVersion()) <= 0) return this.set({ state: 'uptodate' });
      await autoUpdater.downloadUpdate();
      return this.status;
    } catch (e) { return this.set({ state: 'error', error: describe((e as Error).message) }); }
  }

  install() { autoUpdater.quitAndInstall(false, true); }
}

function describe(msg: string): string {
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(msg)) return 'Pas de connexion à internet (ou GitHub inaccessible).';
  if (/404/.test(msg)) return 'Aucune version publiée trouvée sur GitHub (dépôt privé ou pas encore de release).';
  return msg;
}
