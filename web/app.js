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
const DEFAULT_COMMAND = 'claude --dangerously-skip-permissions';  // команда из старых версий — для переноса настроек
const LAYOUTS = [1, 2, 4, 6, 8];

const state = {
  projects: [],     // { id, name, path, command, pinned, createdAt, lastOpened, openCount }
  settings: {
    shell: 'powershell.exe',
    defaultLaunch: { agent: 'claude', mode: 'skip', custom: '', cont: false },  // агент для новых проектов
    agentOverrides: {},  // свои команды/флаги агентов: { id: { cmd, yolo, cont } }
    layout: 1,
    fontSize: 14,
    sidebar: true,
    projectsRoot: '',
    restoreSessions: false,
    checkUpdates: true,
  },
  openProjects: [], // проекты, открытые при последнем закрытии (для восстановления)
};

const env = { home: '', hasPwsh: false, osBuild: 0, hasSsh: false, version: '' };

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

function sshLabel(ssh) {
  return `${ssh.user}@${ssh.host}${Number(ssh.port) && Number(ssh.port) !== 22 ? `:${ssh.port}` : ''}:${ssh.dir || '~'}`;
}

// ============================================================================
// ИИ-агенты: Claude Code, Codex (ChatGPT), Gemini, Grok и другие
// ============================================================================
// yolo   — флаг «без подтверждений»; cont — продолжить прошлый разговор;
// prompt — как передать начальное задание: 'arg' — аргументом, '--флаг' — через флаг,
//          'type' — агент так не умеет, программа сама впишет текст в поле ввода после запуска;
// rootEnv — без этого агент под root отказывается работать без подтверждений.
// Команды и флаги можно переопределить в настройках («Команды агентов»).
const AGENTS = [
  { id: 'claude', name: 'Claude Code', short: 'Claude', cmd: 'claude', yolo: '--dangerously-skip-permissions', cont: '--continue', prompt: 'arg', rootEnv: 'IS_SANDBOX=1' },
  { id: 'codex', name: 'Codex (ChatGPT)', short: 'Codex', cmd: 'codex', yolo: '--dangerously-bypass-approvals-and-sandbox', cont: 'resume --last', prompt: 'arg' },
  { id: 'gemini', name: 'Gemini CLI', short: 'Gemini', cmd: 'gemini', yolo: '--yolo', cont: '--resume latest', prompt: '--prompt-interactive' },
  { id: 'grok', name: 'Grok', short: 'Grok', cmd: 'grok', yolo: '--always-approve', cont: '--continue', prompt: 'arg' },
  { id: 'kimi', name: 'Kimi Code', short: 'Kimi', cmd: 'kimi', yolo: '--yolo', cont: '--continue', prompt: 'type' },
  { id: 'qwen', name: 'Qwen Code', short: 'Qwen', cmd: 'qwen', yolo: '--yolo', cont: '--continue', prompt: '--prompt-interactive' },
  { id: 'copilot', name: 'GitHub Copilot CLI', short: 'Copilot', cmd: 'copilot', yolo: '--allow-all-tools', cont: '--continue', prompt: '--interactive' },
  { id: 'cursor', name: 'Cursor Agent', short: 'Cursor', cmd: 'cursor-agent', yolo: '--force', cont: 'resume', prompt: 'arg' },
  { id: 'opencode', name: 'OpenCode', short: 'OpenCode', cmd: 'opencode', yolo: '--auto', cont: '--continue', prompt: '--prompt' },
  { id: 'mimo', name: 'MiMo Code', short: 'MiMo', cmd: 'mimo', yolo: '--yolo', cont: '--continue', prompt: '--prompt' },
  { id: 'aider', name: 'Aider', short: 'Aider', cmd: 'aider', yolo: '--yes-always', cont: '--restore-chat-history', prompt: 'type' },
];

const LAUNCH_MODES = [
  { id: 'skip', label: 'Без подтверждений' },
  { id: 'normal', label: 'С подтверждениями' },
  { id: 'shell', label: 'Только консоль' },
  { id: 'custom', label: 'Своя команда…' },
];

// Агент с учётом переопределений из настроек.
function agentDef(id) {
  const base = AGENTS.find((a) => a.id === id) || AGENTS[0];
  const o = (state.settings.agentOverrides || {})[base.id] || {};
  return { ...base, cmd: o.cmd || base.cmd, yolo: o.yolo || base.yolo, cont: o.cont || base.cont };
}

// Приводит описание запуска к текущему формату (в том числе старые проекты «только Claude»).
function normalizeLaunch(launch) {
  const l = { agent: 'claude', mode: 'skip', custom: '', cont: false, ...(launch || {}) };
  if (l.mode === 'sandbox') l.mode = 'skip';  // раньше был отдельный вариант «под root»; теперь IS_SANDBOX ставится сам
  if (!LAUNCH_MODES.some((m) => m.id === l.mode)) l.mode = 'skip';
  if (!AGENTS.some((a) => a.id === l.agent)) l.agent = 'claude';
  return l;
}

function defaultLaunch() { return normalizeLaunch(state.settings.defaultLaunch); }

