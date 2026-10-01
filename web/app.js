'use strict';

// ============================================================================
// Мост к нативной части (C++). Запросы с ответом идут через reqId.
// ============================================================================
const native = (() => {
  const wv = window.chrome && window.chrome.webview;
  const pending = new Map();
  let nextReq = 1;
  const handlers = {};
  if (wv) {
    wv.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'reply') {
        const resolve = pending.get(msg.reqId);
        pending.delete(msg.reqId);
        if (resolve) resolve(msg);
        return;
      }
      const h = handlers[msg.type];
      if (h) h(msg);
    });
  }
  return {
    available: !!wv,
    send(msg) { if (wv) wv.postMessage(JSON.stringify(msg)); },
    request(type, payload = {}) {
      return new Promise((resolve) => {
        if (!wv) return resolve({});
        const reqId = nextReq++;
        pending.set(reqId, resolve);
        wv.postMessage(JSON.stringify({ type, reqId, ...payload }));
      });
    },
    on(type, fn) { handlers[type] = fn; },
  };
})();

// ============================================================================
// Состояние
// ============================================================================
const DEFAULT_COMMAND = 'claude --dangerously-skip-permissions';
const LAYOUTS = [1, 2, 4, 6, 8];

const state = {
  projects: [],     // { id, name, path, command, pinned, createdAt, lastOpened, openCount }
  settings: {
    shell: 'powershell.exe',
    command: DEFAULT_COMMAND,
    layout: 1,
    fontSize: 14,
    sidebar: true,
    projectsRoot: '',
    restoreSessions: false,
  },
  openProjects: [], // проекты, открытые при последнем закрытии (для восстановления)
};

const env = { home: '', hasPwsh: false, hasClaude: true, osBuild: 0, hasSsh: false };

const sessions = new Map();  // id -> Session
let tabOrder = [];           // порядок вкладок (id сессий)
let panes = [null];          // id сессии в каждой ячейке сетки
let activeId = null;
let zoomedId = null;         // развёрнутая на всё окно сессия (двойной клик по заголовку)
let nextSessionId = 1;
let search = '';
let missingPaths = new Set();

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : String(c));
  return node;
};
const icon = (paths, cls = '') => {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" class="${cls}">${paths}</svg>`;
  return span.firstChild;
};
const ICONS = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  pin: '<path d="M12 17v5M8 3h8l-1 7 3 3v2H6v-2l3-3z"/>',
  terminal: '<path d="M5 7l5 5-5 5M13 17h6"/>',
  restart: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
};

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const normPath = (p) => p.replace(/[\\/]+$/, '').toLowerCase();

function relTime(ts) {
  if (!ts) return 'не открывался';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} дн назад`;
  return new Date(ts).toLocaleDateString('ru-RU');
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    state.openProjects = tabOrder.map((id) => sessions.get(id)?.projectId).filter(Boolean);
    native.send({ type: 'saveState', data: state });
  }, 300);
}

function toast(text, kind = '') {
  const t = el('div', { class: `toast ${kind}` }, text);
  $('#toast-root').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

// ============================================================================
// Терминальные сессии
// ============================================================================
const TERM_THEME = {
  background: '#16171c', foreground: '#e4e4ea', cursor: '#e4e4ea', cursorAccent: '#16171c',
  selectionBackground: 'rgba(217,119,87,0.35)',
  black: '#2a2c36', red: '#e5625c', green: '#5fbf7f', yellow: '#e0b04a', blue: '#5b9cf0', magenta: '#c47fd5', cyan: '#4fbfc4', white: '#d4d4dc',
  brightBlack: '#6c6f80', brightRed: '#ff7b74', brightGreen: '#7ddc98', brightYellow: '#f2c867', brightBlue: '#7cb4ff', brightMagenta: '#d99ce8', brightCyan: '#72d7db', brightWhite: '#ffffff',
};

// ---------- SSH ----------
// Строка в одинарных кавычках для POSIX-шелла на сервере.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function remoteDirExpr(dir) {
  const d = (dir || '').trim();
  if (!d || d === '~') return '~';
  if (d.startsWith('~/')) return `~/${shQuote(d.slice(2))}`;
  return shQuote(d);
}

// Команда для сервера: перейти в папку, запустить команду и остаться в интерактивном шелле.
// Запускаем через login+interactive шелл, чтобы подхватились PATH из ~/.profile и ~/.bashrc (туда ставится claude).
function sshRemoteCommand(dir, command) {
  const inner = `cd ${remoteDirExpr(dir)} 2>/dev/null || echo "Папка не найдена: "${shQuote(dir || '~')}; ` +
    `${command ? `${command}; ` : ''}exec "$SHELL" -l`;
  return `exec "$SHELL" -lic ${shQuote(inner)}`;
}

function sshCommonArgs(ssh) {
  return ['-p', String(ssh.port || 22), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30'];
}

function sshConnectArgs(ssh, command) {
  const args = ['-t', ...sshCommonArgs(ssh)];
  if (ssh.keyPath) args.push('-i', ssh.keyPath);
  args.push('-l', ssh.user, ssh.host, sshRemoteCommand(ssh.dir, command));
  return args;
}

// Однократная установка публичного ключа: вход по паролю, дописываем ключ в authorized_keys (без дублей).
function sshInstallArgs(ssh, publicKey) {
  const k = shQuote(publicKey);
  const script = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && ` +
    `(grep -qxF ${k} ~/.ssh/authorized_keys || echo ${k} >> ~/.ssh/authorized_keys)`;
  return [...sshCommonArgs(ssh), '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive,password',
    '-l', ssh.user, ssh.host, script];
}

function sshLabel(ssh) {
  return `${ssh.user}@${ssh.host}${Number(ssh.port) && Number(ssh.port) !== 22 ? `:${ssh.port}` : ''}:${ssh.dir || '~'}`;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, '');

