'use strict';

// ============================================================================
// Команда агентов: оркестратор раздаёт задачи, разработчик делает, проверяющий проверяет.
//
// Связь — через MCP: каждая консоль команды получает MCP-сервер «cmdmanager» (это наш же exe с --mcp),
// и агент вызывает инструменты своей роли (add_tasks, assign_task, report…). Программа ведёт доску задач,
// доставляет сообщения в окно получателя (вписывает текст, когда агент свободен) и показывает обмен:
// кабели между окнами и «пакеты данных», летящие от отправителя к получателю.
// ============================================================================
const TEAM_ROLES = {
  orchestrator: { title: 'Оркестратор', icon: '♛', color: '#e0b04a' },
  developer: { title: 'Разработчик', icon: '⚒', color: '#5b9cf0' },
  checker: { title: 'Проверяющий', icon: '✔', color: '#5fbf7f' },
};
const TEAM_AGENTS = ['claude', 'codex', 'opencode', 'mimo'];  // агенты, которым умеем подключить MCP
const TASK_STATUS = {
  todo: { title: 'В очереди', color: '#9a9cab' },
  in_progress: { title: 'В работе', color: '#5b9cf0' },
  implemented: { title: 'Сделано, ждёт проверки', color: '#c47fd5' },
  review: { title: 'На проверке', color: '#4fbfc4' },
  verified: { title: 'Проверено', color: '#7ddc98' },
  rejected: { title: 'Возвращено', color: '#e5625c' },
  blocked: { title: 'Заблокировано', color: '#e0b04a' },
  failed: { title: 'Не удалось', color: '#e5625c' },
  done: { title: 'Готово', color: '#5fbf7f' },
};

let team = null;  // { name, projectId, members, tasks, log, nextTaskId, paused, checkpointEvery, doneSinceCheckpoint, tasksFile, running }

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const teamMember = (key) => team?.members.find((m) => m.key === key);
const memberBySession = (id) => team?.members.find((m) => m.sessionId === id);
const memberByToken = (token) => team?.members.find((m) => m.token === token);
const roleTitle = (role) => t(TEAM_ROLES[role]?.title || role);
function memberLabel(m) {
  const same = team.members.filter((x) => x.role === m.role);
  return `${roleTitle(m.role)}${same.length > 1 ? ` ${same.indexOf(m) + 1}` : ''}`;
}
function sessionTeamRole(s) { return memberBySession(s.id)?.role || null; }

function saveTeam() {
  state.team = team && {
    name: team.name, projectId: team.projectId, tasks: team.tasks, log: team.log.slice(-200), nextTaskId: team.nextTaskId,
    checkpointEvery: team.checkpointEvery, doneSinceCheckpoint: team.doneSinceCheckpoint, tasksFile: team.tasksFile,
    members: team.members.map(({ key, role, agent, mode, server, model, account }) => ({ key, role, agent, mode, server, model, account })),
  };
  saveState();
}

// ---------- запуск консоли участника ----------
// Где работают агенты: на этом компьютере; на сервере (ssh + обратный туннель к MCP-узлу);
// на этом компьютере с проектом на сервере (агент сам ходит туда по ssh).
function teamPlacement(project) {
  if (!project?.ssh) return 'local';
  return project.claudeAt === 'local' ? 'local-ssh' : 'remote';
}

// Участник на сервере: MCP по HTTP на порт туннеля, файлы — в ~/.cmdmanager/team на сервере.
const REMOTE_TEAM_DIR = '$HOME/.cmdmanager/team';
function remoteMcpSetup(member) {
  member.rport = 20000 + Math.floor(Math.random() * 40000);
  const url = `http://127.0.0.1:${member.rport}/mcp/${env.mcpSecret}/${member.token}`;
  const extraArgs = [];
  const files = {};
  let opencode = null;
  if (member.agent === 'claude') {
    const path = `${REMOTE_TEAM_DIR}/mcp-${member.token}.json`;
    files[path] = JSON.stringify({ mcpServers: { cmdmanager: { type: 'http', url } } });
    extraArgs.push('--mcp-config', `"${path}"`);
  } else if (member.agent === 'codex') {
    extraArgs.push('-c', shQuote(`mcp_servers.cmdmanager.url="${url}"`));
  } else {
    opencode = { mcp: { cmdmanager: { type: 'remote', url, enabled: true, oauth: false } } };
  }
  return { extraArgs, files, opencode, forward: `127.0.0.1:${member.rport}:${env.mcpAddr}` };
}

// Команда для сервера: записать файлы, выставить переменные, затем запустить агента.
function remotePrelude(files, vars) {
  const parts = [];
  const paths = Object.keys(files);
  if (paths.length) parts.push(`mkdir -p "${REMOTE_TEAM_DIR}"${paths.some((x) => x.startsWith('.cmdmanager/')) ? ' .cmdmanager' : ''}`);
  for (const [path, text] of Object.entries(files)) parts.push(`printf '%s' ${shQuote(text)} > "${path}"`);
  const exports = Object.entries(vars).map(([k, v]) => `${k}=${String(v).startsWith('$HOME/') ? `"${v}"` : shQuote(v)}`);
  if (exports.length) parts.push(`export ${exports.join(' ')}`);
  return parts.length ? `${parts.join('; ')}; ` : '';
}