// Текст задания одной строкой; двойные кавычки PowerShell 5 теряет при передаче аргументов программам.
const cleanPrompt = (text) => text.replace(/\s*\n\s*/g, ' ').replace(/"/g, "'").replace(/\\+$/, '').trim();
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Команда запуска агента. shell: 'ps' — локальный PowerShell, 'sh' — оболочка на сервере.
// Возвращает { command, typePrompt }: typePrompt нужно вписать в агента после запуска.
function buildLaunch(launch, { shell = 'ps', root = false, prompt = '' } = {}) {
  const l = normalizeLaunch(launch);
  if (l.mode === 'shell') return { command: '', typePrompt: '' };
  if (l.mode === 'custom') return { command: (l.custom || '').trim(), typePrompt: '' };
  const a = agentDef(l.agent);
  const q = shell === 'sh' ? shQuote : psQuote;
  const parts = [a.cmd];
  if (l.cont && a.cont) parts.push(a.cont);
  if (l.mode === 'skip' && a.yolo) parts.push(a.yolo);
  let typePrompt = '';
  const text = prompt && !l.cont ? cleanPrompt(prompt) : '';  // при продолжении задание уже есть в истории
  if (text) {
    if (a.prompt === 'type') typePrompt = text;
    else if (a.prompt === 'arg') parts.push(q(text));
    else parts.push(a.prompt, q(text));
  }
  let command = parts.join(' ');
  if (shell === 'sh' && root && l.mode === 'skip' && a.rootEnv) command = `${a.rootEnv} ${command}`;
  return { command, typePrompt };
}

// Короткое имя агента для меток (null — консоль без агента или своя команда).
function launchAgentShort(launch) {
  const l = normalizeLaunch(launch);
  return l.mode === 'shell' || l.mode === 'custom' ? null : agentDef(l.agent).short;
}

// Агенты, найденные на этом компьютере (заполняется при запуске).
let localAgents = null;
async function detectLocalAgents() {
  const r = await native.request('whichAll', { names: AGENTS.map((a) => agentDef(a.id).cmd) });
  const found = new Set(r.found || []);
  localAgents = new Set(AGENTS.filter((a) => found.has(agentDef(a.id).cmd)).map((a) => a.id));
  return localAgents;
}

// Поля «какой агент и как запускать». target: 'local' — на этом компьютере, 'remote' — на сервере.
// available — Set id найденных агентов (null — неизвестно).
function launchControls(launch, { target = 'local', user = '', available = null, title = '' } = {}) {
  const l = normalizeLaunch(launch);
  const label = el('label', {});
  const agentSel = el('select', { title: 'ИИ-агент' });
  const modeSel = el('select', { title: 'Режим' }, LAUNCH_MODES.map((m) => el('option', { value: m.id, selected: m.id === l.mode }, m.label)));
  const custom = el('input', { type: 'text', class: 'mono', value: l.custom || '', spellcheck: 'false' });
  const cont = el('input', { type: 'checkbox', checked: !!l.cont });
  const contText = el('span', {});
  const contLabel = el('label', { class: 'check' }, cont, contText);
  const hint = el('div', { class: 'hint' });
  const preview = el('div', { class: 'preview-path' });

  function fillAgents(selected) {
    agentSel.replaceChildren(...AGENTS.map((a) => {
      const missing = available && !available.has(a.id);
      return el('option', { value: a.id, selected: a.id === selected }, `${a.name}${missing ? ' — не найден' : ''}`);
    }));
  }
  const read = () => ({ agent: agentSel.value, mode: modeSel.value, custom: custom.value.trim(), cont: cont.checked });
  function update() {
    const r = read();
    const a = agentDef(r.agent);
    const agentMode = r.mode === 'skip' || r.mode === 'normal';
    agentSel.hidden = !agentMode;
    custom.hidden = r.mode !== 'custom';
    custom.placeholder = target === 'remote' ? 'IS_SANDBOX=1 claude --dangerously-skip-permissions' : 'claude --dangerously-skip-permissions';
    contLabel.hidden = !agentMode || !a.cont;
    contText.textContent = `Продолжить прошлый разговор (${a.cont})`;
    label.textContent = title || (target === 'remote' ? 'Агент на сервере' : 'ИИ-агент');
    const missing = agentMode && available && !available.has(r.agent);
    hint.hidden = !missing;
    hint.textContent = missing ? `${a.name} не найден${target === 'remote' ? ' на сервере' : ' на этом компьютере'} — команда «${a.cmd}» может не запуститься.` : '';
    const { command } = buildLaunch(r, { shell: target === 'remote' ? 'sh' : 'ps', root: target === 'remote' && user === 'root' });
    preview.textContent = command ? `${target === 'remote' ? '$' : '>'} ${command}` : 'Откроется только консоль';
  }
  fillAgents(l.agent);
  agentSel.addEventListener('change', update);
  modeSel.addEventListener('change', () => { update(); if (modeSel.value === 'custom') custom.focus(); });
  custom.addEventListener('input', update);
  cont.addEventListener('change', update);
  update();
  const node = el('div', { class: 'field' }, label, el('div', { class: 'row' }, agentSel, modeSel), custom, contLabel, hint, preview);
  return {
    node, read,
    setTarget(t, u = user) { target = t; user = u; update(); },
    setAvailable(set) { available = set; fillAgents(agentSel.value); update(); },
  };
}

// ---------- агент на этом компьютере, работа с сервером через ssh ----------
function sshKeyRef(keyPath) {
  // ~/.ssh/<ключ> одинаково понимают ssh и оболочки агентов, а в тексте задания не нужны кавычки.
  const home = (env.home || '').replace(/[\\/]+$/, '').toLowerCase();
  const kp = keyPath || '';
  if (home && kp.toLowerCase().startsWith(`${home}\\.ssh\\`)) return `~/.ssh/${kp.slice(home.length + 6)}`;
  return kp.replace(/\\/g, '/');
}

function sshCommandFor(ssh) {
  const port = Number(ssh.port) || 22;
  return `ssh${ssh.keyPath ? ` -i ${sshKeyRef(ssh.keyPath)}` : ''}${port !== 22 ? ` -p ${port}` : ''} -o BatchMode=yes ${ssh.user}@${ssh.host}`;
}

function defaultRemotePrompt(ssh) {
  const cmd = sshCommandFor(ssh);
  const dir = ssh.dir || '~';
  return `Работаем с проектом на удалённом сервере ${ssh.user}@${ssh.host}, папка проекта: ${dir}. ` +
    `Подключение по SSH по ключу, без пароля: ${cmd}. ` +
    `Все команды по проекту выполняй на сервере через этот ssh, отдельным вызовом на каждую команду, например: ${cmd} 'cd ${dir} && ls -la'. ` +
    'Файлы читай и редактируй прямо на сервере. Сначала подключись и кратко опиши, что лежит в папке проекта.';
}

function defaultLocalDir(ssh, name) {
  const base = sanitizeFolderName(`ssh-${ssh.host}-${name || remoteBaseName(ssh.dir || '~')}`) || `ssh-${ssh.host}`;
  return `${defaultProjectsRoot().replace(/[\\/]+$/, '')}\\${base}`;
}

// Блок «Где запускать агента»: на сервере или на этом компьютере (+ локальная папка и текст задания).
function agentPlacementControls({ at = 'remote', localDir = '', prompt = '', launch, user = '', getSsh, getName }) {
  const remote = el('input', { type: 'radio', name: 'agent-at', value: 'remote', checked: at !== 'local' });
  const localRadio = el('input', { type: 'radio', name: 'agent-at', value: 'local', checked: at === 'local' });
  let remoteAgents = null;
  const launchCtl = launchControls(launch, { target: at === 'local' ? 'local' : 'remote', user, available: at === 'local' ? localAgents : null });
  let dirTouched = !!localDir;
  const dirInput = el('input', { type: 'text', class: 'mono', value: localDir, spellcheck: 'false' });
  dirInput.addEventListener('input', () => { dirTouched = dirInput.value.trim() !== ''; });
  const browse = el('button', { type: 'button', class: 'btn', onclick: async () => {
    const r = await native.request('pickFolder', { title: 'Локальная папка для агента', initial: dirInput.value || defaultProjectsRoot() });
    if (r.path) { dirInput.value = r.path; dirTouched = true; }
  } }, 'Обзор…');
  const promptInput = el('textarea', { rows: 5, spellcheck: 'false' }, prompt);
  const promptReset = el('button', { type: 'button', class: 'btn ghost small-btn', onclick: () => { promptInput.value = ''; refresh(); } }, 'По умолчанию');
  const localBlock = el('div', { class: 'local-block' },
    el('div', { class: 'field' }, el('label', {}, 'Локальная папка для агента'), el('div', { class: 'row' }, dirInput, browse),
      el('div', { class: 'hint' }, 'Здесь хранится история разговоров агента по проекту. Папка будет создана, если её нет.')),
    el('div', { class: 'field' }, el('div', { class: 'label-row' }, el('label', {}, 'Задание для агента при запуске'), promptReset), promptInput,
      el('div', { class: 'hint' }, 'Оставьте пустым — будет текст по умолчанию (показан серым). При продолжении прошлого разговора задание не отправляется.')));

  const isLocal = () => localRadio.checked;
  function refresh() {
    const ssh = getSsh();
    localBlock.hidden = !isLocal();
    launchCtl.setTarget(isLocal() ? 'local' : 'remote', ssh?.user || user);
    launchCtl.setAvailable(isLocal() ? localAgents : remoteAgents);
    if (ssh) {
      if (!dirTouched) dirInput.value = defaultLocalDir(ssh, getName());
      promptInput.placeholder = defaultRemotePrompt(ssh);
    }
  }
  remote.addEventListener('change', refresh);
  localRadio.addEventListener('change', refresh);

  const node = el('div', { class: 'placement' },
    el('div', { class: 'field' }, el('label', {}, 'Где запускать агента'),
      el('div', { class: 'segmented' },
        el('label', { class: 'seg' }, remote, el('span', {}, el('b', {}, 'На сервере'), el('small', {}, 'агент установлен на сервере'))),
        el('label', { class: 'seg' }, localRadio, el('span', {}, el('b', {}, 'На этом компьютере'), el('small', {}, 'агент сам подключится к серверу по ssh'))))),
    localBlock, launchCtl.node);
  refresh();
  return {
    node, refresh,
    // Какие агенты нашлись на сервере (проверяется после подключения).
    setRemoteAgents(set) { remoteAgents = set; refresh(); },
    read: () => ({ at: isLocal() ? 'local' : 'remote', localDir: dirInput.value.trim(), prompt: promptInput.value.trim(), launch: launchCtl.read() }),
  };
}

async function detectRemoteAgents(ctx) {
  const r = await native.request('sshDetectAgents', { ...ctx, names: AGENTS.map((a) => agentDef(a.id).cmd) });
  if (r.error) return null;
  const found = new Set(r.found || []);
  return new Set(AGENTS.filter((a) => found.has(agentDef(a.id).cmd)).map((a) => a.id));
}

class Session {
  constructor({ projectId, name, path, cwd = null, command, ssh = null, agent = null, typePrompt = '' }) {
    this.id = nextSessionId++;
    this.cwd = cwd || path;  // для «агент локально» path — адрес на сервере, а запускаемся в локальной папке
    this.agent = agent;            // короткое имя агента для меток (null — консоль без агента)
    this.typePrompt = typePrompt;  // задание, которое агент не принимает при запуске — впишем его сами
    this.pendingPrompt = '';
    this.promptTimer = null;
    this.startedAt = 0;
    this.projectId = projectId;
    this.name = name;
    this.path = path;
    this.command = command;
    this.ssh = ssh;            // { host, port, user, dir, keyPath } для проектов на сервере
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
    this.startedAt = performance.now();
    this.pendingPrompt = this.typePrompt;
    this.fitNow();
    const base = { type: 'spawn', id: this.id, cols: this.cols || 120, rows: this.rows || 30 };
    if (!this.ssh) {
      native.send({ ...base, cwd: this.cwd, shell: state.settings.shell, command: this.command });
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
    const now = performance.now();
    this.lastOutput = now;
    // Агент без параметра «задание при запуске»: ждём, пока его интерфейс загрузится и затихнет, и вписываем текст.
    if (this.pendingPrompt) {
      clearTimeout(this.promptTimer);
      const wait = Math.max(1500, 4000 - (now - this.startedAt));
      this.promptTimer = setTimeout(() => this.flushPrompt(), wait);
    }
    // Эхо набранного текста не считаем «работой».
    if (!this.busy && now - this.lastInput > 200) {
      this.busy = true;
      this.busySince = now;
      renderIndicators();
    }
  }

  flushPrompt() {
    const text = this.pendingPrompt;
    this.pendingPrompt = '';
    if (!text || this.status === 'exited') return;
    // Вставка (bracketed paste), затем Enter отдельно — так текст не отправится по частям.
    native.send({ type: 'input', id: this.id, data: `\x1b[200~${text}\x1b[201~` });
    setTimeout(() => native.send({ type: 'input', id: this.id, data: '\r' }), 400);
  }

  onExit(code) {
    this.status = 'exited';
    this.busy = false;
    this.pendingPrompt = '';
    clearTimeout(this.promptTimer);
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
      text: 'Консоль и всё, что в ней запущено (включая ИИ-агента), будет завершено.',
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
  if (s.attention) return 'Есть новости — агент закончил или ждёт ответа';
  if (s.busy) return 'Идёт вывод (агент работает)';
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
    el('div', { class: 'pane-title', title: s.path }, el('b', {}, sessionLabel(s)), s.agent ? el('i', { class: 'tag agent' }, s.agent) : null, el('span', {}, s.title || s.path)),
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
      p.ssh ? el('span', { class: 'tag', title: p.claudeAt === 'local' ? 'Проект на сервере, агент работает на этом компьютере' : 'Проект на сервере, агент на сервере' },
        p.claudeAt === 'local' ? 'SSH · локально' : 'SSH') : null,
      launchAgentShort(p.launch || state.settings.defaultLaunch) ? el('span', { class: 'tag agent', title: 'ИИ-агент проекта' }, launchAgentShort(p.launch || state.settings.defaultLaunch))
        : normalizeLaunch(p.launch || state.settings.defaultLaunch).mode === 'shell' ? el('span', { class: 'tag console', title: 'Только консоль, без ИИ-агента' }, 'Консоль') : null,
      attention ? el('span', { class: 'dot attention', title: 'Агент ждёт' }) : null),
    el('div', {},
      open.length ? el('span', { class: 'open-count', title: 'Открытых консолей' }, open.length) : null,
      el('div', { class: 'project-actions' },
        el('button', { class: 'icon-btn small', title: 'Ещё одна консоль', onclick: (e) => { e.stopPropagation(); openProject(p, { forceNew: true }); } }, icon(ICONS.plus)),
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

async function openProject(p, { forceNew = false, plain = false, agent = null } = {}) {
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
  // Параметры подключения менялись (или ключ ещё не готовился) — сначала подключаемся и готовим ключ.
  if (p.ssh && !p.ssh.keyPath) {
    toast(`Подключаюсь к ${p.ssh.host}…`);
    const r = await native.request('sshConnect', sshTarget(p.ssh));
    if (r.needsPassword) { sshConnectDialog({ project: p }); return; }
    if (r.error) { toast(r.error, 'error'); return; }
    p.ssh.keyPath = r.keyPath;
  }
  p.lastOpened = Date.now();
  p.openCount = (p.openCount || 0) + 1;
  // Как запускать: настройки проекта (или по умолчанию); agent — «открыть с другим агентом» из меню.
  let launch = normalizeLaunch(p.launch || state.settings.defaultLaunch);
  if (agent) launch = { ...launch, agent, mode: launch.mode === 'normal' ? 'normal' : 'skip', cont: false };
  let built = { command: '', typePrompt: '' };
  let cwd = null;
  let ssh = p.ssh ? { ...p.ssh } : null;
  if (p.ssh && p.claudeAt === 'local' && !plain) {
    // Агент на этом компьютере: локальная папка + задание подключиться к серверу.
    const dir = p.localDir || defaultLocalDir(p.ssh, p.name);
    const r = await native.request('ensureDir', { path: dir });
    if (r.error) { toast(r.error, 'error'); return; }
    p.localDir = r.path || dir;
    cwd = p.localDir;
    built = buildLaunch(launch, { shell: 'ps', prompt: p.prompt || defaultRemotePrompt(p.ssh) });
    ssh = null;
  } else if (!plain) {
    built = p.ssh ? buildLaunch(launch, { shell: 'sh', root: p.ssh.user === 'root' }) : buildLaunch(launch, { shell: 'ps' });
  }
  addSession({ projectId: p.id, name: p.name, path: p.path, cwd, command: built.command, typePrompt: built.typePrompt, ssh,
    agent: plain ? null : launchAgentShort(launch) });
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
    { icon: ICONS.plus, label: 'Ещё одна консоль', action: () => openProject(p, { forceNew: true }) },
    { icon: ICONS.play, label: 'Открыть с другим агентом…', action: () => pickAgentDialog(p) },
    { icon: ICONS.terminal, label: p.ssh ? 'Консоль на сервере (без агента)' : 'Консоль без агента', action: () => openProject(p, { plain: true }) },
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

// «Открыть с другим агентом»: например, рядом с Claude запустить Codex в том же проекте.
function pickAgentDialog(p) {
  openModal((modal, close) => {
    const where = p.ssh && p.claudeAt !== 'local' ? 'remote' : 'local';
    const list = el('div', { class: 'agent-grid' });
    const status = el('div', { class: 'hint' });
    const render = (available) => list.replaceChildren(...AGENTS.map((a) => {
      const missing = available && !available.has(a.id);
      return el('button', { type: 'button', class: `agent-card${missing ? ' missing' : ''}`, onclick: () => { close(); openProject(p, { forceNew: true, agent: a.id }); } },
        el('b', {}, a.name), el('span', {}, missing ? 'не найден' : agentDef(a.id).cmd));
    }));
    if (where === 'local') render(localAgents);
    else {
      render(null);
      if (p.ssh.keyPath) {
        status.textContent = 'Проверяю, какие агенты установлены на сервере…';
        detectRemoteAgents({ ...sshTarget(p.ssh), keyPath: p.ssh.keyPath }).then((set) => { status.textContent = ''; if (set) render(set); });
      }
    }
    modal.append(el('h2', {}, `Открыть «${p.name}» с агентом`),
      el('div', { class: 'modal-sub' }, where === 'remote' ? 'Агент запустится на сервере' : 'Агент запустится на этом компьютере'),
      el('form', { onsubmit: (e) => e.preventDefault() }, list, status,
        el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'))));
  });
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
    const agentCtl = launchControls(defaultLaunch(), { target: 'local', available: localAgents });
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
      p.launch = agentCtl.read();
      close();
      if (r.existed) toast('Папка уже существовала — добавлена как проект');
      if (launch.checked) openProject(p, { forceNew: true }); else renderProjects();
      saveState();
    } },
      el('div', { class: 'field' }, el('label', {}, 'Название проекта'), name),
      el('div', { class: 'field' }, el('label', {}, 'Имя папки'), folder),
      el('div', { class: 'field' }, el('label', {}, 'Где создать'), el('div', { class: 'row' }, parent, browse), preview),
      agentCtl.node,
      el('label', { class: 'check' }, launch, 'Сразу открыть консоль и запустить агента'),
      error,
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'), submit));

    modal.append(el('h2', {}, 'Новый проект'), el('div', { class: 'modal-sub' }, 'Будет создана папка, в ней откроется PowerShell и запустится выбранный ИИ-агент.'), form);
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
        () => sshConnectDialog(), !env.hasSsh)));
  });
}

const sshTarget = (ssh) => ({ host: ssh.host, port: Number(ssh.port) || 22, user: ssh.user });
const remoteBaseName = (path) => (path === '/' ? '/' : path.replace(/\/+$/, '').split('/').pop());

// Шаг 1: подключение к серверу (ключ создаётся и при необходимости ставится по паролю).
// С project — переподключение существующего проекта (например, после смены сервера); затем сразу открываем консоль.
// consoleOnly — подключение без ИИ-агента (просто оболочка сервера, например чтобы смотреть логи).
function sshConnectDialog({ project = null, consoleOnly = false } = {}) {
  openModal((modal, close) => {
    const ssh = project?.ssh;
    const host = el('input', { type: 'text', class: 'mono', value: ssh?.host || '', placeholder: '192.168.1.10 или example.com', autofocus: !ssh, spellcheck: 'false' });
    const port = el('input', { type: 'number', min: 1, max: 65535, value: ssh?.port || 22, class: 'port' });
    const user = el('input', { type: 'text', class: 'mono', value: ssh?.user || '', placeholder: 'root', spellcheck: 'false' });
    const password = el('input', { type: 'password', autocomplete: 'new-password', autofocus: !!ssh });
    const status = el('div', { class: 'hint' });
    const error = el('div', { class: 'modal-error' });
    const submit = el('button', { type: 'submit', class: 'btn primary' }, 'Подключиться');

    // Можно вставить «user@host» или «user@host:port» целиком в поле сервера.
    host.addEventListener('change', () => {
      const m = host.value.trim().match(/^([^@\s]+)@([^:\s]+)(?::(\d+))?$/);
      if (m) { user.value = m[1]; host.value = m[2]; if (m[3]) port.value = m[3]; }
    });

    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      const target = { host: host.value.trim(), port: Number(port.value) || 22, user: user.value.trim() || 'root' };
      if (!target.host) { error.textContent = 'Укажите адрес сервера'; host.focus(); return; }
      submit.disabled = true;
      status.textContent = password.value ? 'Подключаюсь и устанавливаю ключ…' : 'Подключаюсь…';
      const r = await native.request('sshConnect', { ...target, password: password.value });
      submit.disabled = false;
      status.textContent = '';
      if (r.needsPassword) {
        error.textContent = 'Сервер пока не знает ключ этого компьютера. Введите пароль один раз — ключ установится, дальше вход без пароля.';
        password.focus();
        return;
      }
      if (r.error) { error.textContent = r.error; return; }
      password.value = '';
      if (r.keyCreated) toast(`Создан ключ ${r.keyPath}`);
      if (r.keyInstalled) toast('Ключ установлен на сервер — дальше вход без пароля');
      const ctx = { ...target, keyPath: r.keyPath };
      if (project) {
        project.ssh = { ...project.ssh, ...ctx };
        close();
        saveState();
        openProject(project, { forceNew: true });
        return;
      }
      if (consoleOnly) sshConsoleStep(modal, close, ctx);
      else sshFolderStep(modal, close, ctx);
    } },
      el('div', { class: 'field' }, el('label', {}, 'Сервер и порт'), el('div', { class: 'row' }, host, port)),
      el('div', { class: 'field' }, el('label', {}, 'Пользователь'), user),
      el('div', { class: 'field' }, el('label', {}, 'Пароль'), password,
        el('div', { class: 'hint' }, 'Нужен только при первом подключении — чтобы установить ключ ~/.ssh/id_ed25519_<сервер>. Нигде не сохраняется. Если вход по ключу уже настроен, оставьте пустым.')),
      status, error,
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'), submit));
    modal.append(el('h2', {}, project ? `Подключение: ${project.name}` : consoleOnly ? 'SSH-подключение' : 'Проект на сервере (SSH)'),
      el('div', { class: 'modal-sub' }, project ? 'Сервер не принимает ключ — нужен пароль, чтобы установить его.' : 'Шаг 1 из 2 — подключение к серверу'), form);
  });
}