class Session {
  constructor({ projectId, name, path, command, ssh = null, install = null }) {
    this.id = nextSessionId++;
    this.projectId = projectId;
    this.name = name;
    this.path = path;
    this.command = command;
    this.ssh = ssh;            // { host, port, user, dir, keyPath } для проектов на сервере
    this.install = install;    // { publicKey, password } — если ключ ещё надо установить на сервер
    this.phase = install ? 'install' : 'main';
    this.outTail = '';
    this.status = 'starting';  // starting | running | exited
    this.title = '';
    this.attention = false;
    this.busy = false;
    this.busySince = 0;
    this.lastOutput = 0;
    this.lastInput = 0;
    this.cols = 0;
    this.rows = 0;

    this.host = el('div', { class: 'term-host' });
    this.term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: state.settings.fontSize,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: TERM_THEME,
      windowsPty: env.osBuild ? { backend: 'conpty', buildNumber: env.osBuild } : undefined,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon.Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => native.send({ type: 'openUrl', url: uri })));
    $('#parking').append(this.host);
    this.term.open(this.host);
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch { /* остаёмся на DOM-рендерере */ }

    this.term.onData((data) => this.onInput(data));
    this.term.onTitleChange((t) => {
      // Заголовок по умолчанию от консоли — это путь к powershell.exe; показываем только «осмысленные».
      this.title = /\.exe$/i.test(t.trim()) ? '' : t.trim();
      renderPaneHeaders();
      renderTabs();
    });
    this.term.onBell(() => this.markAttention());
    this.term.attachCustomKeyEventHandler((e) => handleTermKey(this, e));
    this.term.textarea?.addEventListener('focus', () => { if (activeId !== this.id) activate(this.id, { focus: false }); });
    this.host.addEventListener('contextmenu', (e) => { e.preventDefault(); this.copyOrPaste(); });
  }

  start() {
    this.status = 'starting';
    this.fitNow();
    const base = { type: 'spawn', id: this.id, cols: this.cols || 120, rows: this.rows || 30 };
    if (!this.ssh) {
      native.send({ ...base, cwd: this.path, shell: state.settings.shell, command: this.command });
    } else if (this.phase === 'install') {
      this.term.write(`\x1b[36mУстанавливаю ключ на ${this.ssh.user}@${this.ssh.host}.` +
        `${this.install.password ? '' : ' Введите пароль от сервера, когда он попросит.'}\x1b[0m\r\n`);
      this.outTail = '';
      native.send({ ...base, cwd: env.home, program: 'ssh', args: sshInstallArgs(this.ssh, this.install.publicKey) });
    } else {
      native.send({ ...base, cwd: env.home, program: 'ssh', args: sshConnectArgs(this.ssh, this.command) });
    }
  }

  restart() {
    native.send({ type: 'kill', id: this.id });
    this.term.reset();
    this.start();
    renderAll();
  }

  onInput(data) {
    if (this.status === 'exited') {
      if (data === '\r') this.restart();
      return;
    }
    this.lastInput = performance.now();
    native.send({ type: 'input', id: this.id, data });
  }

  onOutput(data) {
    this.term.write(data);
    // Пароль из диалога подставляем один раз — на первый запрос сервера.
    if (this.phase === 'install' && this.install?.password) {
      this.outTail = (this.outTail + data).slice(-400);
      if (/password[^\n]*:\s*$/i.test(stripAnsi(this.outTail))) {
        native.send({ type: 'input', id: this.id, data: `${this.install.password}\r` });
        this.install.password = '';
      }
    }
    const now = performance.now();
    this.lastOutput = now;
    // Эхо набранного текста не считаем «работой».
    if (!this.busy && now - this.lastInput > 200) {
      this.busy = true;
      this.busySince = now;
      renderIndicators();
    }
  }

  onExit(code) {
    this.status = 'exited';
    this.busy = false;
    if (this.phase === 'install') {
      if (code === 0) {
        // Ключ установлен — в этой же вкладке подключаемся уже по ключу.
        this.term.write('\x1b[32mКлюч установлен, дальше вход без пароля. Подключаюсь…\x1b[0m\r\n');
        this.phase = 'main';
        this.install = null;
        this.start();
        renderAll();
        return;
      }
      this.term.write(`\r\n\x1b[31mНе удалось установить ключ (код ${code}). Проверьте пароль и что сервер разрешает вход по паролю.\x1b[0m\r\n` +
        '\x1b[90m[Enter — повторить, Ctrl+Shift+W — закрыть вкладку]\x1b[0m\r\n');
      renderAll();
      return;
    }
    const what = this.ssh ? 'Соединение закрыто' : 'Процесс завершён';
    this.term.write(`\r\n\x1b[90m[${what}, код ${code}. Enter — ${this.ssh ? 'переподключиться' : 'перезапустить'}, Ctrl+Shift+W — закрыть вкладку]\x1b[0m\r\n`);
    renderAll();
  }

  markAttention() {
    if (isFocused(this)) return;
    if (!this.attention) {
      this.attention = true;
      renderIndicators();
    }
    native.send({ type: 'attention' });
  }

  isVisible() { return panes.includes(this.id) && this.host.isConnected && this.host.parentElement?.classList.contains('pane-body'); }

  fitNow() {
    if (!this.isVisible()) return;
    const dims = this.fit.proposeDimensions();
    if (!dims || !dims.cols || !dims.rows || isNaN(dims.cols)) return;
    const cols = Math.max(20, dims.cols);
    const rows = Math.max(5, dims.rows);
    if (cols === this.term.cols && rows === this.term.rows && cols === this.cols) return;
    this.term.resize(cols, rows);
    this.cols = cols;
    this.rows = rows;
    if (this.status !== 'exited') native.send({ type: 'resize', id: this.id, cols, rows });
  }

  async copyOrPaste() {
    const sel = this.term.getSelection();
    if (sel) {
      await navigator.clipboard.writeText(sel).catch(() => {});
      this.term.clearSelection();
    } else {
      const text = await navigator.clipboard.readText().catch(() => '');
      if (text) this.term.paste(text);
    }
    this.term.focus();
  }

  setFontSize(size) {
    this.term.options.fontSize = size;
    this.fitNow();
  }

  dispose() {
    native.send({ type: 'kill', id: this.id });
    this.term.dispose();
    this.host.remove();
  }
}

function handleTermKey(session, e) {
  if (e.type !== 'keydown') return true;
  const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;

  // Копирование выделенного по Ctrl+C; без выделения Ctrl+C уходит в консоль как прерывание.
  if (ctrl && !e.shiftKey && e.code === 'KeyC' && session.term.hasSelection()) {
    navigator.clipboard.writeText(session.term.getSelection()).catch(() => {});
    session.term.clearSelection();
    return false;
  }
  if (ctrl && e.shiftKey && e.code === 'KeyC') {
    if (session.term.hasSelection()) navigator.clipboard.writeText(session.term.getSelection()).catch(() => {});
    return false;
  }
  // Ctrl+V: отдаём браузеру — он сгенерирует событие paste, которое xterm вставит (с bracketed paste).
  if (ctrl && e.code === 'KeyV') return false;
  // Shift+Enter: перевод строки в поле ввода Claude Code (ESC+CR, как Alt+Enter).
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    session.onInput('\x1b\r');
    return false;
  }
  if (handleAppShortcut(e)) return false;
  return true;
}

function isFocused(s) {
  return document.hasFocus() && activeId === s.id && s.isVisible();
}

// Индикатор «Claude работает / закончил»: идёт ли вывод в последние ~2 секунды.
setInterval(() => {
  const now = performance.now();
  let changed = false;
  for (const s of sessions.values()) {
    if (s.busy && now - s.lastOutput > 2000) {
      s.busy = false;
      changed = true;
      if (s.status === 'running' && s.lastOutput - s.busySince > 4000) s.markAttention();
    }
  }
  if (changed) renderIndicators();
}, 500);

