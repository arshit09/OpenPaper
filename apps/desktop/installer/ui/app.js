// OpenPaper Setup's page: install (or uninstall) views driven by the Rust commands in src/main.rs.
const { invoke, Channel } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const $ = (selector) => document.querySelector(selector);
const state = { info: null, release: null, dir: '', busy: false, step: null };

const INSTALL_STEPS = [
  ['download', 'Download'],
  ['verify', 'Check the download'],
  ['install', 'Install'],
  ['shortcuts', 'Add shortcuts'],
];
const REMOVE_STEPS = [
  ['close', 'Close OpenPaper'],
  ['remove', 'Remove files'],
  ['shortcuts', 'Remove shortcuts'],
];

function show(view) {
  for (const section of document.querySelectorAll('.view')) section.hidden = section.dataset.view !== view;
  document.body.dataset.state = view === 'progress' ? 'busy' : view === 'done' || view === 'removed' ? 'done' : '';
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

/** Show a path in `el`, shortened in the middle so its start and its last folders stay readable. */
function showPath(el, path, max = 46) {
  let text = path;
  const parts = path.split('\\');
  // Keep the drive and the first two folders, then as many of the last folders as fit.
  for (let keep = parts.length - 4; text.length > max && keep >= 1; keep--) {
    text = [...parts.slice(0, 3), '…', ...parts.slice(parts.length - keep)].join('\\');
  }
  if (text.length > max) text = `${path.slice(0, 16)}…${path.slice(-(max - 17))}`;
  el.textContent = text;
  el.title = path;
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
  const dot = $('[data-view="install"] .dot');
  line.textContent = 'Checking for the latest version…';
  dot.className = 'dot live';
  $('#size-line').textContent = '';
  try {
    const release = await invoke('fetch_release');
    state.release = release;
    const installed = state.info.installed;
    const button = $('#install');
    if (installed && compareVersions(release.version, installed.version) > 0) {
      line.textContent = `Update from ${installed.version} to ${release.version}`;
      button.textContent = 'Update';
    } else if (installed && compareVersions(release.version, installed.version) === 0) {
      line.textContent = `Version ${release.version} is installed`;
      button.textContent = 'Reinstall';
    } else {
      line.textContent = `Version ${release.version} for Windows`;
      button.textContent = 'Install';
    }
    dot.className = 'dot ready';
    const needs = release.installedSize ? ` · needs ${mb(release.installedSize)}` : '';
    $('#size-line').textContent = `${mb(release.size)} download${needs}`;
  } catch (error) {
    state.release = null;
    dot.className = 'dot bad';
    line.textContent = String(error).startsWith('No OpenPaper release') ? 'No release is available yet' : "Can't reach the download server";
    $('#size-line').innerHTML = '';
    const retry = document.createElement('a');
    retry.textContent = 'Try again';
    retry.addEventListener('click', (e) => {
      e.preventDefault();
      loadRelease();
    });
    $('#size-line').append(retry);
    $('#size-line').title = String(error);
  }
  updateInstallButton();
}

function renderSteps(steps) {
  const list = $('#steps');
  list.replaceChildren(
    ...steps.map(([id, name]) => {
      const li = document.createElement('li');
      li.className = 'step';
      li.dataset.step = id;
      li.innerHTML = `<span class="state"><svg class="i"><use href="#i-check" /></svg></span><span class="name"></span><span class="detail"></span>`;
      li.querySelector('.name').textContent = name;
      return li;
    }),
  );
}

/** Mark `id` active and every step before it done. */
function activate(id, detail = '') {
  let reached = false;
  for (const li of document.querySelectorAll('.step')) {
    const isIt = li.dataset.step === id;
    if (isIt) reached = true;
    li.classList.toggle('active', isIt);
    li.classList.toggle('done', !reached);
    if (isIt) li.querySelector('.detail').textContent = detail;
    else if (!reached) li.querySelector('.detail').textContent = '';
  }
}

function finishSteps() {
  for (const li of document.querySelectorAll('.step')) {
    li.classList.remove('active');
    li.classList.add('done');
    li.querySelector('.detail').textContent = '';
  }
}

function setBar(fraction) {
  $('#bar').style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

function installProgress() {
  let samples = [];
  const channel = new Channel();
  channel.onmessage = (message) => {
    state.step = message.step;
    $('#cancel').disabled = message.step !== 'download';
    switch (message.step) {
      case 'download': {
        const now = performance.now();
        samples.push([now, message.done]);
        samples = samples.filter(([t]) => now - t < 3000);
        const [t0, d0] = samples[0];
        const speed = now - t0 > 400 ? ((message.done - d0) / (now - t0)) * 1000 : 0;
        const total = message.total || state.release.size;
        activate('download', `${mb(message.done)} of ${mb(total)}${speed ? ` · ${mb(speed)}/s` : ''}`);
        setBar((message.done / total) * 0.7);
        $('#progress-meta').textContent = `${Math.floor((message.done / total) * 100)}%`;
        break;
      }
      case 'verify':
        activate('verify');
        setBar(0.72);
        $('#progress-meta').textContent = '';
        break;
      case 'close':
        activate('install', 'Closing OpenPaper…');
        setBar(0.74);
        break;
      case 'extract': {
        const fraction = message.total ? message.done / message.total : 0;
        activate('install', `${Math.floor(fraction * 100)}%`);
        setBar(0.74 + fraction * 0.22);
        break;
      }
      case 'shortcuts':
        activate('shortcuts');
        setBar(0.98);
        break;
      case 'done':
        finishSteps();
        setBar(1);
        break;
    }
  };
  return channel;
}

async function startInstall() {
  if (!state.release || !$('#agree').checked) return;
  state.busy = true;
  const verb = $('#install').textContent === 'Update' ? 'Updating' : 'Installing';
  $('#progress-eyebrow').textContent = `${verb} version ${state.release.version}`;
  $('#progress-title').innerHTML = 'Getting OpenPaper <em>ready.</em>';
  $('#progress-meta').textContent = '';
  $('#cancel').hidden = false;
  $('#cancel').disabled = false;
  renderSteps(INSTALL_STEPS);
  activate('download', 'Starting…');
  setBar(0);
  show('progress');
  try {
    const desktop = $('#desktop').checked;
    const dir = await invoke('install', { dir: state.dir, desktop, release: state.release, progress: installProgress() });
    state.dir = dir;
    $('#done-lede').textContent = desktop
      ? "OpenPaper is on your desktop and in the Start menu. Open it, then click Connect agent to hook up Claude Code, Cursor or another agent in one click."
      : 'OpenPaper is in the Start menu. Open it, then click Connect agent to hook up Claude Code, Cursor or another agent in one click.';
    $('#done-eyebrow').textContent = `Version ${state.release.version} installed`;
    showPath($('#done-dir'), dir);
    showPath($('#done-data'), state.info.dataDir);
    show('done');
  } catch (error) {
    if (String(error) === 'cancelled') show('install');
    else showError(error, startInstall);
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

function removeProgress() {
  const channel = new Channel();
  channel.onmessage = (message) => {
    state.step = message.step;
    const index = { close: 0, remove: 1, shortcuts: 2 }[message.step];
    if (index !== undefined) {
      activate(REMOVE_STEPS[index][0]);
      setBar((index + 0.5) / REMOVE_STEPS.length);
    } else if (message.step === 'done') {
      finishSteps();
      setBar(1);
    }
  };
  return channel;
}

async function startUninstall() {
  state.busy = true;
  const removeData = $('#remove-data').checked;
  $('#progress-eyebrow').textContent = 'Uninstalling';
  $('#progress-title').innerHTML = 'Removing <em>OpenPaper.</em>';
  $('#progress-meta').textContent = '';
  $('#cancel').hidden = true;
  renderSteps(REMOVE_STEPS);
  activate('close');
  setBar(0.05);
  show('progress');
  try {
    await invoke('uninstall', { removeData, progress: removeProgress() });
    $('#removed-lede').textContent = removeData
      ? 'OpenPaper and your designs were deleted from this PC. Agents you connected may still list OpenPaper in their settings.'
      : `Your designs are still in ${state.info.dataDir}. Agents you connected may still list OpenPaper in their settings.`;
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
    $('#uninstall-eyebrow').textContent = version ? `Version ${version} installed` : 'OpenPaper';
    showPath($('#data-dir'), state.info.dataDir);
    show('uninstall');
    return;
  }
  setDir(state.info.installed?.dir ?? state.info.defaultDir);
  show('install');
  loadRelease();
}

init();