function mcpSetupFor(member) {
  const mcpEnv = { CMDM_MCP_ADDR: env.mcpAddr, CMDM_MCP_SECRET: env.mcpSecret, CMDM_MCP_TOKEN: member.token };
  const server = { command: env.exePath, args: ['--mcp'] };
  const dir = `${env.dataDir}\\team`;
  const extraArgs = [];
  const writeFiles = {};
  const extraEnv = { ...mcpEnv };
  let opencode = null;
  if (member.agent === 'claude') {
    const path = `${dir}\\mcp-${member.token}.json`;
    writeFiles[path] = JSON.stringify({ mcpServers: { cmdmanager: { type: 'stdio', ...server, env: mcpEnv } } }, null, 1);
    extraArgs.push('--mcp-config', psQuote(path));
  } else if (member.agent === 'codex') {
    // TOML-строки в одинарных кавычках: в них нет «"» — PowerShell 5 передаст их без искажений.
    const tomlEnv = Object.entries(mcpEnv).map(([k, v]) => `${k}='${v}'`).join(',');
    extraArgs.push('-c', psQuote(`mcp_servers.cmdmanager.command='${server.command}'`),
      '-c', psQuote("mcp_servers.cmdmanager.args=['--mcp']"),
      '-c', psQuote(`mcp_servers.cmdmanager.env={${tomlEnv}}`));
  } else {
    // OpenCode и MiMo (Bun) падают, если запускать наш exe подпроцессом, — подключаем MCP по HTTP.
    opencode = { mcp: { cmdmanager: { type: 'remote', url: `http://${env.mcpAddr}/mcp/${env.mcpSecret}/${member.token}`, enabled: true, oauth: false } } };
  }
  return { extraArgs, writeFiles, extraEnv, opencode, dir };
}
function launchMember(member, { resume = false, extraFiles = null } = {}) {
  const project = state.projects.find((p) => p.id === team.projectId);
  if (!project) { toast(t('Проект команды не найден'), 'error'); return null; }
  member.token = randomToken();
  member.inbox = [];
  const launch = normalizeLaunch({ agent: member.agent, mode: member.mode || 'skip', server: member.server, model: member.model, cont: resume });
  const where = teamPlacement(project);
  if (where === 'remote') return launchRemoteMember(member, project, launch, { resume, extraFiles });
  const mcp = mcpSetupFor(member);
  const model = modelSetup(member.agent, launch);
  const extraEnv = { ...mcp.extraEnv, ...(model?.env || {}) };
  const writeFiles = { ...mcp.writeFiles, ...(extraFiles || {}) };
  if (mcp.opencode || model?.opencode) {
    const path = `${mcp.dir}\\${member.agent}-${member.token}.json`;
    writeFiles[path] = JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...(model?.opencode || {}), ...(mcp.opencode || {}) }, null, 1);
    extraEnv[member.agent === 'mimo' ? 'MIMOCODE_CONFIG' : 'OPENCODE_CONFIG'] = path;
  }
  const built = buildLaunch(launch, { shell: 'ps', prompt: resume ? '' : rolePrompt(member), extraArgs: mcp.extraArgs });
  // Окно без «запасной» оболочки: если агент завершится, программа не впишет задание в PowerShell.
  const s = addSession({
    projectId: project.id, name: `${agentDef(member.agent).name}${model ? ' · local' : ''}`, path: project.path,
    cwd: where === 'local-ssh' ? project.localDir : null,
    command: built.command, typePrompt: built.typePrompt, account: accountSetup(member.account), agent: null,
    extraEnv, writeFiles, keepShell: false,
  });
  member.sessionId = s.id;
  if (resume) deliver(member, t('[CMD Manager] Продолжаем работу команды. Посмотри текущее состояние задач и продолжай по своей роли.'), null, { silent: true });
  return s;
}

function launchRemoteMember(member, project, launch, { resume, extraFiles }) {
  const mcp = remoteMcpSetup(member);
  const model = modelSetup(member.agent, launch);
  const files = { ...mcp.files, ...(extraFiles || {}) };
  const vars = { ...(model?.env || {}) };
  if (mcp.opencode || model?.opencode) {
    const path = `${REMOTE_TEAM_DIR}/${member.agent}-${member.token}.json`;
    files[path] = JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...(model?.opencode || {}), ...(mcp.opencode || {}) });
    vars[member.agent === 'mimo' ? 'MIMOCODE_CONFIG' : 'OPENCODE_CONFIG'] = path;
  }
  const built = buildLaunch(launch, { shell: 'sh', root: project.ssh.user === 'root', prompt: resume ? '' : rolePrompt(member), extraArgs: mcp.extraArgs });
  const s = addSession({
    projectId: project.id, name: `${agentDef(member.agent).name} · ${project.ssh.host}${model ? ' · local' : ''}`, path: project.path,
    command: remotePrelude(files, vars) + built.command, typePrompt: built.typePrompt, ssh: { ...project.ssh },
    account: accountSetup(member.account, { remote: true }), agent: null, keepShell: false, sshForward: mcp.forward,
  });
  member.sessionId = s.id;
  if (resume) deliver(member, t('[CMD Manager] Продолжаем работу команды. Посмотри текущее состояние задач и продолжай по своей роли.'), null, { silent: true });
  return s;
}

// Проект на сервере, агенты на этом компьютере: подсказка, как работать с сервером.
function remoteWorkNote() {
  const project = state.projects.find((p) => p.id === team.projectId);
  if (teamPlacement(project) !== 'local-ssh') return '';
  const ssh = project.ssh;
  return ' ' + t('Проект находится на сервере {0} в папке {1}. Все команды по проекту (git, сборка, тесты) выполняй на сервере через ssh, отдельным вызовом на каждую команду: {2} \'cd {1} && …\'.', `${ssh.user}@${ssh.host}`, ssh.dir || '~', sshCommandFor(ssh));
}