window.addEventListener('focus', () => {
  const s = sessions.get(activeId);
  if (s && s.attention && s.isVisible()) { s.attention = false; renderIndicators(); }
});

native.on('output', (m) => sessions.get(m.id)?.onOutput(m.data));
native.on('exit', (m) => sessions.get(m.id)?.onExit(m.code));
native.on('spawned', (m) => {
  const s = sessions.get(m.id);
  if (!s) return;
  s.status = 'running';
  // Размер мог измениться, пока процесс стартовал.
  s.cols = 0;
  s.fitNow();
  renderIndicators();
});
native.on('spawnError', (m) => {
  const s = sessions.get(m.id);
  if (!s) return;
  s.status = 'exited';
  s.term.write(`\x1b[31mНе удалось запустить консоль: ${m.message}\x1b[0m\r\n`);
  toast(m.message, 'error');
  renderAll();
});

// ============================================================================
// Вкладки, сетка, активная сессия
// ============================================================================
function layoutCount() { return zoomedId ? 1 : state.settings.layout; }

function ensurePanes() {
  const n = state.settings.layout;
  // Удаляем мёртвые ссылки и подгоняем длину.
  panes = panes.map((id) => (id && sessions.has(id) ? id : null));
  if (panes.length > n) {
    // Не теряем активную сессию при уменьшении сетки.
    const dropped = panes.slice(n);
    panes = panes.slice(0, n);
    if (dropped.includes(activeId) && !panes.includes(activeId)) panes[n - 1] = activeId;
  }
  while (panes.length < n) panes.push(null);
  // Пустые ячейки заполняем невидимыми сессиями по порядку вкладок.
  for (let i = 0; i < panes.length; i++) {
    if (panes[i]) continue;
    const free = tabOrder.find((id) => !panes.includes(id));
    if (free == null) break;
    panes[i] = free;
  }
}

function focusedPaneIndex() {
  const i = panes.indexOf(activeId);
  return i >= 0 ? i : 0;
}

function activate(id, { focus = true } = {}) {
  const s = sessions.get(id);
  if (!s) return;
  if (zoomedId && zoomedId !== id) zoomedId = null;
  if (!panes.includes(id)) {
    const empty = panes.indexOf(null);
    panes[empty >= 0 ? empty : focusedPaneIndex()] = id;
  }
  activeId = id;
  s.attention = false;
  renderAll();
  if (focus) requestAnimationFrame(() => s.term.focus());
  native.send({ type: 'setTitle', title: s.name });
}

function addSession(opts) {
  const s = new Session(opts);
  sessions.set(s.id, s);
  tabOrder.push(s.id);
  const empty = panes.indexOf(null);
  if (zoomedId) zoomedId = null;
  panes[empty >= 0 ? empty : focusedPaneIndex()] = s.id;
  activeId = s.id;
  renderAll();
  requestAnimationFrame(() => {
    s.start();
    s.term.focus();
  });
  native.send({ type: 'setTitle', title: s.name });
  return s;
}

async function closeSession(id, { confirmFirst = true } = {}) {
  const s = sessions.get(id);
  if (!s) return;
  if (confirmFirst && s.status !== 'exited') {
    const ok = await confirmDialog({
      title: `Закрыть «${s.name}»?`,
      text: 'Консоль и всё, что в ней запущено (включая Claude Code), будет завершено.',
      okText: 'Закрыть', danger: true,
    });
    if (!ok) return;
  }
  const idx = tabOrder.indexOf(id);
  tabOrder = tabOrder.filter((x) => x !== id);
  panes = panes.map((x) => (x === id ? null : x));
  if (zoomedId === id) zoomedId = null;
  sessions.delete(id);
  s.dispose();
  if (activeId === id) {
    activeId = null;
    const next = tabOrder[Math.min(idx, tabOrder.length - 1)];
    if (next != null) { activate(next); return; }
    native.send({ type: 'setTitle', title: '' });
  }
  renderAll();
  saveState();
}

function cycleTab(dir) {
  if (!tabOrder.length) return;
  const i = tabOrder.indexOf(activeId);
  activate(tabOrder[(i + dir + tabOrder.length) % tabOrder.length]);
}

function setLayout(n) {
  zoomedId = null;
  state.settings.layout = n;
  ensurePanes();
  renderAll();
  saveState();
  sessions.get(activeId)?.term.focus();
}

function toggleZoom(id) {
  zoomedId = zoomedId === id ? null : id;
  activeId = id;
  renderAll();
  sessions.get(id)?.term.focus();
}

function placeInPane(id, paneIndex) {
  const from = panes.indexOf(id);
  if (from >= 0) panes[from] = panes[paneIndex];  // меняем местами
  panes[paneIndex] = id;
  activate(id);
}

function sessionLabel(s) {
  const same = tabOrder.map((id) => sessions.get(id)).filter((x) => x && x.projectId === s.projectId && x.name === s.name);
  if (same.length < 2) return s.name;
  return `${s.name} (${same.indexOf(s) + 1})`;
}

function dotClass(s) {
  if (s.status === 'exited') return 'exited';
  if (s.attention) return 'attention';
  if (s.busy) return 'busy';
  return s.status === 'running' ? 'running' : '';
}

function dotTitle(s) {
  if (s.status === 'exited') return 'Процесс завершён';
  if (s.attention) return 'Есть новости — Claude закончил или ждёт ответа';
  if (s.busy) return 'Идёт вывод (Claude работает)';
  return s.status === 'running' ? 'Ожидает ввода' : 'Запуск…';
}

// ---------- рендеринг ----------
function renderAll() {
  ensurePanes();
  renderTabs();
  renderGrid();
  renderProjects();
  renderWelcome();
}

let dragTabId = null;

