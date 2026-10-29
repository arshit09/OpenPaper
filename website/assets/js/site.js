// OpenPaper website: small, dependency-free progressive enhancements.
(() => {
  const root = document.documentElement;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- Theme ---------- */
  // Light unless the visitor picked dark with the toggle; the system setting is ignored.
  const themeBtn = document.querySelector('.theme-toggle');
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const currentTheme = () => (root.dataset.theme === 'dark' ? 'dark' : 'light');
  const labelTheme = () => {
    const dark = currentTheme() === 'dark';
    themeBtn?.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    themeColor?.setAttribute('content', dark ? '#111111' : '#ffffff');
  };
  themeBtn?.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('op-site-theme', next);
    } catch {}
    labelTheme();
    window.dispatchEvent(new Event('op-theme'));
  });
  labelTheme();

  /* ---------- Navigation ---------- */
  const nav = document.querySelector('.nav');
  const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const menuBtn = document.querySelector('.menu-toggle');
  const menu = document.getElementById('mobile-menu');
  const setMenu = (open) => {
    menuBtn?.setAttribute('aria-expanded', String(open));
    menuBtn?.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (menu) menu.hidden = !open;
  };
  menuBtn?.addEventListener('click', () => setMenu(menuBtn.getAttribute('aria-expanded') !== 'true'));
  menu?.addEventListener('click', (e) => {
    if (e.target.closest('a')) setMenu(false);
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuBtn?.getAttribute('aria-expanded') === 'true') {
      setMenu(false);
      menuBtn.focus();
    }
  });

  /* ---------- Reveal on scroll ---------- */
  const reveals = [...document.querySelectorAll('.reveal')];
  reveals.forEach((el) => {
    const siblings = [...el.parentElement.children].filter((c) => c.classList.contains('reveal'));
    el.style.transitionDelay = `${Math.min(siblings.indexOf(el), 5) * 60}ms`;
  });
  if ('IntersectionObserver' in window && !reduceMotion.matches) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('seen');
          io.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('seen'));
  }

  /* ---------- Tabs ---------- */
  document.querySelectorAll('[role="tablist"]').forEach((list) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        select(tabs[(i + step + tabs.length) % tabs.length], true);
      });
    });
  });

  /* ---------- Copy buttons ---------- */
  const writeClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {}
      ta.remove();
      return ok;
    }
  };
  document.querySelectorAll('.copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      let text = btn.dataset.copy;
      if (btn.classList.contains('cd-copy')) {
        text = document.querySelector('.cd-pre:not([hidden])')?.textContent;
      } else if (btn.dataset.copyTarget) {
        text = document.querySelector(btn.dataset.copyTarget)?.textContent;
      }
      if (!text || !(await writeClipboard(text.trim()))) return;
      const label = btn.getAttribute('aria-label');
      btn.classList.add('done');
      btn.setAttribute('aria-label', 'Copied');
      setTimeout(() => {
        btn.classList.remove('done');
        btn.setAttribute('aria-label', label);
      }, 1600);
    });
  });

  /* ---------- Shortcut keycaps ---------- */
  const caps = new Map([...document.querySelectorAll('.kcap')].map((k) => [k.dataset.key, k]));
  const press = (cap) => {
    cap.classList.add('pressed');
    clearTimeout(cap._t);
    cap._t = setTimeout(() => cap.classList.remove('pressed'), 220);
  };
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    const cap = caps.get(e.key.toLowerCase());
    if (cap) press(cap);
  });
  caps.forEach((cap) => cap.addEventListener('pointerdown', () => press(cap)));

  /* ---------- Year ---------- */
  document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = String(new Date().getFullYear())));

  /* ---------- Visibility helper ---------- */
  const watchVisible = (el, cb) => {
    if (!el || !('IntersectionObserver' in window)) return cb(true);
    new IntersectionObserver((entries) => cb(entries[0].isIntersecting), { threshold: 0.15 }).observe(el);
  };

  /* ---------- Illustrations: animate only while on screen ---------- */
  document.querySelectorAll('.ill').forEach((ill) => {
    const svgs = [...ill.querySelectorAll('svg.ill-svg')];
    const set = (on) => {
      ill.classList.toggle('on', on);
      svgs.forEach((s) => (on && !reduceMotion.matches ? s.unpauseAnimations?.() : s.pauseAnimations?.()));
    };
    set(false);
    watchVisible(ill, set);
  });

  /* ---------- Shader canvases: five monochrome effects in the logo's palette ---------- */
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const rgbOf = (css) => {
    const probe = document.createElement('i');
    probe.style.color = css;
    document.body.append(probe);
    const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g).map(Number);
    probe.remove();
    return m.slice(0, 3);
  };
  // Soft drifting blobs: the shared field behind dithering, halftone and mesh.
  const blobField = (nx, ny, T, ar) => {
    let v = 0.06 * Math.sin(nx * 14 + T) + 0.06 * Math.cos(ny * 12 - T * 0.7);
    const b = [
      [0.5 + 0.32 * Math.sin(T * 0.6), 0.42 + 0.28 * Math.cos(T * 0.5), 0.34, 1],
      [0.5 + 0.3 * Math.cos(T * 0.45 + 1), 0.6 + 0.26 * Math.sin(T * 0.7), 0.26, 0.9],
      [0.5 + 0.34 * Math.sin(T * 0.35 + 2), 0.5 + 0.3 * Math.sin(T * 0.55 + 3), 0.42, 0.75],
    ];
    for (const [bx, by, r, w] of b) {
      const dx = nx - bx;
      const dy = (ny - by) * ar;
      v += w * Math.exp(-(dx * dx + dy * dy) / (r * r));
    }
    return v;
  };
  const ballField = (nx, ny, T, ar) => {
    let v = 0;
    for (let k = 0; k < 5; k++) {
      const a = T * (0.4 + k * 0.09) + k * 1.3;
      const bx = 0.5 + Math.cos(a) * (0.16 + k * 0.035);
      const by = 0.5 + Math.sin(a * 1.2) * (0.14 + k * 0.03);
      const dx = nx - bx;
      const dy = (ny - by) * ar;
      v += (0.0042 + k * 0.0008) / (dx * dx + dy * dy + 1e-4);
    }
    return v;
  };
  const EFFECTS = {
    dither: { label: 'Dithering', cols: 120, smooth: false },
    halftone: { label: 'Halftone dots', vector: true },
    mesh: { label: 'Mesh gradient', cols: 56, smooth: true },
    metaballs: { label: 'Metaballs', cols: 150, smooth: true },
    waves: { label: 'Waves', cols: 160, smooth: true },
  };
  const shaders = [...document.querySelectorAll('.ill-shader canvas')].map((canvas) => ({
    canvas,
    ctx: canvas.getContext('2d'),
    view: canvas.parentElement,
    visible: false,
    palette: null,
    img: null,
    key: '',
  }));
  const readPalette = (s) => {
    const cs = getComputedStyle(s.view);
    // Paper, Fold, Ink: the logo's three colours, flipped with the theme.
    s.palette = [rgbOf(cs.getPropertyValue('--bg-3')), [140, 140, 140], rgbOf(cs.getPropertyValue('--text'))];
  };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const drawShader = (s, t) => {
    const fx = EFFECTS[s.canvas.dataset.effect] || EFFECTS.dither;
    const w = s.view.clientWidth || 320;
    const h = s.view.clientHeight || 240;
    const T = t / 1000;
    const [paper, fold, ink] = s.palette;
    if (fx.vector) {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const key = `v${w}x${h}@${dpr}`;
      if (s.key !== key) {
        s.canvas.width = Math.round(w * dpr);
        s.canvas.height = Math.round(h * dpr);
        s.canvas.style.imageRendering = 'auto';
        s.key = key;
      }
      const { ctx } = s;
      const W = s.canvas.width;
      const H = s.canvas.height;
      const cell = Math.max(7, W / 44);
      ctx.fillStyle = `rgb(${paper})`;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = `rgb(${ink})`;
      for (let y = cell / 2; y < H + cell; y += cell) {
        for (let x = cell / 2; x < W + cell; x += cell) {
          const r = clamp01(blobField(x / W, y / H, T, H / W) * 0.85) * cell * 0.62;
          if (r < 0.4) continue;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return;
    }
    const cols = fx.cols;
    const rows = Math.max(24, Math.round((cols * h) / w));
    const key = `${s.canvas.dataset.effect}${cols}x${rows}`;
    if (s.key !== key) {
      s.canvas.width = cols;
      s.canvas.height = rows;
      s.canvas.style.imageRendering = fx.smooth ? 'auto' : 'pixelated';
      s.img = s.ctx.createImageData(cols, rows);
      s.key = key;
    }
    const d = s.img.data;
    const ar = rows / cols;
    const effect = s.canvas.dataset.effect;
    for (let y = 0; y < rows; y++) {
      const ny = y / rows;
      for (let x = 0; x < cols; x++) {
        const nx = x / cols;
        let c;
        if (effect === 'mesh') {
          const v = clamp01(blobField(nx, ny, T, ar) * 0.9);
          c = v < 0.5 ? mix(paper, fold, v * 2) : mix(fold, ink, (v - 0.5) * 2);
        } else if (effect === 'metaballs') {
          const v = ballField(nx, ny, T, ar);
          c = v > 1 ? ink : v > 0.82 ? fold : paper;
        } else if (effect === 'waves') {
          const v = Math.sin(ny * 46 + Math.sin(nx * 5 + T * 0.9) * 3.2 + Math.cos(nx * 2.3 - T * 0.5) * 1.6);
          c = v > 0.55 ? ink : v > 0.25 ? fold : paper;
        } else {
          const v = clamp01(blobField(nx, ny, T, ar)) * 2;
          const lo = v < 1 ? 0 : 1;
          c = s.palette[v - lo > BAYER[(y & 3) * 4 + (x & 3)] ? lo + 1 : lo];
        }
        const i = (y * cols + x) * 4;
        d[i] = c[0];
        d[i + 1] = c[1];
        d[i + 2] = c[2];
        d[i + 3] = 255;
      }
    }
    s.ctx.putImageData(s.img, 0, 0);
  };
  if (shaders.length) {
    let last = 0;
    let raf = 0;
    const loop = (t) => {
      raf = 0;
      const live = shaders.filter((s) => s.visible);
      if (!live.length) return;
      if (t - last > 33) {
        last = t;
        live.forEach((s) => drawShader(s, t));
      }
      raf = requestAnimationFrame(loop);
    };
    shaders.forEach((s) => {
      readPalette(s);
      drawShader(s, 4000);
      watchVisible(s.view, (v) => {
        s.visible = v;
        if (v && !reduceMotion.matches && !raf) raf = requestAnimationFrame(loop);
      });
    });
    const redraw = () =>
      shaders.forEach((s) => {
        readPalette(s);
        s.key = '';
        drawShader(s, last || 4000);
      });
    addEventListener('op-theme', redraw);
    let rt;
    addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(redraw, 120);
    });
    // Effect picker on the Shaders page.
    document.querySelectorAll('[data-fx-for]').forEach((picker) => {
      const target = document.querySelector(picker.dataset.fxFor);
      const s = shaders.find((x) => x.canvas === target);
      const tag = target?.parentElement.querySelector('.ill-tag');
      picker.querySelectorAll('button[data-fx]').forEach((btn) =>
        btn.addEventListener('click', () => {
          picker.querySelectorAll('button[data-fx]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
          target.dataset.effect = btn.dataset.fx;
          if (tag) tag.textContent = EFFECTS[btn.dataset.fx].label;
          if (s) drawShader(s, last || 4000);
        }),
      );
    });
  }

  /* ---------- Shortcuts page: search and Windows / macOS keys ---------- */
  const kbGrid = document.querySelector('.kb-grid');
  if (kbGrid) {
    const input = document.getElementById('kb-q');
    const empty = document.querySelector('.kb-empty');
    const filter = () => {
      const q = input.value.trim().toLowerCase();
      let any = false;
      kbGrid.querySelectorAll('.kb-group').forEach((group) => {
        let shown = 0;
        group.querySelectorAll('.kb-row').forEach((row) => {
          const hit = !q || row.textContent.toLowerCase().includes(q);
          row.hidden = !hit;
          if (hit) shown++;
        });
        group.hidden = shown === 0;
        any ||= shown > 0;
      });
      empty.hidden = any;
    };
    input?.addEventListener('input', filter);

    const keys = [...document.querySelectorAll('.kb-grid kbd, .kb-mac kbd')];
    keys.forEach((k) => (k.dataset.win = k.textContent));
    const setOs = (os) => {
      document.querySelectorAll('[data-os]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.os === os)));
      keys.forEach((k) => {
        const w = k.dataset.win;
        k.textContent = os === 'mac' ? ({ Ctrl: '⌘', Alt: '⌥' }[w] ?? w) : w;
      });
      document.querySelectorAll('[data-mac-only]').forEach((el) => (el.hidden = os !== 'mac'));
      document.querySelectorAll('[data-win-only]').forEach((el) => (el.hidden = os === 'mac'));
    };
    document.querySelectorAll('[data-os]').forEach((b) => b.addEventListener('click', () => setOs(b.dataset.os)));
    const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
    setOs(isMac ? 'mac' : 'win');
  }

  /* ---------- Agent dock typing ---------- */
  const dockInput = document.querySelector('.dd-input');
  if (dockInput && !reduceMotion.matches) {
    const prompts = [
      'Add a pricing section below the hero',
      'Make three directions for the selected card',
      'Restyle the page with the tokens',
    ];
    const placeholder = dockInput.textContent;
    let visible = false;
    let running = false;
    const run = async () => {
      running = true;
      for (let n = 0; visible; n++) {
        const text = prompts[n % prompts.length];
        dockInput.classList.add('typed');
        for (let i = 1; i <= text.length; i++) {
          dockInput.textContent = text.slice(0, i);
          await sleep(38);
        }
        await sleep(2400);
        dockInput.classList.remove('typed');
        dockInput.textContent = placeholder;
        await sleep(900);
      }
      running = false;
    };
    watchVisible(dockInput.closest('.card'), (v) => {
      visible = v;
      if (v && !running) run();
    });
  }

  /* ---------- Editor replica: scale + live build ---------- */
  const frameEl = document.querySelector('[data-mock]');
  const mock = frameEl?.querySelector('.mock');
  if (!frameEl || !mock) return;

  const fit = () => {
    const w = frameEl.clientWidth;
    const compact = w < 760;
    mock.classList.toggle('compact', compact);
    frameEl.style.setProperty('--s', String(w / (compact ? 720 : 1200)));
  };
  fit();
  addEventListener('resize', fit);
  if ('ResizeObserver' in window) new ResizeObserver(fit).observe(frameEl);

  const canvasEl = mock.querySelector('.m-canvas');
  const cursor = mock.querySelector('.m-cursor');
  const feed = mock.querySelector('.m-feed');
  const status = mock.querySelector('.m-status');
  const headline = mock.querySelector('.nb-h');
  const headlineRow = mock.querySelector('.m-headline-row');
  const flash = mock.querySelector('.m-flash');
  const replay = document.querySelector('.replay');
  const typed = [...mock.querySelectorAll('[data-type]')];
  typed.forEach((el) => (el.dataset.full = el.textContent.replace(/\s+/g, ' ').trim()));

  if (reduceMotion.matches) return; // Static, finished state.

  let gen = 0;
  const wait = async (ms, token) => {
    await sleep(ms);
    if (token !== gen) throw new Error('cancelled');
  };
  const scale = () => parseFloat(frameEl.style.getPropertyValue('--s')) || 1;
  const moveCursor = (el, dx = 6, dy = 4) => {
    const c = canvasEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const s = scale();
    cursor.style.transform = `translate(${(r.left - c.left) / s + dx}px, ${(r.top - c.top) / s + dy}px)`;
  };
  const log = (tool, note) => {
    const li = document.createElement('li');
    li.innerHTML = '<code></code><span></span>';
    li.firstChild.textContent = tool;
    li.lastChild.textContent = note;
    feed.prepend(li);
  };
  const type = async (el, token) => {
    const full = el.dataset.full;
    const per = Math.max(9, Math.min(42, 700 / full.length));
    for (let i = 1; i <= full.length; i++) {
      el.textContent = full.slice(0, i);
      await wait(per, token);
    }
  };
  const revealStep = async (n, token) => {
    const rows = mock.querySelectorAll(`.m-row[data-step="${n}"]`);
    rows.forEach((row, i) => setTimeout(() => token === gen && row.classList.add('in'), i * 90));
    for (const el of mock.querySelectorAll(`.m-board [data-step="${n}"]`)) {
      moveCursor(el);
      await wait(260, token);
      el.classList.add('in');
      if (el.dataset.full !== undefined) await type(el, token);
      else await wait(380, token);
    }
    await wait(350, token);
  };
  const reset = () => {
    mock.classList.add('building');
    mock.classList.remove('idle');
    mock.querySelectorAll('[data-step]').forEach((el) => el.classList.remove('in'));
    typed.forEach((el) => (el.textContent = ''));
    feed.replaceChildren();
    headline.classList.remove('tight');
    headlineRow.classList.remove('sel');
    status.textContent = 'Working on Home — Desktop';
    cursor.style.transition = 'none';
    cursor.style.transform = 'translate(440px, 600px)';
    void cursor.offsetWidth;
    cursor.style.transition = '';
  };
  const finish = () => {
    mock.querySelectorAll('[data-step]').forEach((el) => el.classList.add('in'));
    typed.forEach((el) => (el.textContent = el.dataset.full));
    mock.classList.add('idle');
    cursor.classList.remove('on');
    headlineRow.classList.remove('sel');
    status.textContent = 'Idle · 9 tool calls';
  };

  const play = async () => {
    const token = ++gen;
    replay.hidden = true;
    try {
      reset();
      await wait(500, token);
      cursor.classList.add('on');
      log('get_basic_info', 'Northbound · 1 page');
      await wait(700, token);
      log('create_artboard', 'Home — Desktop');
      const board = mock.querySelector('.m-board');
      moveCursor(board, 12, 10);
      mock.querySelector('.m-row[data-step="1"]').classList.add('in');
      board.classList.add('in');
      await wait(800, token);
      log('write_html', 'Nav · 3 layers');
      await revealStep(2, token);
      log('write_html', 'Hero · 5 layers');
      await revealStep(3, token);
      log('write_html', 'Mesh gradient shader');
      await revealStep(4, token);
      log('write_html', 'Routes · 4 layers');
      await revealStep(5, token);
      log('get_screenshot', 'Checked the artboard');
      moveCursor(board, 300, 200);
      flash.classList.remove('go');
      void flash.offsetWidth;
      flash.classList.add('go');
      await wait(1000, token);
      log('update_styles', 'Headline · letter-spacing');
      headlineRow.classList.add('sel');
      moveCursor(headline, 120, 30);
      await wait(450, token);
      headline.classList.add('tight');
      await wait(1100, token);
      log('finish_working_on_nodes', 'Home — Desktop');
      finish();
      replay.hidden = false;
      return true;
    } catch {
      return false;
    }
  };

  // One loop at a time: a newer loop (Replay) retires the old one, whose play() is cancelled via `gen`.
  let visible = false;
  let running = false;
  let loopId = 0;
  const loop = async (restart = false) => {
    if (running && !restart) return;
    const id = ++loopId;
    running = true;
    while (id === loopId && visible && !document.hidden) {
      if (!(await play())) break;
      await sleep(7000);
    }
    if (id === loopId) running = false;
  };
  replay.addEventListener('click', () => loop(true));
  watchVisible(frameEl, (v) => {
    visible = v;
    if (v) loop();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && visible) loop();
  });
})();