function rolePrompt(member) {
  // Явный путь к папке проекта: слабые модели иначе иногда придумывают свой.
  const project = state.projects.find((p) => p.id === team.projectId);
  const where = teamPlacement(project);
  const dir = where === 'local-ssh' ? project.localDir : where === 'remote' ? (project.ssh.dir || '~') : project.path;
  const note = where === 'local-ssh' ? remoteWorkNote() : ' ' + t('Папка проекта (рабочая папка): {0}. Все файлы создавай внутри неё.', dir);
  return rolePromptText(member) + note;
}
function rolePromptText(member) {
  const others = team.members.filter((m) => m !== member).map((m) => `${memberLabel(m)} (${agentDef(m.agent).name}${modelLabel(m) ? `, ${modelLabel(m)}` : ''})`).join('; ');
  if (member.role === 'orchestrator') {
    const source = team.tasksFile
      ? t('Список задач лежит в файле {0} — прочитай его.', team.tasksFile)
      : t('Дождись от пользователя списка задач или ТЗ.');
    return t('Ты — оркестратор команды агентов в CMD Manager. Участники: {0}. У тебя есть MCP-инструменты cmdmanager: team_status, add_tasks, assign_task, message, set_task_status, list_tasks. {1} Порядок работы: 1) разбей работу на конкретные небольшие задачи и занеси их через add_tasks, у каждой — критерии приёмки; 2) выдавай разработчику ровно одну задачу через assign_task; 3) когда разработчик отчитается, отдай задачу проверяющему через assign_task (если он есть в команде); 4) по итогам проверки закрой задачу set_task_status(done) или верни разработчику через assign_task с замечаниями; 5) сам код не пиши. Отчёты участников приходят тебе сообщениями «[CMD Manager] …». После каждого assign_task заканчивай ход и жди отчёта. Пиши кратко.', others, source);
  }
  if (member.role === 'checker') {
    return t('Ты — проверяющий в команде агентов CMD Manager. Участники: {0}. Задачи на проверку приходят сообщениями «[CMD Manager] Проверка задачи #N …». Код проекта не изменяй. Проверь сборку, тесты, изменения последнего коммита (git show) и соответствие критериям приёмки. Затем вызови MCP-инструмент cmdmanager report(task_id, result=passed или rejected, summary — с конкретными замечаниями). Сейчас ничего не делай и жди первую задачу.', others);
  }
  return t('Ты — разработчик в команде агентов CMD Manager. Участники: {0}. Задачи приходят от оркестратора сообщениями «[CMD Manager] Задача #N …». Делай ровно одну полученную задачу, затем закоммить изменения (git commit -m "#N: …"), если папка — git-репозиторий, и вызови MCP-инструмент cmdmanager report(task_id, result=done, blocked или failed, summary). Если что-то неясно — инструмент ask. Других задач не бери. Сейчас ничего не делай и жди первую задачу.', others);
}
function modelLabelOf(m) { return modelLabel({ server: m.server, model: m.model }); }

// ---------- доставка сообщений в окна ----------
function deliver(to, text, from = null, { kind = 'task', label = '', silent = false } = {}) {
  if (!to) return;
  to.inbox = to.inbox || [];
  to.inbox.push(text);
  if (!silent && from) {
    flyPacket(from, to, { kind, label });
    teamLog(from, to, kind, label);
  }
  renderTeamPanel();
}

function screenTail(s, n = 20) {
  const b = s.term.buffer.active;
  const out = [];
  for (let i = Math.max(0, b.length - 60); i < b.length; i++) out.push(b.getLine(i).translateToString(true));
  return out.slice(-n).join('\n');
}

// Первый запуск агента в папке: вопрос «доверяете ли вы папке?». Проект для команды выбрал сам
// пользователь, поэтому подтверждаем автоматически (один раз на окно).
function answerTrustDialog(m, s) {
  if (m.trustAnswered || !/Yes, I trust this folder/.test(screenTail(s))) return false;
  m.trustAnswered = true;
  // Диалог принимает клавиши не сразу после отрисовки — даём ему время; Enter жмём, только когда выбран «Yes».
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    await wait(1500);
    for (let i = 0; i < 4; i++) {
      if (/❯\s*Yes, I trust this folder/.test(screenTail(s))) break;
      native.send({ type: 'input', id: s.id, data: '\x1b[B' });
      await wait(800);
    }
    if (/❯\s*Yes, I trust this folder/.test(screenTail(s))) native.send({ type: 'input', id: s.id, data: '\r' });
    else m.trustAnswered = false;  // не получилось — попробуем на следующем круге
  })();
  return true;
}

// Вписываем сообщение, только когда агент свободен: интерфейс затих хотя бы на ~2 секунды.
setInterval(() => {
  if (!team) return;
  const now = performance.now();
  for (const m of team.members) {
    const ms = sessions.get(m.sessionId);
    if (ms && ms.status === 'running' && answerTrustDialog(m, ms)) continue;
  }
  if (team.paused) return;
  for (const m of team.members) {
    if (!m.inbox?.length) continue;
    const s = sessions.get(m.sessionId);
    if (!s || s.status !== 'running' || s.pendingPrompt) continue;
    if (now - s.startedAt < 8000 || now - s.lastOutput < 2200 || now - (m.lastDelivery || 0) < 4000) continue;
    const text = m.inbox.shift();
    m.lastDelivery = now;
    native.send({ type: 'input', id: s.id, data: `\x1b[200~${text}\x1b[201~` });
    setTimeout(() => native.send({ type: 'input', id: s.id, data: '\r' }), 500);
    pulsePane(s.id);
    renderTeamPanel();
  }
}, 700);

function teamLog(from, to, kind, label) {
  team.log.push({ at: Date.now(), from: from.key, to: to.key, kind, label });
  if (team.log.length > 300) team.log.splice(0, team.log.length - 300);
  saveTeam();
}