// Обзор папок на сервере. onChange(path) вызывается при каждом переходе.
function remoteBrowser(ctx, startPath, onChange) {
  let current = '';
  let busy = false;
  const pathInput = el('input', { type: 'text', class: 'mono', spellcheck: 'false' });
  const list = el('div', { class: 'rb-list', role: 'listbox' });
  const showHidden = el('input', { type: 'checkbox' });
  const error = el('div', { class: 'modal-error' });
  let dirs = [];

  const render = () => {
    const visible = dirs.filter((d) => showHidden.checked || !d.startsWith('.')).sort((a, b) => a.localeCompare(b, 'ru'));
    const item = (label, target, cls = '') => el('button', { type: 'button', class: `rb-item ${cls}`, onclick: () => go(target) }, icon(ICONS.folder), label);
    const items = [];
    if (current !== '/') items.push(item('..', current.replace(/\/[^/]+\/?$/, '') || '/', 'up'));
    for (const d of visible) items.push(item(d, `${current === '/' ? '' : current}/${d}`));
    if (!visible.length) items.push(el('div', { class: 'rb-empty' }, dirs.length ? 'Только скрытые папки' : 'Подпапок нет'));
    list.replaceChildren(...items);
  };

  // Переход в папку; true — успешно. Параллельные переходы выполняются по очереди.
  let pending = null;
  async function go(path) {
    while (pending) await pending;
    pending = navigate(path);
    try { return await pending; } finally { pending = null; }
  }
  async function navigate(path) {
    busy = true;
    list.classList.add('loading');
    error.textContent = '';
    const r = await native.request('sshListDir', { ...ctx, path });
    busy = false;
    list.classList.remove('loading');
    if (r.error) { error.textContent = r.error; pathInput.value = current; return false; }
    current = r.path;
    dirs = r.dirs || [];
    pathInput.value = current;
    render();
    list.scrollTop = 0;
    onChange?.(current);
    return true;
  }

  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(pathInput.value.trim() || '~'); } });
  showHidden.addEventListener('change', render);

  const newName = el('input', { type: 'text', class: 'mono', placeholder: 'имя новой папки', spellcheck: 'false' });
  const createRow = el('div', { class: 'row', hidden: true }, newName,
    el('button', { type: 'button', class: 'btn', onclick: () => createDir() }, 'Создать'));
  async function createDir() {
    const name = newName.value.trim();
    if (!name) { newName.focus(); return; }
    const r = await native.request('sshMkdir', { ...ctx, parent: current, name });
    if (r.error) { error.textContent = r.error; return; }
    newName.value = '';
    createRow.hidden = true;
    go(r.path);
  }
  newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createDir(); } });

  const node = el('div', { class: 'field rb' },
    el('label', {}, 'Папка на сервере'),
    el('div', { class: 'row' }, pathInput, el('button', { type: 'button', class: 'btn', title: 'Перейти', onclick: () => go(pathInput.value.trim() || '~') }, 'Перейти')),
    list,
    el('div', { class: 'rb-tools' },
      el('label', { class: 'check' }, showHidden, 'Скрытые папки'),
      el('button', { type: 'button', class: 'btn ghost', onclick: () => { createRow.hidden = !createRow.hidden; if (!createRow.hidden) newName.focus(); } }, icon(ICONS.plus), 'Новая папка')),
    createRow, error);
  go(startPath || '~');
  return {
    node,
    getPath: () => current,
    // Итоговая папка: если путь введён вручную и не подтверждён Enter — сначала переходим по нему.
    async resolve() {
      const typed = pathInput.value.trim();
      if (typed && typed !== current && !(await go(typed))) return null;
      return current || null;
    },
  };
}

