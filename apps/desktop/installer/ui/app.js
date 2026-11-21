// OpenPaper Setup's page: install (or uninstall) views driven by the Rust commands in src/main.rs.
const { invoke, Channel } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const $ = (selector) => document.querySelector(selector);
const state = { info: null, release: null, dir: '', busy: false, step: null };

function show(view) {
  for (const section of document.querySelectorAll('.view')) section.hidden = section.dataset.view !== view;
  document.body.dataset.state =
    view === 'progress' ? 'busy' : view === 'done' || view === 'removed' ? 'done' : view === 'error' ? 'error' : '';
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} MB`;
}

/** Compare dotted versions; >0 when a is newer. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Show a path in `el`, shortened in the middle to the width it has, so the drive, the first two folders and
 * as many of the last folders as fit stay readable. The full path is in the tooltip.
 */
function showPath(el, path) {
  const parts = path.split('\\');
  const candidates = [path];
  for (let keep = parts.length - 4; keep >= 1; keep--) candidates.push([...parts.slice(0, 3), '…', ...parts.slice(-keep)].join('\\'));
  el.title = path;
  for (const text of candidates) {
    el.textContent = text;
    // Hidden (no width yet): settle for a length that usually fits.
    if (el.clientWidth ? el.scrollWidth <= el.clientWidth : text.length <= 40) return;
  }
}

// ---------- Install ----------

function setDir(dir) {
  state.dir = dir;
  showPath($('#dir'), dir);
}

function updateInstallButton() {
  $('#install').disabled = !($('#agree').checked && state.release);
}

async function loadRelease() {
  const line = $('#release-line');
  const button = $('#install');
  line.textContent = 'Checking for the latest version…';
  line.title = '';
  state.release = null;
  updateInstallButton();
  try {
    const release = await invoke('fetch_release');
    state.release = release;
    const installed = state.info.installed;
    const size = `${mb(release.size)} download`;
    if (installed && compareVersions(release.version, installed.version) > 0) {
      line.textContent = `Update from ${installed.version} to ${release.version} · ${size}`;
      button.textContent = 'Update';
    } else if (installed && compareVersions(release.version, installed.version) === 0) {
      line.textContent = `Version ${release.version} is already installed`;
      button.textContent = 'Reinstall';
    } else {
      line.textContent = `Version ${release.version} · ${size}`;
      button.textContent = 'Install';
    }
    if (release.installedSize) line.title = `Needs ${mb(release.installedSize)} of disk space`;
  } catch (error) {
    state.release = null;
    line.textContent = String(error).startsWith('No OpenPaper release') ? 'No release is available yet. ' : "Can't reach the download server. ";
    line.title = String(error);
    const retry = document.createElement('a');
    retry.textContent = 'Try again';
    retry.addEventListener('click', (e) => {
      e.preventDefault();
      loadRelease();
    });
    line.append(retry);
  }
  updateInstallButton();
}

/** The one line under the bar's left end, and the bar itself. `percent` false leaves the number out. */
function setProgress(status, fraction, percent = true) {
  if (status !== undefined) $('#status').textContent = status;
  const f = Math.max(0, Math.min(1, fraction));
  $('#bar').style.width = `${f * 100}%`;
  $('#percent').textContent = percent ? `${Math.floor(f * 100)}%` : '';
}

function installProgress() {
  const channel = new Channel();
  channel.onmessage = (message) => {
    state.step = message.step;
    // Only the download can be cancelled; past it, closing would leave a half-moved install.
    $('#cancel').hidden = message.step !== 'download';
    switch (message.step) {
      case 'download': {
        const total = message.total || state.release.size;
        setProgress(`Downloading · ${mb(message.done)} of ${mb(total)}`, (message.done / total) * 0.7);
        break;
      }
      case 'verify':
        setProgress('Checking the download…', 0.72);
        break;
      case 'close':
        setProgress('Closing OpenPaper…', 0.74);
        break;
      case 'extract':
        setProgress('Installing…', 0.74 + (message.total ? message.done / message.total : 0) * 0.22);
        break;
      case 'shortcuts':
        setProgress('Adding shortcuts…', 0.98);
        break;
      case 'done':
        setProgress('Done', 1);
        break;
    }
  };
  return channel;
}

function showProgress(title, sub, status) {
  $('#progress-title').textContent = title;
  $('#progress-sub').textContent = sub;
  $('#cancel').hidden = false;
  $('#cancel').disabled = false;
  setProgress(status, 0);
  show('progress');
}

async function startInstall() {
  if (!state.release || !$('#agree').checked) return;
  state.busy = true;
  const verb = $('#install').textContent === 'Update' ? 'Updating' : 'Installing';
  showProgress(`${verb} OpenPaper`, `Version ${state.release.version}`, 'Starting…');
  try {
    const desktop = $('#desktop').checked;
    const dir = await invoke('install', { dir: state.dir, desktop, release: state.release, progress: installProgress() });
    state.dir = dir;
    $('#done-sub').textContent = `${desktop ? "It's on your desktop and in the Start menu." : "It's in the Start menu."} Once it's open, connect Claude Code, Cursor or another agent from Settings.`;
    show('done');
  } catch (error) {
    if (String(error) === 'cancelled') show('install');
    else showError(error, startInstall);
  } finally {
    state.busy = false;
    state.step = null;
  }
}

// ---------- Update (from the app) ----------