// ---------- MCP: инструменты по ролям ----------
const TOOLS = {
  orchestrator: [
    { name: 'team_status', description: 'Team members (roles, agents, busy/idle, current task) and task board summary.', inputSchema: { type: 'object', properties: {} } },
    { name: 'add_tasks', description: 'Add tasks to the team board backlog. Returns their ids.', inputSchema: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, details: { type: 'string' }, acceptance: { type: 'string', description: 'Acceptance criteria' } }, required: ['title'] } } }, required: ['tasks'] } },
    { name: 'assign_task', description: 'Send a task to a team member (developer to implement, checker to verify). The member receives it as a message; you will get their report as a message later — end your turn after assigning.', inputSchema: { type: 'object', properties: { task_id: { type: 'integer' }, to: { type: 'string', description: 'Member key: developer, checker, developer2…' }, instructions: { type: 'string', description: 'Extra instructions or reviewer remarks' } }, required: ['task_id', 'to'] } },
    { name: 'message', description: 'Send a free-form message to a team member.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] } },
    { name: 'set_task_status', description: 'Set task status: done, failed, blocked or todo.', inputSchema: { type: 'object', properties: { task_id: { type: 'integer' }, status: { type: 'string', enum: ['done', 'failed', 'blocked', 'todo'] }, note: { type: 'string' } }, required: ['task_id', 'status'] } },
    { name: 'list_tasks', description: 'List tasks on the board, optionally filtered by status.', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
  ],
  worker: [
    { name: 'report', description: 'Report the result of your current task to the orchestrator. Developer: done | blocked | failed. Checker: passed | rejected.', inputSchema: { type: 'object', properties: { task_id: { type: 'integer' }, result: { type: 'string', enum: ['done', 'blocked', 'failed', 'passed', 'rejected'] }, summary: { type: 'string' }, details: { type: 'string' } }, required: ['task_id', 'result', 'summary'] } },
    { name: 'ask', description: 'Ask the orchestrator a question about your task.', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } },
    { name: 'my_task', description: 'Get the details of the task currently assigned to you.', inputSchema: { type: 'object', properties: {} } },
  ],
};

const taskById = (id) => team.tasks.find((x) => x.id === Number(id));
function taskText(task) {
  return `#${task.id} ${task.title}${task.details ? `\n${task.details}` : ''}${task.acceptance ? `\n${t('Критерии приёмки: {0}', task.acceptance)}` : ''}`;
}
function findMemberByName(name) {
  const n = String(name || '').toLowerCase().trim();
  return team.members.find((m) => m.key === n) || team.members.find((m) => m.role === n && m.role !== 'orchestrator')
    || team.members.find((m) => memberLabel(m).toLowerCase() === n);
}

function callTool(member, name, a = {}) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
  const orchestrator = team.members.find((m) => m.role === 'orchestrator');
  const isOrch = member.role === 'orchestrator';
  if (isOrch && !TOOLS.orchestrator.some((x) => x.name === name)) return fail(`Unknown tool ${name}`);
  if (!isOrch && !TOOLS.worker.some((x) => x.name === name)) return fail(`Unknown tool ${name}`);

  switch (name) {
    case 'team_status': {
      const members = team.members.map((m) => {
        const s = sessions.get(m.sessionId);
        const state_ = !s ? 'closed' : s.status !== 'running' ? s.status : s.busy || m.inbox?.length ? 'busy' : 'idle';
        const cur = team.tasks.find((x) => x.assignee === m.key && ['in_progress', 'review'].includes(x.status));
        return { key: m.key, role: m.role, agent: agentDef(m.agent).name, model: modelLabelOf(m) || 'cloud', state: state_, current_task: cur?.id ?? null };
      });
      const counts = {};
      for (const x of team.tasks) counts[x.status] = (counts[x.status] || 0) + 1;
      return ok(JSON.stringify({ members, tasks: counts, paused: !!team.paused }));
    }
    case 'add_tasks': {
      const list = Array.isArray(a.tasks) ? a.tasks : [];
      if (!list.length) return fail('tasks is empty');
      const ids = list.map((x) => {
        const task = { id: team.nextTaskId++, title: String(x.title || '').slice(0, 300), details: String(x.details || ''), acceptance: String(x.acceptance || ''), status: 'todo', assignee: null, attempts: 0, history: [] };
        team.tasks.push(task);
        return task.id;
      });
      saveTeam();
      renderTeamPanel();
      return ok(`Added tasks: ${ids.join(', ')}`);
    }
    case 'assign_task': {
      const task = taskById(a.task_id);
      const to = findMemberByName(a.to);
      if (!task) return fail(`Task ${a.task_id} not found`);
      if (!to || to.role === 'orchestrator') return fail(`Member "${a.to}" not found. Members: ${team.members.filter((m) => m.role !== 'orchestrator').map((m) => m.key).join(', ')}`);
      const check = to.role === 'checker';
      task.status = check ? 'review' : 'in_progress';
      task.assignee = to.key;
      if (!check) task.attempts++;
      task.history.push({ at: Date.now(), event: check ? 'review' : 'assigned', to: to.key, note: a.instructions || '' });
      const head = check ? t('[CMD Manager] Проверка задачи #{0} от оркестратора.', task.id) : t('[CMD Manager] Задача #{0} от оркестратора.', task.id);
      const tail = check
        ? t('Когда проверишь — вызови report(task_id={0}, result=passed или rejected, summary).', task.id)
        : t('Когда закончишь — вызови report(task_id={0}, result=done, blocked или failed, summary).', task.id);
      deliver(to, `${head}\n${taskText(task)}${a.instructions ? `\n${t('Указания: {0}', a.instructions)}` : ''}\n${tail}`, member, { kind: check ? 'check' : 'task', label: `#${task.id}` });
      saveTeam();
      return ok(`Task #${task.id} sent to ${to.key}. Its report will arrive as a message — end your turn now.`);
    }
    case 'message': {
      const to = findMemberByName(a.to);
      if (!to || to === member) return fail(`Member "${a.to}" not found`);
      deliver(to, t('[CMD Manager] Сообщение от оркестратора: {0}', a.text || ''), member, { kind: 'message', label: '✉' });
      return ok(`Message sent to ${to.key}`);
    }
    case 'set_task_status': {
      const task = taskById(a.task_id);
      if (!task) return fail(`Task ${a.task_id} not found`);
      task.status = a.status;
      task.history.push({ at: Date.now(), event: a.status, note: a.note || '' });
      if (a.status === 'done') {
        team.doneSinceCheckpoint = (team.doneSinceCheckpoint || 0) + 1;
        if (team.checkpointEvery > 0 && team.doneSinceCheckpoint >= team.checkpointEvery) {
          team.doneSinceCheckpoint = 0;
          team.paused = true;
          toast(t('Контрольная точка: команда на паузе — проверьте результат и нажмите «Продолжить».'));
          native.send({ type: 'attention' });
        }
      }
      saveTeam();
      renderTeamPanel();
      return ok(`Task #${task.id}: ${a.status}`);
    }
    case 'list_tasks': {
      const list = team.tasks.filter((x) => !a.status || x.status === a.status)
        .map((x) => ({ id: x.id, title: x.title, status: x.status, assignee: x.assignee, attempts: x.attempts }));
      return ok(JSON.stringify(list));
    }
    case 'report': {
      const task = taskById(a.task_id);
      if (!task) return fail(`Task ${a.task_id} not found`);
      const statusMap = { done: 'implemented', passed: 'verified', rejected: 'rejected', blocked: 'blocked', failed: 'failed' };
      task.status = statusMap[a.result] || task.status;
      task.history.push({ at: Date.now(), event: `report:${a.result}`, from: member.key, note: a.summary || '' });
      const good = a.result === 'done' || a.result === 'passed';
      deliver(orchestrator, `${t('[CMD Manager] Отчёт по задаче #{0} от {1}: {2}.', task.id, memberLabel(member), a.result)}\n${a.summary || ''}${a.details ? `\n${a.details}` : ''}`,
        member, { kind: good ? 'ok' : 'bad', label: `#${task.id} ${good ? '✓' : '✗'}` });
      saveTeam();
      return ok('Report delivered to the orchestrator. Wait for the next task.');
    }
    case 'ask': {
      deliver(orchestrator, t('[CMD Manager] Вопрос от {0}: {1}', memberLabel(member), a.question || ''), member, { kind: 'message', label: '?' });
      return ok('Question delivered. The answer will arrive as a message.');
    }
    case 'my_task': {
      const task = team.tasks.filter((x) => x.assignee === member.key).pop();
      return task ? ok(taskText(task)) : ok('No task assigned yet.');
    }
  }
  return fail('Unsupported');
}