// Шаг 2: выбор папки на сервере, название и вариант запуска.
function sshFolderStep(modal, close, ctx) {
  let nameTouched = false;
  const name = el('input', { type: 'text', placeholder: 'Название проекта', spellcheck: 'false' });
  name.addEventListener('input', () => { nameTouched = true; });
  let placement = null;
  const browser = remoteBrowser(ctx, '~', (path) => {
    if (!nameTouched) name.value = path === '/' ? ctx.host : remoteBaseName(path);
    placement?.refresh();
  });
  name.addEventListener('input', () => placement?.refresh());
  placement = agentPlacementControls({
    launch: defaultLaunch(), user: ctx.user,
    getSsh: () => (browser.getPath() ? { ...ctx, dir: browser.getPath() } : null),
    getName: () => name.value.trim(),
  });
  // Какие агенты стоят на сервере — подсказка в списке агентов.
  detectRemoteAgents(ctx).then((set) => { if (set) placement.setRemoteAgents(set); });
  const error = el('div', { class: 'modal-error' });

  const form = el('form', { onsubmit: async (e) => {
    e.preventDefault();
    const dir = await browser.resolve();
    if (!dir) return;
    const ssh = { ...ctx, dir };
    const label = sshLabel(ssh);
    let p = findProjectByPath(label);
    if (!p) p = addProject(name.value.trim() || remoteBaseName(dir), label);
    else if (name.value.trim()) p.name = name.value.trim();
    p.ssh = ssh;
    const pl = placement.read();
    p.claudeAt = pl.at;
    p.localDir = pl.localDir;
    p.prompt = pl.prompt;
    p.launch = pl.launch;
    close();
    openProject(p, { forceNew: true });
    saveState();
  } },
    browser.node,
    el('div', { class: 'field' }, el('label', {}, 'Название проекта'), name),
    placement.node,
    error,
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'),
      el('button', { type: 'submit', class: 'btn primary' }, 'Открыть здесь')));
  modal.replaceChildren(el('h2', {}, `${ctx.user}@${ctx.host}`), el('div', { class: 'modal-sub' }, 'Шаг 2 из 2 — выберите папку проекта'), form);
}

