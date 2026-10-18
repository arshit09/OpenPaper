import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Locate a Chromium-based browser for headless rendering (screenshots, exports,
 * layout measurement). Override with OPENPAPER_BROWSER=/path/to/chrome.
 */
export function findBrowserExecutable(): string | null {
  const override = process.env.OPENPAPER_BROWSER || process.env.CHROME_PATH;
  if (override && existsSync(override)) return override;

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
      (r): r is string => !!r
    );
    for (const root of roots) {
      candidates.push(
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(root, 'Chromium', 'Application', 'chrome.exe'),
        join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
      );
    }
  } else if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser', 'Google Chrome Canary']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      if (process.env.HOME) candidates.push(join(process.env.HOME, 'Applications', `${app}.app`, 'Contents', 'MacOS', app));
    }
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      try {
        const found = execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (found) candidates.push(found);
      } catch {
        // not installed
      }
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}