native.on('mcp', (m) => {
  const msg = m.msg || {};
  const reply = (body) => { if (msg.id !== undefined) native.send({ type: 'mcpReply', conn: m.conn, msg: { jsonrpc: '2.0', id: msg.id, ...body } }); };
  const member = memberByToken(m.token);
  switch (msg.method) {
    case 'initialize':
      reply({ result: { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cmdmanager', version: env.version } } });
      if (member) { member.connected = true; renderTeamPanel(); }
      return;
    case 'ping': reply({ result: {} }); return;
    case 'tools/list':
      reply({ result: { tools: !member ? [] : member.role === 'orchestrator' ? TOOLS.orchestrator : TOOLS.worker } });
      return;
    case 'tools/call':
      if (!member || !team) { reply({ result: { content: [{ type: 'text', text: 'This console is not part of an active team.' }], isError: true } }); return; }
      reply({ result: callTool(member, msg.params?.name, msg.params?.arguments || {}) });
      return;
    default:
      if (msg.id !== undefined && !String(msg.method || '').startsWith('notifications/')) reply({ error: { code: -32601, message: 'Method not found' } });
  }
});

// ---------- визуальная связь: кабели и пакеты ----------
const SVGNS = 'http://www.w3.org/2000/svg';
function cableLayer() {
  let svg = document.getElementById('team-cables');
  if (!svg) {
    svg = document.createElementNS(SVGNS, 'svg');
    svg.id = 'team-cables';
    svg.innerHTML = `<defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs><g class="cables"></g><g class="packets"></g>`;
    $('#main').append(svg);
  }
  return svg;
}

function paneOf(sessionId) {
  if ($('#grid').hidden) return null;
  return [...document.querySelectorAll('#grid .pane')].find((p) => Number(p.dataset.session) === sessionId) || null;
}

// «Разъём» окна — значок роли в заголовке: кабель втыкается прямо в него.
function portPoint(sessionId) {
  const pane = paneOf(sessionId);
  if (!pane) return null;
  const base = $('#main').getBoundingClientRect();
  const chip = pane.querySelector('.role-chip');
  const r = (chip || pane.querySelector('.pane-header') || pane).getBoundingClientRect();
  if (!r.width) return null;
  return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
}

// Дуга между разъёмами: между соседями по горизонтали — над окнами, по вертикали — вбок.
function cablePath(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  if (ny > 0.01 || (Math.abs(ny) <= 0.01 && nx < 0)) { nx = -nx; ny = -ny; }
  let bulge = Math.min(140, Math.max(36, len * 0.28));
  // Дуга вверх не должна уходить за край окна: вершина кривой — примерно на 3/4 изгиба.
  const top = Math.min(a.y, b.y);
  if (ny < -0.5 && top + ny * bulge * 0.75 < 10) {
    const fit = (top - 10) / (0.75 * -ny);
    if (fit >= 28) bulge = fit;
    else { nx = -nx; ny = -ny; }  // места сверху мало — изгибаемся вниз, поверх окон
  }
  const c1 = { x: a.x + dx * 0.25 + nx * bulge, y: a.y + dy * 0.25 + ny * bulge };
  const c2 = { x: a.x + dx * 0.75 + nx * bulge, y: a.y + dy * 0.75 + ny * bulge };
  return `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`;
}

function drawTeamCables() {
  const svg = cableLayer();
  const g = svg.querySelector('.cables');
  g.replaceChildren();
  if (!team) return;
  const orch = team.members.find((m) => m.role === 'orchestrator');
  const pa = orch && portPoint(orch.sessionId);
  if (!pa) return;
  for (const m of team.members) {
    if (m === orch) continue;
    const pb = portPoint(m.sessionId);
    if (!pb) continue;
    const d = cablePath(pa, pb);
    const color = TEAM_ROLES[m.role].color;
    const mk = (cls, extra = {}) => { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); p.setAttribute('class', cls); for (const [k, v] of Object.entries(extra)) p.setAttribute(k, v); g.append(p); return p; };
    mk('cable-shell');
    mk('cable-core', { stroke: color });
    mk('cable-flow', { stroke: color, filter: 'url(#glow)' }).dataset.member = m.key;
    for (const pt of [pa, pb]) {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y + 11); c.setAttribute('r', 3.5);
      c.setAttribute('class', 'cable-plug'); c.setAttribute('stroke', color);
    }
  }
}

const PACKET_COLORS = { task: '#d97757', check: '#4fbfc4', ok: '#5fbf7f', bad: '#e5625c', message: '#c47fd5' };
function flyPacket(from, to, { kind, label }) {
  const pa = portPoint(from.sessionId), pb = portPoint(to.sessionId);
  if (!pa || !pb) return;
  const svg = cableLayer();
  // Пакет летит по тому же кабелю, что нарисован между оркестратором и исполнителем.
  const orchIsFrom = from.role === 'orchestrator';
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', orchIsFrom ? cablePath(pa, pb) : cablePath(pb, pa));
  const len = path.getTotalLength();
  const color = PACKET_COLORS[kind] || '#d97757';
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', 'packet');
  const dots = [];
  for (let i = 0; i < 6; i++) {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('r', i === 0 ? 7 : 5 - i * 0.6);
    c.setAttribute('fill', color);
    c.setAttribute('opacity', i === 0 ? 1 : 0.55 - i * 0.08);
    if (i === 0) c.setAttribute('filter', 'url(#glow)');
    g.append(c);
    dots.push(c);
  }
  const text = document.createElementNS(SVGNS, 'text');
  text.textContent = label || '';
  text.setAttribute('class', 'packet-label');
  g.append(text);
  svg.querySelector('.packets').append(g);
  // Кабель «вспыхивает», пока по нему идут данные.
  const flow = svg.querySelector(`.cable-flow[data-member="${from.role === 'orchestrator' ? to.key : from.key}"]`);
  flow?.classList.add('active');
  const t0 = performance.now(), dur = 1600;
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
  (function frame(now) {
    const p = Math.min(1, (now - t0) / dur);
    const at = (q) => path.getPointAtLength((orchIsFrom ? q : 1 - q) * len);
    dots.forEach((c, i) => {
      const pt = at(Math.max(0, ease(Math.max(0, p - i * 0.035))));
      c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y);
    });
    const head = at(ease(p));
    text.setAttribute('x', head.x + 10); text.setAttribute('y', head.y < 26 ? head.y + 22 : head.y - 10);
    if (p < 1) requestAnimationFrame(frame);
    else { g.remove(); flow?.classList.remove('active'); pulsePane(to.sessionId, color); }
  })(t0);
}