function renderTabs() {
  const box = $('#tabs');
  box.replaceChildren(...tabOrder.map((id, i) => {
    const s = sessions.get(id);
    const tab = el('div', {
      class: `tab${id === activeId ? ' active' : ''}${panes.includes(id) && layoutCount() > 1 ? ' visible' : ''}${s.attention ? ' attention' : ''}`,
      role: 'tab', draggable: 'true',
      title: `${s.path}${s.title ? '\n' + s.title : ''}${i < 9 ? `\nCtrl+${i + 1}` : ''}`,
      dataset: { id },
      onclick: () => activate(id),
      onauxclick: (e) => { if (e.button === 1) closeSession(id); },
      ondragstart: (e) => { dragTabId = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(id)); },
      ondragend: () => { dragTabId = null; document.querySelectorAll('.drag-over,.drop-target').forEach((n) => n.classList.remove('drag-over', 'drop-target')); },
      ondragover: (e) => { if (dragTabId != null && dragTabId !== id) { e.preventDefault(); tab.classList.add('drag-over'); } },
      ondragleave: () => tab.classList.remove('drag-over'),
      ondrop: (e) => {
        e.preventDefault();
        if (dragTabId == null || dragTabId === id) return;
        tabOrder = tabOrder.filter((x) => x !== dragTabId);
        tabOrder.splice(tabOrder.indexOf(id), 0, dragTabId);
        renderTabs();
        saveState();
      },
    },
    el('span', { class: `dot ${dotClass(s)}`, title: dotTitle(s) }),
    el('span', { class: 'label' }, sessionLabel(s)),
    el('button', { class: 'icon-btn small close', title: 'Закрыть (Ctrl+Shift+W)', onclick: (e) => { e.stopPropagation(); closeSession(id); } }, icon(ICONS.close)));
    return tab;
  }));
  box.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderLayoutButtons() {
  const cells = { 1: [[0, 0, 1, 1]], 2: [[0, 0, 2, 1]], 4: [[0, 0, 2, 2]], 6: [[0, 0, 3, 2]], 8: [[0, 0, 4, 2]] };
  $('#layouts').replaceChildren(...LAYOUTS.map((n) => {
    const [[, , c, r]] = cells[n];
    let rects = '';
    const w = 18 / c, h = 14 / r;
    for (let y = 0; y < r; y++) for (let x = 0; x < c; x++) rects += `<rect x="${x * w + 1}" y="${y * h + 1}" width="${w - 2}" height="${h - 2}" rx="1"/>`;
    const b = el('button', {
      class: `layout-btn${state.settings.layout === n && !zoomedId ? ' active' : ''}`,
      title: n === 1 ? 'Одна консоль' : `${n} консоли на экране`,
      onclick: () => setLayout(n),
    });
    b.innerHTML = `<svg viewBox="0 0 20 16">${rects}</svg>`;
    return b;
  }));
}

function renderGrid() {
  renderLayoutButtons();
  const grid = $('#grid');
  const n = layoutCount();
  grid.dataset.layout = n;
  const ids = zoomedId ? [zoomedId] : panes;
  grid.hidden = sessions.size === 0;

  // Отцепляем терминалы, которые больше не видны (переносим на «стоянку», не уничтожая).
  const visible = new Set(ids.filter(Boolean));
  for (const s of sessions.values()) if (!visible.has(s.id) && s.host.parentElement?.id !== 'parking') $('#parking').append(s.host);

  const existing = [...grid.children];
  const nodes = ids.map((id, i) => {
    const pane = existing[i] || createPane();
    pane.dataset.index = zoomedId ? panes.indexOf(zoomedId) : i;
    fillPane(pane, id);
    return pane;
  });
  existing.slice(ids.length).forEach((p) => p.remove());
  for (const p of nodes) if (p.parentElement !== grid) grid.append(p);
  nodes.forEach((p, i) => { if (grid.children[i] !== p) grid.insertBefore(p, grid.children[i]); });

  requestAnimationFrame(() => { for (const id of visible) sessions.get(id)?.fitNow(); });
}

function createPane() {
  const pane = el('div', { class: 'pane' });
  const header = el('div', { class: 'pane-header' });
  const body = el('div', { class: 'pane-body' });
  pane.append(header, body);
  pane.addEventListener('dragover', (e) => { if (dragTabId != null) { e.preventDefault(); pane.classList.add('drop-target'); } });
  pane.addEventListener('dragleave', (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove('drop-target'); });
  pane.addEventListener('drop', (e) => {
    e.preventDefault();
    pane.classList.remove('drop-target');
    if (dragTabId != null) placeInPane(dragTabId, Number(pane.dataset.index));
  });
  header.addEventListener('dblclick', (e) => { if (!e.target.closest('button') && pane.dataset.session) toggleZoom(Number(pane.dataset.session)); });
  header.addEventListener('mousedown', () => { if (pane.dataset.session) activate(Number(pane.dataset.session)); });
  new ResizeObserver(() => {
    const id = Number(pane.dataset.session);
    if (id) sessions.get(id)?.fitNow();
  }).observe(body);
  return pane;
}

function fillPane(pane, id) {
  const header = pane.querySelector('.pane-header');
  const body = pane.querySelector('.pane-body');
  const s = id ? sessions.get(id) : null;
  pane.dataset.session = s ? s.id : '';
  pane.classList.toggle('focused', !!s && s.id === activeId && layoutCount() > 1);

  if (!s) {
    header.replaceChildren(el('div', { class: 'pane-title' }, el('span', {}, 'Пустая ячейка')));
    const hidden = tabOrder.filter((x) => !panes.includes(x)).map((x) => sessions.get(x));
    const chips = hidden.map((h) => el('button', { class: 'chip', onclick: () => placeInPane(h.id, Number(pane.dataset.index)) },
      el('span', { class: `dot ${dotClass(h)}` }), sessionLabel(h)));
    body.replaceChildren(el('div', { class: 'pane-empty' },
      el('div', {}, hidden.length ? 'Показать здесь консоль:' : 'Откройте проект из списка слева'),
      hidden.length ? el('div', { class: 'chips' }, chips) : null));
    return;
  }

  header.replaceChildren(
    el('span', { class: `dot ${dotClass(s)}`, title: dotTitle(s) }),
    el('div', { class: 'pane-title', title: s.path }, el('b', {}, sessionLabel(s)), el('span', {}, s.title || s.path)),
    el('button', { class: 'icon-btn small', title: zoomedId ? 'Вернуть сетку' : 'Развернуть (двойной клик по заголовку)', onclick: () => toggleZoom(s.id) }, icon(ICONS.expand)),
    el('button', { class: 'icon-btn small', title: 'Перезапустить', onclick: () => s.restart() }, icon(ICONS.restart)),
    el('button', { class: 'icon-btn small', title: 'Закрыть консоль', onclick: () => closeSession(s.id) }, icon(ICONS.close)),
  );
  if (s.host.parentElement !== body) body.replaceChildren(s.host);
}

function renderPaneHeaders() {
  for (const pane of $('#grid').children) {
    const id = Number(pane.dataset.session);
    if (id) fillPane(pane, id);
  }
}

// Лёгкое обновление только индикаторов (часто вызывается при выводе).
function renderIndicators() {
  renderTabs();
  renderPaneHeaders();
  renderProjects();
}

// ============================================================================
// Проекты
// ============================================================================
function sortedProjects() {
  const q = search.trim().toLowerCase();
  return state.projects
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    .sort((a, b) => (b.pinned - a.pinned) || ((b.lastOpened || 0) - (a.lastOpened || 0)) || a.name.localeCompare(b.name, 'ru'));
}

function projectSessions(p) { return tabOrder.map((id) => sessions.get(id)).filter((s) => s && s.projectId === p.id); }