// Шаг 2 для SSH-консоли: папка, где окажемся после входа, и сохранять ли подключение в списке.
function sshConsoleStep(modal, close, ctx) {
  const name = el('input', { type: 'text', value: `${ctx.user}@${ctx.host}`, spellcheck: 'false' });
  let nameTouched = false;
  name.addEventListener('input', () => { nameTouched = true; });
  const browser = remoteBrowser(ctx, '~', (path) => {
    if (!nameTouched) name.value = `${ctx.host}:${path === '/' ? '/' : remoteBaseName(path)}`;
  });
  const save = el('input', { type: 'checkbox', checked: true });
  const form = el('form', { onsubmit: async (e) => {
    e.preventDefault();
    const dir = await browser.resolve();
    if (!dir) return;
    const ssh = { ...ctx, dir };
    close();
    if (!save.checked) {
      openTerminal({ name: name.value.trim() || `${ctx.user}@${ctx.host}`, path: sshLabel(ssh), ssh });
      return;
    }
    const label = sshLabel(ssh);
    let p = findProjectByPath(label);
    if (!p) p = addProject(name.value.trim() || `${ctx.user}@${ctx.host}`, label);
    else if (name.value.trim()) p.name = name.value.trim();
    p.ssh = ssh;
    p.claudeAt = 'remote';
    p.launch = { agent: 'claude', mode: 'shell', custom: '', cont: false };
    openProject(p, { forceNew: true });
    saveState();
  } },
    browser.node,
    el('div', { class: 'field' }, el('label', {}, 'Название'), name),
    el('label', { class: 'check' }, save, 'Сохранить в списке, чтобы потом подключаться одним кликом'),
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'),
      el('button', { type: 'submit', class: 'btn primary' }, 'Подключиться')));
  modal.replaceChildren(el('h2', {}, `${ctx.user}@${ctx.host}`),
    el('div', { class: 'modal-sub' }, 'Шаг 2 из 2 — в какой папке открыть консоль (например, /var/log)'), form);
}