function pulsePane(sessionId, color) {
  const pane = [...document.querySelectorAll('#grid .pane')].find((p) => Number(p.dataset.session) === sessionId);
  if (!pane) return;
  pane.style.setProperty('--pulse', color || 'var(--accent)');
  pane.classList.remove('receive');
  void pane.offsetWidth;
  pane.classList.add('receive');
}

new ResizeObserver(() => drawTeamCables()).observe(document.getElementById('main'));

// ---------- панель команды ----------
function renderTeamPanel() {
  const panel = $('#team-panel');
  $('#btn-team').classList.toggle('active', !!team && !panel.hidden);
  if (!team || panel.hidden) { requestAnimationFrame(drawTeamCables); return; }
  const done = team.tasks.filter((x) => x.status === 'done').length;
  const total = team.tasks.length;
  const members = team.members.map((m) => {
    const s = sessions.get(m.sessionId);
    const st = !s ? t('окно закрыто') : s.status === 'exited' ? t('завершён') : m.inbox?.length ? t('ждёт доставки: {0}', m.inbox.length) : s.busy ? t('работает') : t('свободен');
    return el('div', { class: 'tm-member', style: `--role:${TEAM_ROLES[m.role].color}` },
      el('span', { class: 'tm-role' }, TEAM_ROLES[m.role].icon),
      el('div', {}, el('b', {}, memberLabel(m)), el('small', {}, `${agentDef(m.agent).name}${modelLabelOf(m) ? ` · ${modelLabelOf(m)}` : ''}${m.account ? ` · ${accountName(m.account)}` : ''}`)),
      el('span', { class: `tm-state${s?.busy ? ' busy' : ''}` }, st),
      !s || s.status === 'exited' ? el('button', { class: 'icon-btn small', title: t('Перезапустить'), onclick: () => { launchMember(m, { resume: true }); renderAll(); } }, icon(ICONS.restart)) : null);
  });
  const tasks = [...team.tasks].reverse().map((x) => el('div', { class: 'tm-task', title: taskText(x) },
    el('span', { class: 'tm-status', style: `background:${TASK_STATUS[x.status]?.color || '#888'}`, title: t(TASK_STATUS[x.status]?.title || x.status) }),
    el('span', { class: 'tm-id' }, `#${x.id}`), el('span', { class: 'tm-title' }, x.title),
    x.assignee ? el('span', { class: 'tm-who' }, TEAM_ROLES[teamMember(x.assignee)?.role]?.icon || '') : null));
  const log = team.log.slice(-40).reverse().map((e) => {
    const from = teamMember(e.from), to = teamMember(e.to);
    return el('div', { class: 'tm-log' }, el('span', { style: `color:${PACKET_COLORS[e.kind] || '#999'}` }, '●'),
      `${from ? memberLabel(from) : e.from} → ${to ? memberLabel(to) : e.to}`, el('span', { class: 'tm-label' }, e.label || ''),
      el('time', {}, new Date(e.at).toLocaleTimeString(i18nLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
  });
  panel.replaceChildren(
    el('div', { class: 'tm-head' },
      el('b', {}, team.name || t('Команда')),
      el('span', { class: `tm-badge${team.paused ? ' paused' : ''}` }, team.paused ? t('Пауза') : t('Работает')),
      el('button', { class: 'btn small-btn', onclick: () => { team.paused = !team.paused; saveTeam(); renderTeamPanel(); } }, team.paused ? t('Продолжить') : t('Пауза')),
      el('button', { class: 'icon-btn small', title: t('Распустить команду'), onclick: disbandTeam }, icon(ICONS.close))),
    el('div', { class: 'tm-progress' }, el('div', { style: `width:${total ? (done / total) * 100 : 0}%` })),
    el('div', { class: 'tm-progress-text' }, t('Готово {0} из {1}', done, total)),
    el('div', { class: 'tm-section' }, t('Участники')), ...members,
    el('div', { class: 'tm-section' }, t('Задачи')), tasks.length ? el('div', { class: 'tm-tasks' }, tasks) : el('div', { class: 'hint' }, t('Оркестратор ещё не добавил задачи')),
    el('div', { class: 'tm-section' }, t('Обмен')), el('div', { class: 'tm-logs' }, log));
  requestAnimationFrame(drawTeamCables);
}

async function disbandTeam() {
  const ok = await confirmDialog({ title: t('Распустить команду?'), text: t('Окна участников останутся открытыми, но связь между ними и доска задач будут удалены.'), okText: t('Распустить'), danger: true });
  if (!ok) return;
  team = null;
  state.team = null;
  saveState();
  $('#team-panel').hidden = true;
  renderAll();
}

function toggleTeamPanel() {
  if (!team) { teamWizard(); return; }
  $('#team-panel').hidden = !$('#team-panel').hidden;
  renderTeamPanel();
  requestAnimationFrame(() => { for (const s of sessions.values()) s.fitNow(); });
}

// ---------- мастер создания команды ----------
function teamWizard() {
  const local = state.projects;
  if (!local.length) { toast(t('Сначала создайте или откройте проект'), 'error'); return; }
  openModal((modal, close) => {
    const active = sessions.get(activeId);
    const projectLabel = (p) => !p.ssh ? p.name
      : `${p.name} — ${p.ssh.user}@${p.ssh.host} (${teamPlacement(p) === 'remote' ? t('агенты на сервере') : t('агенты на этом компьютере')})`;
    const project = el('select', {}, local.map((p) => el('option', { value: p.id, selected: active?.projectId === p.id }, projectLabel(p))));
    const tasks = el('textarea', { rows: 6, placeholder: t('Список задач или ТЗ — по одной задаче в строке. Можно оставить пустым и написать оркестратору потом.') });
    const checkpoint = el('input', { type: 'number', min: 0, max: 100, value: 10 });
    const available = localAgents || new Set();
    const pick = (...ids) => ids.find((id) => available.has(id)) || ids[ids.length - 1];
    const firstServer = modelServers()[0];
    let rows = [
      { role: 'orchestrator', agent: pick('codex', 'claude'), mode: 'skip', server: '', model: '', account: '' },
      { role: 'developer', agent: pick('claude', 'codex'), mode: 'skip', server: '', model: '', account: '' },
      { role: 'checker', agent: firstServer ? pick('opencode', 'claude') : pick('claude', 'codex'), mode: 'skip', server: firstServer?.id || '', model: firstServer?.models?.[0] || '', account: '' },
    ];
    const box = el('div', { class: 'tw-members' });
    const render = () => box.replaceChildren(...rows.map((r, i) => {
      const role = el('select', { onchange: (e) => { r.role = e.target.value; } },
        Object.entries(TEAM_ROLES).map(([k, v]) => el('option', { value: k, selected: r.role === k }, `${v.icon} ${t(v.title)}`)));
      const agent = el('select', { onchange: (e) => { r.agent = e.target.value; if (!LOCAL_MODEL_AGENTS.has(r.agent)) r.server = ''; render(); } },
        TEAM_AGENTS.map((id) => el('option', { value: id, selected: r.agent === id }, `${agentDef(id).name}${available.has(id) ? '' : ` — ${t('не найден')}`}`)));
      const models = [el('option', { value: '', selected: !r.server }, t('Облако'))];
      if (LOCAL_MODEL_AGENTS.has(r.agent)) for (const srv of modelServers()) for (const m of srv.models || []) models.push(el('option', { value: `${srv.id}|${m}`, selected: r.server === srv.id && r.model === m }, `${m} @ ${srv.name}`));
      const model = el('select', { onchange: (e) => { [r.server, r.model] = e.target.value.split('|'); } }, models);
      const acc = el('select', { onchange: (e) => { r.account = e.target.value; } },
        el('option', { value: '' }, t('Основной')), ...accountList().map((a) => el('option', { value: a.id, selected: r.account === a.id }, a.name)));
      return el('div', { class: 'tw-row', style: `--role:${TEAM_ROLES[r.role].color}` }, role, agent, model, acc,
        el('button', { type: 'button', class: 'icon-btn small', title: t('Удалить'), disabled: r.role === 'orchestrator' && rows.filter((x) => x.role === 'orchestrator').length === 1,
          onclick: () => { rows.splice(i, 1); render(); } }, icon(ICONS.trash)));
    }), el('button', { type: 'button', class: 'btn ghost', onclick: () => { rows.push({ role: 'developer', agent: pick('claude', 'codex'), mode: 'skip', server: '', model: '', account: '' }); render(); } }, icon(ICONS.plus), t('Добавить участника')));
    render();
    const error = el('div', { class: 'modal-error' });
    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (rows.filter((r) => r.role === 'orchestrator').length !== 1) { error.textContent = t('Нужен ровно один оркестратор'); return; }
      if (!rows.some((r) => r.role !== 'orchestrator')) { error.textContent = t('Добавьте хотя бы одного исполнителя'); return; }
      const p = state.projects.find((x) => x.id === project.value);
      error.textContent = '';
      const err = await prepareTeamProject(p);
      if (err === 'password') { close(); sshConnectDialog({ project: p }); return; }
      if (err) { error.textContent = err; return; }
      startTeam(p, rows, tasks.value.trim(), Math.max(0, Number(checkpoint.value) || 0));
      close();
    } },
      el('div', { class: 'field' }, el('label', {}, 'Проект'), project),
      el('div', { class: 'field' }, el('label', {}, 'Участники'), box,
        el('div', { class: 'hint' }, 'Роль · агент · модель (облако или ваш сервер) · аккаунт. Связь через MCP поддерживают Claude Code, Codex, OpenCode и MiMo.')),
      el('div', { class: 'field' }, el('label', {}, 'Задачи'), tasks),
      el('div', { class: 'field' }, el('label', {}, 'Пауза после каждых N готовых задач (0 — без пауз)'), checkpoint),
      error,
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn', onclick: close }, 'Отмена'),
        el('button', { type: 'submit', class: 'btn primary' }, 'Запустить команду')));
    modal.classList.add('wide');
    modal.append(el('h2', {}, 'Новая команда агентов'),
      el('div', { class: 'modal-sub' }, 'Оркестратор раздаёт задачи по одной, разработчик делает, проверяющий проверяет. Окна связываются автоматически.'), form);
  });
}