function renderProjects() {
  const list = $('#project-list');
  const items = sortedProjects();
  const activeProject = sessions.get(activeId)?.projectId;
  if (!items.length) {
    list.replaceChildren(el('li', { class: 'empty-list' }, state.projects.length ? 'Ничего не найдено' : 'Здесь появятся открытые проекты'));
    return;
  }
  list.replaceChildren(...items.map((p) => {
    const open = projectSessions(p);
    const missing = !p.ssh && missingPaths.has(normPath(p.path));
    const attention = open.some((s) => s.attention);
    return el('li', {
      class: `project${p.id === activeProject ? ' active' : ''}${missing ? ' missing' : ''}`,
      title: `${p.path}${missing ? '\nПапка не найдена' : ''}\nКлик — открыть, правый клик — меню`,
      onclick: () => openProject(p),
      oncontextmenu: (e) => { e.preventDefault(); projectMenu(p, e.clientX, e.clientY); },
    },
    el('div', { class: 'project-name' },
      p.pinned ? icon(ICONS.pin, 'pin') : null,
      el('span', {}, p.name),
      p.ssh ? el('span', { class: 'tag', title: 'Проект на сервере (SSH)' }, 'SSH') : null,
      attention ? el('span', { class: 'dot attention', title: 'Claude ждёт' }) : null),
    el('div', {},
      open.length ? el('span', { class: 'open-count', title: 'Открытых консолей' }, open.length) : null,
      el('div', { class: 'project-actions' },
        el('button', { class: 'icon-btn small', title: 'Ещё одна консоль с Claude', onclick: (e) => { e.stopPropagation(); openProject(p, { forceNew: true }); } }, icon(ICONS.plus)),
        el('button', { class: 'icon-btn small', title: 'Переименовать / настроить', onclick: (e) => { e.stopPropagation(); editProjectDialog(p); } }, icon(ICONS.edit)))),
    el('div', { class: 'project-meta' }, el('bdi', {}, `${relTime(p.lastOpened)} · ${p.path}`)));
  }));
}

function renderWelcome() {
  const empty = sessions.size === 0;
  $('#welcome').hidden = !empty;
  $('#grid').hidden = empty;
  if (!empty) return;
  const recent = sortedProjects().slice(0, 6);
  $('#welcome-recent').replaceChildren(...recent.map((p) => el('button', { class: 'chip', title: p.path, onclick: () => openProject(p) }, icon(ICONS.play), p.name)));
}

function findProjectByPath(path) {
  const n = normPath(path);
  return state.projects.find((p) => normPath(p.path) === n);
}

function addProject(name, path) {
  const existing = findProjectByPath(path);
  if (existing) return existing;
  const p = { id: uid(), name: name || baseName(path), path, command: '', pinned: false, createdAt: Date.now(), lastOpened: 0, openCount: 0 };
  state.projects.push(p);
  missingPaths.delete(normPath(path));
  saveState();
  return p;
}

async function openProject(p, { forceNew = false, plain = false, install = null } = {}) {
  if (!forceNew && !plain) {
    const open = projectSessions(p);
    if (open.length) {
      activate((open.find((s) => s.attention) || open[open.length - 1]).id);
      return;
    }
  }
  if (!p.ssh && missingPaths.has(normPath(p.path))) {
    toast(`Папка не найдена: ${p.path}`, 'error');
  }
  // Параметры подключения менялись (или ключ ещё не готовился) — сначала готовим ключ.
  if (p.ssh && !p.ssh.keyPath && !install) {
    toast(`Подключаюсь к ${p.ssh.host}…`);
    const r = await native.request('sshPrepare', { host: p.ssh.host, port: Number(p.ssh.port) || 22, user: p.ssh.user });
    if (r.error) { toast(r.error, 'error'); return; }
    p.ssh.keyPath = r.keyPath;
    if (r.needsInstall) install = { publicKey: r.publicKey, password: '' };
  }
  p.lastOpened = Date.now();
  p.openCount = (p.openCount || 0) + 1;
  const command = plain ? '' : (p.command || state.settings.command || '').trim();
  addSession({ projectId: p.id, name: p.name, path: p.path, command, ssh: p.ssh ? { ...p.ssh } : null, install });
  saveState();
}

function removeProject(p) {
  state.projects = state.projects.filter((x) => x !== p);
  renderProjects();
  renderWelcome();
  saveState();
}

async function refreshMissing() {
  const paths = state.projects.filter((p) => !p.ssh).map((p) => p.path);
  if (!paths.length) return;
  const r = await native.request('checkPaths', { paths });
  missingPaths = new Set(paths.filter((_, i) => r.exists && !r.exists[i]).map(normPath));
  renderProjects();
}

// ---------- контекстное меню проекта ----------
function closeMenu() { $('#menu-root').replaceChildren(); }

function showMenu(items, x, y) {
  const menu = el('div', { class: 'menu', role: 'menu' }, items.map((it) => it === '-' ? el('hr') :
    el('button', { class: it.danger ? 'danger' : '', onclick: () => { closeMenu(); it.action(); } }, icon(it.icon), it.label)));
  $('#menu-root').replaceChildren(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) closeMenu(); });
window.addEventListener('blur', closeMenu);

function projectMenu(p, x, y) {
  showMenu([
    { icon: ICONS.play, label: 'Открыть', action: () => openProject(p) },
    { icon: ICONS.plus, label: 'Ещё одна консоль с Claude', action: () => openProject(p, { forceNew: true }) },
    { icon: ICONS.terminal, label: 'Консоль без Claude', action: () => openProject(p, { plain: true }) },
    '-',
    { icon: ICONS.edit, label: 'Переименовать / настроить…', action: () => editProjectDialog(p) },
    { icon: ICONS.pin, label: p.pinned ? 'Открепить' : 'Закрепить сверху', action: () => { p.pinned = !p.pinned; renderProjects(); saveState(); } },
    p.ssh ? null : { icon: ICONS.folder, label: 'Показать в проводнике', action: () => native.send({ type: 'openFolder', path: p.path }) },
    '-',
    { icon: ICONS.trash, label: 'Убрать из списка', danger: true, action: async () => {
      const text = p.ssh ? 'Файлы на сервере и SSH-ключ не будут затронуты.' : 'Папка и файлы на диске не будут затронуты.';
      if (await confirmDialog({ title: `Убрать «${p.name}» из списка?`, text, okText: 'Убрать', danger: true })) removeProject(p);
    } },
  ].filter(Boolean), x, y);
}

// ============================================================================
// Диалоги
// ============================================================================
function openModal(build) {
  const prevFocus = document.activeElement;
  const root = $('#modal-root');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    (sessions.get(activeId)?.term || prevFocus)?.focus?.();
  };
  const backdrop = el('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } });
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  backdrop.append(modal);
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  build(modal, close);
  root.append(backdrop);
  requestAnimationFrame(() => (modal.querySelector('[autofocus]') || modal.querySelector('input,button.primary,button'))?.focus());
  return close;
}