// ---------- консоли без проекта и без агента ----------
// Сессия, не привязанная к проекту: локальный PowerShell или ssh на сервер.
function openTerminal({ name, path, ssh = null }) {
  addSession({ projectId: null, name, path, ssh: ssh ? { ...ssh } : null, command: '', agent: null });
}

function openLocalConsole() {
  openTerminal({ name: 'PowerShell', path: env.home || 'C:\\' });
}

function newConsoleMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu([
    { icon: ICONS.terminal, label: 'PowerShell (Ctrl+Shift+T)', action: openLocalConsole },
    { icon: ICONS.server, label: 'SSH-подключение…', action: () => sshConnectDialog({ consoleOnly: true }) },
  ], r.left, r.bottom + 4);
}

async function openLocalFolderFlow() {
  const r = await native.request('pickFolder', { title: 'Выберите папку проекта', initial: defaultProjectsRoot() });
  if (!r.path) return;
  const existing = findProjectByPath(r.path);
  if (existing) { openProject(existing); return; }
  openModal((modal, close) => {
    const name = el('input', { type: 'text', value: baseName(r.path), autofocus: true, spellcheck: 'false' });
    const agentCtl = launchControls(defaultLaunch(), { target: 'local', available: localAgents });
    const form = el('form', { onsubmit: (e) => {
      e.preventDefault();
      const p = addProject(name.value.trim() || baseName(r.path), r.path);
      p.launch = agentCtl.read();
      close();
      openProject(p);
    } },
      el('div', { class: 'field' }, el('label', {}, 'Название проекта'), name, el('div', { class: 'preview-path' }, r.path)),
      agentCtl.node,
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
    const agentCtl = launchControls(p.launch || defaultLaunch(), { target: 'local', available: localAgents });
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
      p.launch = agentCtl.read();
      delete p.command;
      for (const s of projectSessions(p)) s.name = p.name;
      close();
      renderAll();
      refreshMissing();
      saveState();
    } },
      el('div', { class: 'field' }, el('label', {}, 'Название'), name),
      el('div', { class: 'field' }, el('label', {}, 'Папка'), el('div', { class: 'row' }, path, browse)),
      agentCtl.node,
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
    const currentSsh = () => ({ host: host.value.trim(), port: Number(port.value) || 22, user: user.value.trim(), dir: dir.value.trim() || '~', keyPath: p.ssh.keyPath });
    const placement = agentPlacementControls({
      at: p.claudeAt, localDir: p.localDir || '', prompt: p.prompt || '', user: p.ssh.user,
      launch: p.launch || defaultLaunch(), getSsh: currentSsh, getName: () => name.value.trim(),
    });
    if (p.ssh.keyPath) detectRemoteAgents({ ...sshTarget(p.ssh), keyPath: p.ssh.keyPath }).then((set) => { if (set) placement.setRemoteAgents(set); });
    for (const input of [host, port, user, dir, name]) input.addEventListener('input', () => placement.refresh());
    const error = el('div', { class: 'modal-error' });
    const sameServer = () => host.value.trim() === p.ssh.host && user.value.trim() === p.ssh.user && (Number(port.value) || 22) === (Number(p.ssh.port) || 22);

    const browse = el('button', { type: 'button', class: 'btn', onclick: () => {
      if (!sameServer() || !p.ssh.keyPath) { error.textContent = 'Сначала сохраните новые параметры сервера и подключитесь — затем можно выбирать папку.'; return; }
      openModal((m2, close2) => {
        const browser = remoteBrowser({ ...sshTarget(p.ssh), keyPath: p.ssh.keyPath }, dir.value.trim() || '~');
        m2.append(el('h2', {}, 'Папка на сервере'), el('form', { onsubmit: async (e) => { e.preventDefault(); const chosen = await browser.resolve(); if (!chosen) return; dir.value = chosen; dir.dispatchEvent(new Event('input')); close2(); } },
          browser.node,
          el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close2 }, 'Отмена'), el('button', { type: 'submit', class: 'btn primary' }, 'Выбрать'))));
        m2.querySelector('form').addEventListener('submit', () => placement.refresh());
      });
    } }, 'Обзор…');

    const form = el('form', { onsubmit: (e) => {
      e.preventDefault();
      const ssh = currentSsh();
      if (!ssh.host || !ssh.user) { error.textContent = 'Укажите сервер и пользователя'; return; }
      const label = sshLabel(ssh);
      const clash = findProjectByPath(label);
      if (clash && clash !== p) { error.textContent = `Такой проект уже есть: «${clash.name}»`; return; }
      // Сменился сервер, пользователь или порт — ключ подготовим заново при следующем открытии.
      if (!sameServer()) ssh.keyPath = '';
      p.ssh = ssh;
      p.path = label;
      p.name = name.value.trim() || remoteBaseName(ssh.dir);
      const pl = placement.read();
      p.claudeAt = pl.at;
      p.localDir = pl.localDir;
      p.prompt = pl.prompt;
      p.launch = pl.launch;
      for (const s of projectSessions(p)) s.name = p.name;
      close();
      renderAll();
      saveState();
    } },
      el('div', { class: 'field' }, el('label', {}, 'Название'), name),
      el('div', { class: 'field' }, el('label', {}, 'Сервер и порт'), el('div', { class: 'row' }, host, port)),
      el('div', { class: 'field' }, el('label', {}, 'Пользователь'), user),
      el('div', { class: 'field' }, el('label', {}, 'Папка на сервере'), el('div', { class: 'row' }, dir, browse)),
      placement.node,
      el('div', { class: 'hint' }, `Ключ: ${p.ssh.keyPath || 'будет подготовлен при подключении'}`),
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
    const agentCtl = launchControls(defaultLaunch(), { target: 'local', available: localAgents, title: 'ИИ-агент для новых проектов' });
    // Свои команды и флаги агентов (на случай, если у агента другая версия или он назван иначе).
    const overrideInputs = {};
    const overrides = el('details', { class: 'agent-overrides' }, el('summary', {}, 'Команды агентов'),
      el('div', { class: 'hint' }, 'Пусто — значение по умолчанию (показано серым).'),
      el('div', { class: 'ov-grid' },
        el('b', {}, 'Агент'), el('b', {}, 'Команда'), el('b', {}, 'Без подтверждений'), el('b', {}, 'Продолжить'),
        AGENTS.flatMap((a) => {
          const o = (st.agentOverrides || {})[a.id] || {};
          const mk = (key) => el('input', { type: 'text', class: 'mono', value: o[key] || '', placeholder: a[key], spellcheck: 'false' });
          overrideInputs[a.id] = { cmd: mk('cmd'), yolo: mk('yolo'), cont: mk('cont') };
          return [el('span', {}, a.name), overrideInputs[a.id].cmd, overrideInputs[a.id].yolo, overrideInputs[a.id].cont];
        })));
    const fontSize = el('input', { type: 'number', min: 8, max: 32, value: st.fontSize });
    const root = el('input', { type: 'text', class: 'mono', value: defaultProjectsRoot(), spellcheck: 'false' });
    const restore = el('input', { type: 'checkbox', checked: st.restoreSessions });
    const checkUpdates = el('input', { type: 'checkbox', checked: st.checkUpdates !== false });
    const checkNow = el('button', { type: 'button', class: 'btn small-btn', onclick: () => checkForUpdates(true) }, 'Проверить сейчас');
    const browse = el('button', { type: 'button', class: 'btn', onclick: async () => {
      const r = await native.request('pickFolder', { title: 'Папка для новых проектов', initial: root.value });
      if (r.path) root.value = r.path;
    } }, 'Обзор…');

    const form = el('form', { onsubmit: (e) => {
      e.preventDefault();
      st.shell = shell.value;
      st.agentOverrides = {};
      for (const [id, inputs] of Object.entries(overrideInputs)) {
        const o = {};
        for (const key of ['cmd', 'yolo', 'cont']) if (inputs[key].value.trim()) o[key] = inputs[key].value.trim();
        if (Object.keys(o).length) st.agentOverrides[id] = o;
      }
      st.defaultLaunch = agentCtl.read();
      detectLocalAgents().then(renderProjects);
      st.projectsRoot = root.value.trim();
      st.restoreSessions = restore.checked;
      st.checkUpdates = checkUpdates.checked;
      const fs = Math.min(32, Math.max(8, Number(fontSize.value) || 14));
      if (fs !== st.fontSize) applyFontSize(fs);
      close();
      saveState();
    } },
      el('div', { class: 'field' }, el('label', {}, 'Оболочка'), shell),
      agentCtl.node,
      overrides,
      el('div', { class: 'field' }, el('label', {}, 'Папка для новых проектов'), el('div', { class: 'row' }, root, browse)),
      el('div', { class: 'field' }, el('label', {}, 'Размер шрифта консоли'), fontSize),
      el('label', { class: 'check' }, restore, 'При запуске снова открывать проекты из прошлого сеанса'),
      el('div', { class: 'label-row' }, el('label', { class: 'check' }, checkUpdates, 'Проверять обновления при запуске'), checkNow),
      el('div', { class: 'about' }, `CMD Manager ${env.version}`, el('br'), 'Разработка ООО «Аутсорсинг трейд» · ',
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); native.send({ type: 'openUrl', url: 'https://itradmin.ru' }); } }, 'itradmin.ru')),
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
      case 'KeyT': return run(openLocalConsole);
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
// Обновления
// ============================================================================
let updateInfo = null;