// SSH-проект: ключ готов (иначе подключаемся), для «агентов на этом компьютере» — локальная папка.
async function prepareTeamProject(p) {
  if (!p.ssh) return '';
  if (!p.ssh.keyPath) {
    const r = await native.request('sshConnect', sshTarget(p.ssh));
    if (r.needsPassword) return 'password';
    if (r.error) return r.error;
    p.ssh.keyPath = r.keyPath;
  }
  if (teamPlacement(p) === 'local-ssh') {
    const dir = p.localDir || defaultLocalDir(p.ssh, p.name);
    const r = await native.request('ensureDir', { path: dir });
    if (r.error) return r.error;
    p.localDir = r.path || dir;
  }
  saveState();
  return '';
}

function startTeam(project, rows, tasksText, checkpointEvery) {
  const count = {};
  team = {
    name: project.name, projectId: project.id, tasks: [], log: [], nextTaskId: 1, paused: false, checkpointEvery, doneSinceCheckpoint: 0, tasksFile: '',
    members: rows.map((r) => {
      count[r.role] = (count[r.role] || 0) + 1;
      return { ...r, key: count[r.role] > 1 ? `${r.role}${count[r.role]}` : r.role, inbox: [] };
    }),
  };
  // Порядок окон: оркестратор первым, дальше исполнители.
  team.members.sort((a, b) => (a.role === 'orchestrator' ? -1 : b.role === 'orchestrator' ? 1 : 0));
  const n = team.members.length;
  state.settings.layout = n <= 2 ? 2 : n <= 4 ? 4 : n <= 6 ? 6 : 8;
  // Окнам команды нужно место: прячем список проектов (вернуть — кнопкой слева вверху или Ctrl+Shift+B).
  if (state.settings.sidebar) toggleSidebar();
  panes = panes.map(() => null);
  // Файл задач: на сервере — в папке проекта (путь от неё), иначе — в папке, где запущены агенты.
  const where = teamPlacement(project);
  const tasksName = `tasks-${new Date().toISOString().slice(0, 10)}.md`;
  let tasksPath = '';
  if (tasksText) {
    if (where === 'remote') { tasksPath = `.cmdmanager/${tasksName}`; team.tasksFile = tasksPath; }
    else { tasksPath = `${where === 'local-ssh' ? project.localDir : project.path}\\.cmdmanager\\${tasksName}`; team.tasksFile = tasksPath; }
  }
  for (const m of team.members) launchMember(m, { extraFiles: m.role === 'orchestrator' && tasksText ? { [tasksPath]: tasksText } : null });
  saveTeam();
  $('#team-panel').hidden = false;
  renderAll();
  renderTeamPanel();
}

// Команда из прошлого запуска: доска задач сохраняется, окна запускаются заново по кнопке.
function restoreTeam(saved) {
  if (!saved || !Array.isArray(saved.members)) return;
  team = { ...saved, paused: true, members: saved.members.map((m) => ({ ...m, inbox: [], sessionId: null })) };
}

$('#btn-team').addEventListener('click', toggleTeamPanel);