function confirmDialog({ title, text, okText = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    openModal((modal, closeFn) => {
      const form = el('form', { onsubmit: (e) => { e.preventDefault(); result = true; closeFn(); resolve(true); } },
        el('div', { class: 'modal-actions' },
          el('button', { type: 'button', class: 'btn', onclick: () => { closeFn(); resolve(false); } }, 'Отмена'),
          el('button', { type: 'submit', class: `btn ${danger ? 'danger' : 'primary'}`, autofocus: true }, okText)));
      modal.append(el('h2', {}, title), text ? el('div', { class: 'modal-sub' }, text) : null, form);
    });
    // Закрытие по Esc/клику мимо = отмена.
    const obs = new MutationObserver(() => { if (!$('#modal-root').children.length) { obs.disconnect(); if (!result) resolve(false); } });
    obs.observe($('#modal-root'), { childList: true });
  });
}

function sanitizeFolderName(name) {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
}

function defaultProjectsRoot() {
  return state.settings.projectsRoot || (env.home ? `${env.home}\\Projects` : '');
}

function createProjectDialog() {
  openModal((modal, close) => {
    let folderTouched = false;
    const name = el('input', { type: 'text', placeholder: 'Например: Интернет-магазин', autofocus: true, spellcheck: 'false' });
    const folder = el('input', { type: 'text', class: 'mono', placeholder: 'internet-magazin', spellcheck: 'false' });
    const parent = el('input', { type: 'text', class: 'mono', value: defaultProjectsRoot(), spellcheck: 'false' });
    const preview = el('div', { class: 'preview-path' });
    const error = el('div', { class: 'modal-error' });
    const launch = el('input', { type: 'checkbox', checked: true });
    const submit = el('button', { type: 'submit', class: 'btn primary' }, 'Создать и запустить');

    const update = () => {
      if (!folderTouched) folder.value = sanitizeFolderName(name.value);
      const f = sanitizeFolderName(folder.value);
      preview.textContent = f && parent.value ? `${parent.value.replace(/[\\/]+$/, '')}\\${f}` : '';
      submit.textContent = launch.checked ? 'Создать и запустить' : 'Создать';
    };
    name.addEventListener('input', update);
    folder.addEventListener('input', () => { folderTouched = folder.value !== ''; update(); });
    parent.addEventListener('input', update);
    launch.addEventListener('change', update);

    const browse = el('button', { type: 'button', class: 'btn', onclick: async () => {
      const r = await native.request('pickFolder', { title: 'Где создать папку проекта', initial: parent.value });
      if (r.path) { parent.value = r.path; update(); }
    } }, 'Обзор…');

    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault();
      const displayName = name.value.trim();
      const folderName = sanitizeFolderName(folder.value || displayName);
      if (!displayName && !folderName) { error.textContent = 'Введите название проекта'; name.focus(); return; }
      submit.disabled = true;
      const r = await native.request('createFolder', { parent: parent.value.trim(), name: folderName });
      submit.disabled = false;
      if (r.error) { error.textContent = r.error; return; }
      state.settings.projectsRoot = parent.value.trim();
      const existing = findProjectByPath(r.path);
      const p = existing || addProject(displayName || folderName, r.path);
      if (existing && displayName) p.name = displayName;
      close();
      if (r.existed) toast('Папка уже существовала — добавлена как проект');
      if (launch.checked) openProject(p, { forceNew: true }); else renderProjects();
      saveState();
    } },
      el('div', { class: 'field' }, el('label', {}, 'Название проекта'), name),
      el('div', { class: 'field' }, el('label', {}, 'Имя папки'), folder),
      el('div', { class: 'field' }, el('label', {}, 'Где создать'), el('div', { class: 'row' }, parent, browse), preview),
      el('label', { class: 'check' }, launch, 'Сразу открыть консоль и запустить Claude'),
      error,
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'), submit));

    modal.append(el('h2', {}, 'Новый проект'), el('div', { class: 'modal-sub' }, 'Будет создана папка, в ней откроется PowerShell и запустится Claude Code.'), form);
    update();
  });
}

function openProjectFlow() {
  openModal((modal, close) => {
    const card = (ic, title, text, action, disabled) => el('button', { type: 'button', class: 'choice-card', disabled, onclick: () => { close(); action(); } },
      icon(ic), el('b', {}, title), el('span', {}, text));
    modal.append(el('h2', {}, 'Открыть проект'), el('div', { class: 'choice' },
      card(ICONS.folder, 'Папка на компьютере', 'Выбрать существующую папку', openLocalFolderFlow, false),
      card(ICONS.server, 'Сервер по SSH', env.hasSsh ? 'Подключиться к серверу, ключ создадим автоматически' : 'Не найден клиент OpenSSH (ssh.exe)',
        sshProjectDialog, !env.hasSsh)));
  });
}

function sshProjectDialog() {
  openModal((modal, close) => {
    const name = el('input', { type: 'text', placeholder: 'Например: Бот на сервере', spellcheck: 'false' });
    const host = el('input', { type: 'text', class: 'mono', placeholder: '192.168.1.10 или example.com', autofocus: true, spellcheck: 'false' });
    const port = el('input', { type: 'number', min: 1, max: 65535, value: 22, class: 'port' });
    const user = el('input', { type: 'text', class: 'mono', placeholder: 'root', spellcheck: 'false' });
    const dir = el('input', { type: 'text', class: 'mono', placeholder: '~/projects/my-app', spellcheck: 'false' });
    const password = el('input', { type: 'password', autocomplete: 'new-password' });
    const status = el('div', { class: 'hint' });
    const error = el('div', { class: 'modal-error' });
    const submit = el('button', { type: 'submit', class: 'btn primary' }, 'Подключить');

    // Можно вставить «user@host» или «user@host:port» целиком в поле сервера.
    host.addEventListener('change', () => {
      const m = host.value.trim().match(/^([^@\s]+)@([^:\s]+)(?::(\d+))?$/);
      if (m) { user.value = m[1]; host.value = m[2]; if (m[3]) port.value = m[3]; }
    });

    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      const h = host.value.trim(), u = user.value.trim() || 'root', d = dir.value.trim() || '~';
      const pt = Number(port.value) || 22;
      if (!h) { error.textContent = 'Укажите адрес сервера'; host.focus(); return; }
      submit.disabled = true;
      status.textContent = 'Готовлю ключ и проверяю подключение…';
      const r = await native.request('sshPrepare', { host: h, port: pt, user: u });
      submit.disabled = false;
      status.textContent = '';
      if (r.error) { error.textContent = r.error; return; }

      const ssh = { host: h, port: pt, user: u, dir: d, keyPath: r.keyPath };
      const label = sshLabel(ssh);
      let p = findProjectByPath(label);
      if (!p) p = addProject(name.value.trim() || `${h}:${d}`, label);
      else if (name.value.trim()) p.name = name.value.trim();
      p.ssh = ssh;
      close();
      if (r.keyCreated) toast(`Создан ключ ${r.keyPath}`);
      if (r.authOk) toast('Сервер уже принимает этот ключ — вход без пароля');
      openProject(p, { forceNew: true, install: r.needsInstall ? { publicKey: r.publicKey, password: password.value } : null });
      saveState();
    } },
      el('div', { class: 'field' }, el('label', {}, 'Название проекта'), name),
      el('div', { class: 'field' }, el('label', {}, 'Сервер и порт'), el('div', { class: 'row' }, host, port)),
      el('div', { class: 'field' }, el('label', {}, 'Пользователь'), user),
      el('div', { class: 'field' }, el('label', {}, 'Папка на сервере'), dir,
        el('div', { class: 'hint' }, 'Там откроется консоль и запустится claude (он должен быть установлен на сервере).')),
      el('div', { class: 'field' }, el('label', {}, 'Пароль'), password,
        el('div', { class: 'hint' }, 'Нужен один раз — чтобы установить ключ на сервер. Нигде не сохраняется. Если вход по ключу уже настроен, оставьте пустым.')),
      status, error,
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'), submit));
    modal.append(el('h2', {}, 'Проект на сервере (SSH)'),
      el('div', { class: 'modal-sub' }, 'Будет создан ключ ~/.ssh/id_ed25519_<сервер> и добавлен на сервер — дальше подключение без пароля.'), form);
  });
}