function checkForUpdates(manual = false) {
  if (manual) toast('Проверяю обновления…');
  native.send({ type: 'checkUpdate', manual });
}

native.on('update', (m) => {
  if (m.error) { if (m.manual) toast(`Не удалось проверить обновления: ${m.error}`, 'error'); return; }
  if (!m.available) { if (m.manual) toast(`Установлена последняя версия (${m.current})`); return; }
  updateInfo = m;
  $('#update-version').textContent = m.version;
  $('#update-banner').hidden = false;
  if (m.manual) toast(`Доступна версия ${m.version}`);
});

native.on('updateProgress', (m) => {
  $('#btn-update').textContent = m.percent >= 0 ? `Загрузка ${m.percent}%` : 'Загрузка…';
});

native.on('updateError', (m) => {
  const btn = $('#btn-update');
  btn.disabled = false;
  btn.textContent = 'Обновить';
  toast(`Обновление не удалось: ${m.message}`, 'error');
});

$('#btn-update').addEventListener('click', async () => {
  const live = [...sessions.values()].filter((s) => s.status !== 'exited').length;
  const ok = await confirmDialog({
    title: `Обновить до версии ${updateInfo?.version}?`,
    text: live
      ? `Программа скачает обновление, закроется и откроется снова. Открытые консоли (${live}) и запущенные в них агенты будут закрыты.`
      : 'Программа скачает обновление, закроется и откроется снова.',
    okText: 'Обновить',
  });
  if (!ok) return;
  const btn = $('#btn-update');
  btn.disabled = true;
  btn.textContent = 'Загрузка…';
  saveState();
  native.send({ type: 'installUpdate' });
});
$('#update-notes').addEventListener('click', (e) => {
  e.preventDefault();
  if (updateInfo?.pageUrl) native.send({ type: 'openUrl', url: updateInfo.pageUrl });
});
document.querySelector('.credits a').addEventListener('click', (e) => {
  e.preventDefault();
  native.send({ type: 'openUrl', url: e.target.dataset.url });
});