/** The app started this Setup to update itself: no questions, keep its folder and shortcuts, then open it again. */
async function startUpdate() {
  state.busy = true;
  showProgress('Updating OpenPaper', '', 'Checking for the latest version…');
  try {
    state.release = await invoke('fetch_release');
    $('#progress-sub').textContent = `Version ${state.release.version}`;
    const dir = await invoke('install', {
      dir: state.dir,
      desktop: state.info.desktopShortcut,
      release: state.release,
      progress: installProgress(),
    });
    // Opening OpenPaper also closes this window.
    await invoke('launch', { dir });
  } catch (error) {
    // Cancelled during the download, before OpenPaper was closed: it's still running as it was.
    if (String(error) === 'cancelled') appWindow.close();
    else showError(error, startUpdate);
  } finally {
    state.busy = false;
    state.step = null;
  }
}

function showError(error, retry) {
  $('#error-text').textContent = String(error);
  $('#retry').onclick = retry;
  show('error');
}

// ---------- Uninstall ----------

const REMOVE_STATUS = { close: 'Closing OpenPaper…', remove: 'Removing files…', shortcuts: 'Removing shortcuts…' };

function removeProgress() {
  const channel = new Channel();
  channel.onmessage = (message) => {
    state.step = message.step;
    const index = Object.keys(REMOVE_STATUS).indexOf(message.step);
    if (index >= 0) setProgress(REMOVE_STATUS[message.step], (index + 0.5) / 3, false);
    else if (message.step === 'done') setProgress('Done', 1, false);
  };
  return channel;
}

async function startUninstall() {
  state.busy = true;
  const removeData = $('#remove-data').checked;
  const version = state.info.installed?.version;
  showProgress('Uninstalling OpenPaper', version ? `Version ${version}` : '', REMOVE_STATUS.close);
  $('#cancel').hidden = true;
  setProgress(undefined, 0.05, false);
  try {
    await invoke('uninstall', { removeData, progress: removeProgress() });
    $('#removed-sub').textContent = `${removeData ? 'Your designs and settings were deleted too.' : `Your designs are still in ${state.info.dataDir}.`} Agents you connected may still list OpenPaper in their settings.`;
    show('removed');
  } catch (error) {
    showError(error, startUninstall);
  } finally {
    state.busy = false;
    state.step = null;
  }
}

// ---------- Terms and privacy ----------

function openLegal(tab) {
  $('#legal').hidden = false;
  selectLegal(tab);
  $('#legal-done').focus();
}

function selectLegal(tab) {
  for (const button of document.querySelectorAll('.tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  const body = $('#legal-body');
  body.replaceChildren(document.getElementById(tab).content.cloneNode(true));
  body.scrollTop = 0;
}

function closeLegal() {
  $('#legal').hidden = true;
}

// ---------- Window ----------

/** Busy past the download, closing would leave a half-moved install: refuse. During the download, cancel first. */
async function requestClose() {
  if (state.busy && state.step !== 'download') return;
  if (state.busy) await invoke('cancel');
  // An update that stopped may have closed OpenPaper already: open it again (as it was, if the update was undone).
  // If it's still running, this only brings its window back.
  if (state.info?.mode === 'update' && !state.busy && !$('[data-view="error"]').hidden) {
    try {
      await invoke('launch', { dir: state.dir });
      return;
    } catch {}
  }
  appWindow.close();
}

function wire() {
  $('#minimize').addEventListener('click', () => appWindow.minimize());
  $('#close').addEventListener('click', requestClose);
  for (const button of document.querySelectorAll('[data-action="close"]')) button.addEventListener('click', requestClose);

  $('#agree').addEventListener('change', updateInstallButton);
  $('#install').addEventListener('click', startInstall);
  $('#cancel').addEventListener('click', () => {
    $('#cancel').disabled = true;
    invoke('cancel');
  });
  $('#change').addEventListener('click', async () => {
    const picked = await invoke('pick_folder', { current: state.dir });
    if (picked) setDir(picked);
  });
  $('#launch').addEventListener('click', () => invoke('launch', { dir: state.dir }).catch((e) => showError(e, () => show('done'))));
  $('#uninstall').addEventListener('click', startUninstall);

  for (const link of document.querySelectorAll('[data-legal]')) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openLegal(link.dataset.legal);
    });
  }
  for (const button of document.querySelectorAll('.tabs button')) button.addEventListener('click', () => selectLegal(button.dataset.tab));
  $('#legal-done').addEventListener('click', closeLegal);
  $('#legal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLegal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#legal').hidden) closeLegal();
  });
  // No browser right-click menu anywhere but text you can select.
  document.addEventListener('contextmenu', (e) => e.preventDefault());
}

async function init() {
  wire();
  state.info = await invoke('setup_info');
  document.body.dataset.mode = state.info.mode;
  if (state.info.mode === 'uninstall') {
    const version = state.info.installed?.version;
    $('#uninstall-sub').textContent = version ? `Removes version ${version} from this PC.` : 'Removes OpenPaper from this PC.';
    show('uninstall');
    showPath($('#data-dir'), state.info.dataDir);
    return;
  }
  if (state.info.mode === 'update') {
    state.dir = state.info.updateDir ?? state.info.installed?.dir ?? state.info.defaultDir;
    startUpdate();
    return;
  }
  show('install');
  setDir(state.info.installed?.dir ?? state.info.defaultDir);
  loadRelease();
}

init();