async function openLocalFolderFlow() {
  const r = await native.request('pickFolder', { title: 'Выберите папку проекта', initial: defaultProjectsRoot() });
  if (!r.path) return;
  const existing = findProjectByPath(r.path);
  if (existing) { openProject(existing); return; }
  openModal((modal, close) => {
    const name = el('input', { type: 'text', value: baseName(r.path), autofocus: true, spellcheck: 'false' });
    const form = el('form', { onsubmit: (e) => {
      e.preventDefault();
      const p = addProject(name.value.trim() || baseName(r.path), r.path);
      close();
      openProject(p);
    } },
      el('div', { class: 'field' }, el('label', {}, 'Название проекта'), name, el('div', { class: 'preview-path' }, r.path)),
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'), el('button', { type: 'submit', class: 'btn primary' }, 'Открыть')));
    modal.append(el('h2', {}, 'Открыть проект'), form);
    requestAnimationFrame(() => name.select());
  });
}

function editProjectDialog(p) {
  if (p.ssh) return editSshProjectDialog(p);
  openModal((modal, close) => {
    const name = el('input', { type: 'text', value: p.name, autofocus: true, spellcheck: 'false' });
    const path = el('input', { type: 'text', class: 'mono', value: p.path, spellcheck: 'false' });
    const command = el('input', { type: 'text', class: 'mono', value: p.command || '', placeholder: state.settings.command || DEFAULT_COMMAND, spellcheck: 'false' });
    const error = el('div', { class: 'modal-error' });
    const browse = el('button', { type: 'button', class: 'btn', onclick: async () => {
      const r = await native.request('pickFolder', { title: 'Папка проекта', initial: path.value });
      if (r.path) path.value = r.path;
    } }, 'Обзор…');
    const form = el('form', { onsubmit: (e) => {
      e.preventDefault();
      const newPath = path.value.trim();
      const clash = findProjectByPath(newPath);
      if (clash && clash !== p) { error.textContent = `Эта папка уже есть в списке как «${clash.name}»`; return; }
      p.name = name.value.trim() || baseName(newPath);
      p.path = newPath;
      p.command = command.value.trim();
      for (const s of projectSessions(p)) s.name = p.name;
      close();
      renderAll();
      refreshMissing();
      saveState();
    } },
      el('div', { class: 'field' }, el('label', {}, 'Название'), name),
      el('div', { class: 'field' }, el('label', {}, 'Папка'), el('div', { class: 'row' }, path, browse)),
      el('div', { class: 'field' }, el('label', {}, 'Команда запуска для этого проекта'), command,
        el('div', { class: 'hint' }, 'Пусто — команда из настроек. Например: claude --continue --dangerously-skip-permissions')),
      error,
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'), el('button', { type: 'submit', class: 'btn primary' }, 'Сохранить')));
    modal.append(el('h2', {}, 'Проект'), form);
    requestAnimationFrame(() => name.select());
  });
}

function editSshProjectDialog(p) {
  openModal((modal, close) => {
    const name = el('input', { type: 'text', value: p.name, autofocus: true, spellcheck: 'false' });
    const host = el('input', { type: 'text', class: 'mono', value: p.ssh.host, spellcheck: 'false' });
    const port = el('input', { type: 'number', min: 1, max: 65535, value: p.ssh.port || 22, class: 'port' });
    const user = el('input', { type: 'text', class: 'mono', value: p.ssh.user, spellcheck: 'false' });
    const dir = el('input', { type: 'text', class: 'mono', value: p.ssh.dir || '~', spellcheck: 'false' });
    const command = el('input', { type: 'text', class: 'mono', value: p.command || '', placeholder: state.settings.command || DEFAULT_COMMAND, spellcheck: 'false' });
    const error = el('div', { class: 'modal-error' });
    const form = el('form', { onsubmit: (e) => {
      e.preventDefault();
      const ssh = { host: host.value.trim(), port: Number(port.value) || 22, user: user.value.trim(), dir: dir.value.trim() || '~', keyPath: p.ssh.keyPath };
      if (!ssh.host || !ssh.user) { error.textContent = 'Укажите сервер и пользователя'; return; }
      const label = sshLabel(ssh);
      const clash = findProjectByPath(label);
      if (clash && clash !== p) { error.textContent = `Такой проект уже есть: «${clash.name}»`; return; }
      // Сменился сервер, пользователь или порт — ключ подготовим заново при следующем открытии.
      if (ssh.host !== p.ssh.host || ssh.user !== p.ssh.user || ssh.port !== (Number(p.ssh.port) || 22)) ssh.keyPath = '';
      p.ssh = ssh;
      p.path = label;
      p.name = name.value.trim() || `${ssh.host}:${ssh.dir}`;
      p.command = command.value.trim();
      for (const s of projectSessions(p)) s.name = p.name;
      close();
      renderAll();
      saveState();
    } },
      el('div', { class: 'field' }, el('label', {}, 'Название'), name),
      el('div', { class: 'field' }, el('label', {}, 'Сервер и порт'), el('div', { class: 'row' }, host, port)),
      el('div', { class: 'field' }, el('label', {}, 'Пользователь'), user),
      el('div', { class: 'field' }, el('label', {}, 'Папка на сервере'), dir),
      el('div', { class: 'field' }, el('label', {}, 'Команда запуска на сервере'), command,
        el('div', { class: 'hint' }, `Пусто — команда из настроек. Ключ: ${p.ssh.keyPath || 'будет создан при подключении'}`)),
      error,
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'), el('button', { type: 'submit', class: 'btn primary' }, 'Сохранить')));
    modal.append(el('h2', {}, 'Проект на сервере'), form);
    requestAnimationFrame(() => name.select());
  });
}

function settingsDialog() {
  openModal((modal, close) => {
    const st = state.settings;
    const shells = ['powershell.exe', 'pwsh.exe'];
    const shell = el('select', {}, shells.map((sh) => el('option', { value: sh, selected: st.shell === sh },
      sh === 'pwsh.exe' ? `PowerShell 7 (pwsh.exe)${env.hasPwsh ? '' : ' — не установлен'}` : 'Windows PowerShell (powershell.exe)')));
    if (!shells.includes(st.shell)) shell.append(el('option', { value: st.shell, selected: true }, st.shell));
    const command = el('input', { type: 'text', class: 'mono', value: st.command, spellcheck: 'false' });
    const fontSize = el('input', { type: 'number', min: 8, max: 32, value: st.fontSize });
    const root = el('input', { type: 'text', class: 'mono', value: defaultProjectsRoot(), spellcheck: 'false' });
    const restore = el('input', { type: 'checkbox', checked: st.restoreSessions });
    const browse = el('button', { type: 'button', class: 'btn', onclick: async () => {
      const r = await native.request('pickFolder', { title: 'Папка для новых проектов', initial: root.value });
      if (r.path) root.value = r.path;
    } }, 'Обзор…');

    const form = el('form', { onsubmit: (e) => {
      e.preventDefault();
      st.shell = shell.value;
      st.command = command.value.trim();
      st.projectsRoot = root.value.trim();
      st.restoreSessions = restore.checked;
      const fs = Math.min(32, Math.max(8, Number(fontSize.value) || 14));
      if (fs !== st.fontSize) applyFontSize(fs);
      close();
      saveState();
    } },
      el('div', { class: 'field' }, el('label', {}, 'Оболочка'), shell),
      el('div', { class: 'field' }, el('label', {}, 'Команда при открытии проекта'), command,
        el('div', { class: 'hint' }, `По умолчанию: ${DEFAULT_COMMAND}. Пусто — просто консоль.${env.hasClaude ? '' : ' Внимание: claude не найден в PATH.'}`)),
      el('div', { class: 'field' }, el('label', {}, 'Папка для новых проектов'), el('div', { class: 'row' }, root, browse)),
      el('div', { class: 'field' }, el('label', {}, 'Размер шрифта консоли'), fontSize),
      el('label', { class: 'check' }, restore, 'При запуске снова открывать проекты из прошлого сеанса'),
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'), el('button', { type: 'submit', class: 'btn primary' }, 'Сохранить')));
    modal.append(el('h2', {}, 'Настройки'), form);
  });
}

function applyFontSize(size) {
  state.settings.fontSize = size;
  for (const s of sessions.values()) s.setFontSize(size);
  saveState();
}

function toggleSidebar() {
  state.settings.sidebar = !state.settings.sidebar;
  $('#app').classList.toggle('no-sidebar', !state.settings.sidebar);
  saveState();
  requestAnimationFrame(() => { for (const s of sessions.values()) s.fitNow(); });
}

// ============================================================================
// Горячие клавиши
// ============================================================================
function handleAppShortcut(e) {
  if (document.querySelector('.modal-backdrop')) return false;
  const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
  if (!ctrl) return false;
  const run = (fn) => { e.preventDefault(); fn(); return true; };

  if (e.code === 'Tab') return run(() => cycleTab(e.shiftKey ? -1 : 1));
  if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    const id = tabOrder[Number(e.code.slice(5)) - 1];
    return id != null ? run(() => activate(id)) : false;
  }
  if (!e.shiftKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) return run(() => applyFontSize(Math.min(32, state.settings.fontSize + 1)));
  if (!e.shiftKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) return run(() => applyFontSize(Math.max(8, state.settings.fontSize - 1)));
  if (!e.shiftKey && (e.code === 'Digit0' || e.code === 'Numpad0')) return run(() => applyFontSize(14));
  if (e.shiftKey) {
    switch (e.code) {
      case 'KeyW': return activeId != null ? run(() => closeSession(activeId)) : false;
      case 'KeyN': return run(createProjectDialog);
      case 'KeyO': return run(openProjectFlow);
      case 'KeyB': return run(toggleSidebar);
      case 'Enter': return activeId != null ? run(() => toggleZoom(activeId)) : false;
    }
  }
  return false;
}

document.addEventListener('keydown', (e) => {
  // Срабатывает, когда фокус не в терминале (терминал обрабатывает свои клавиши сам).
  if (e.target.closest?.('.xterm')) return;
  if (e.target.matches?.('input, select, textarea')) return;
  handleAppShortcut(e);
});

// Ctrl+колесо — размер шрифта.
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  e.stopPropagation();
  applyFontSize(Math.min(32, Math.max(8, state.settings.fontSize + (e.deltaY < 0 ? 1 : -1))));
}, { passive: false, capture: true });

// ============================================================================
// Запуск
// ============================================================================
$('#btn-create').addEventListener('click', createProjectDialog);
$('#btn-open').addEventListener('click', openProjectFlow);
$('#btn-settings').addEventListener('click', settingsDialog);
$('#btn-sidebar').addEventListener('click', toggleSidebar);
$('#search').addEventListener('input', (e) => { search = e.target.value; renderProjects(); });
$('#welcome').addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (a === 'create') createProjectDialog();
  if (a === 'open') openProjectFlow();
});
setInterval(renderProjects, 60_000);  // обновить «N мин назад»

native.on('init', async (m) => {
  Object.assign(env, { home: m.home || '', hasPwsh: !!m.hasPwsh, hasClaude: m.hasClaude !== false, osBuild: m.osBuild || 0, hasSsh: !!m.hasSsh });
  const saved = m.state;
  if (saved && typeof saved === 'object') {
    if (Array.isArray(saved.projects)) state.projects = saved.projects.filter((p) => p && p.path);
    Object.assign(state.settings, saved.settings || {});
    if (Array.isArray(saved.openProjects)) state.openProjects = saved.openProjects;
  }
  if (!LAYOUTS.includes(state.settings.layout)) state.settings.layout = 1;
  $('#app').classList.toggle('no-sidebar', !state.settings.sidebar);
  if (!env.hasClaude) toast('claude не найден в PATH — консоль откроется, но команда запуска может не сработать.', 'error');

  renderAll();
  await refreshMissing();

  if (state.settings.restoreSessions) {
    for (const pid of state.openProjects) {
      const p = state.projects.find((x) => x.id === pid);
      if (p && !missingPaths.has(normPath(p.path))) openProject(p, { forceNew: true });
    }
  }
});

if (native.available) native.send({ type: 'ready' });
else renderAll();