// ============================================================================
// Запуск
// ============================================================================
$('#btn-create').addEventListener('click', createProjectDialog);
$('#btn-open').addEventListener('click', openProjectFlow);
$('#btn-settings').addEventListener('click', settingsDialog);
$('#btn-new-console').addEventListener('click', (e) => newConsoleMenu(e.currentTarget));
$('#btn-sidebar').addEventListener('click', toggleSidebar);
$('#search').addEventListener('input', (e) => { search = e.target.value; renderProjects(); });
$('#welcome').addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (a === 'create') createProjectDialog();
  if (a === 'open') openProjectFlow();
  if (a === 'console') newConsoleMenu(e.target.closest('[data-action]'));
});
setInterval(renderProjects, 60_000);  // обновить «N мин назад»

native.on('init', async (m) => {
  Object.assign(env, { home: m.home || '', hasPwsh: !!m.hasPwsh, osBuild: m.osBuild || 0, hasSsh: !!m.hasSsh, version: m.version || '' });
  const saved = m.state;
  if (saved && typeof saved === 'object') {
    if (Array.isArray(saved.projects)) state.projects = saved.projects.filter((p) => p && p.path);
    for (const p of state.projects) {
      // Старые проекты: команда строкой → «своя команда», варианты «только Claude» → агент Claude.
      if (!p.launch && p.command) p.launch = { agent: 'claude', mode: 'custom', custom: p.command, cont: false };
      if (!p.launch && p.ssh) p.launch = { agent: 'claude', mode: 'skip', custom: '', cont: false };
      if (p.launch) p.launch = normalizeLaunch(p.launch);
      delete p.command;
    }
    Object.assign(state.settings, saved.settings || {});
    if (Array.isArray(saved.openProjects)) state.openProjects = saved.openProjects;
  }
  if (!LAYOUTS.includes(state.settings.layout)) state.settings.layout = 1;
  $('#app').classList.toggle('no-sidebar', !state.settings.sidebar);
  // Старые настройки: одна команда для всех проектов → агент по умолчанию.
  if (saved?.settings && !saved.settings.defaultLaunch) {
    const c = (saved.settings.command ?? DEFAULT_COMMAND).trim();
    state.settings.defaultLaunch = c === DEFAULT_COMMAND ? { agent: 'claude', mode: 'skip', custom: '', cont: false }
      : c === '' ? { agent: 'claude', mode: 'shell', custom: '', cont: false }
      : { agent: 'claude', mode: 'custom', custom: c, cont: false };
  }
  delete state.settings.command;
  await detectLocalAgents();
  const def = defaultLaunch();
  if ((def.mode === 'skip' || def.mode === 'normal') && !localAgents.has(def.agent))
    toast(`${agentDef(def.agent).name} не найден в PATH — выберите установленного агента в настройках.`, 'error');

  renderAll();
  if (state.settings.checkUpdates !== false) setTimeout(() => checkForUpdates(false), 3000);
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
