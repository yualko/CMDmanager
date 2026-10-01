'use strict';

// ============================================================================
// Серверы моделей: свои LLM (llama.cpp, Ollama, LM Studio, vLLM — OpenAI-совместимый API).
// Агент запускается «на модели с сервера» через переменные окружения или свой файл конфига:
//   Claude Code — API Anthropic (/v1/messages, есть в llama.cpp), Qwen Code — OPENAI_*,
//   OpenCode / MiMo — провайдер @ai-sdk/openai-compatible в конфиге.
// ============================================================================
const LOCAL_MODEL_AGENTS = new Set(['claude', 'opencode', 'mimo', 'qwen']);

function modelServers() { return state.settings.modelServers || []; }
function findModelServer(id) { return modelServers().find((s) => s.id === id) || null; }
function serverBase(url) { return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, ''); }

// Список моделей сервера.
async function probeModelServer(url) {
  const r = await native.request('http', { method: 'GET', url: `${serverBase(url)}/v1/models`, timeoutMs: 8000 });
  if (r.error || r.status !== 200) return { error: r.error || `HTTP ${r.status}` };
  try {
    const j = JSON.parse(r.body);
    const models = (j.data || j.models || []).map((m) => m.id || m.model || m.name).filter(Boolean);
    return { models: [...new Set(models)] };
  } catch {
    return { error: t('Неожиданный ответ сервера:\n{0}', r.body.slice(0, 200)) };
  }
}

// Проверка, что модель умеет вызывать инструменты — без этого агент на ней работать не сможет.
async function testToolCalling(url, model) {
  const body = JSON.stringify({
    model, max_tokens: 400,
    messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
  });
  const r = await native.request('http', { method: 'POST', url: `${serverBase(url)}/v1/chat/completions`, body, timeoutMs: 180000 });
  if (r.error || r.status !== 200) return { ok: false, error: r.error || `HTTP ${r.status}` };
  try {
    const j = JSON.parse(r.body);
    return { ok: !!j.choices?.[0]?.message?.tool_calls?.length, speed: j.timings?.predicted_per_second };
  } catch {
    return { ok: false, error: 'JSON' };
  }
}

// Как передать агенту модель с сервера: { env } или { opencode: <часть конфига OpenCode/MiMo> }.
function modelSetup(agentId, launch) {
  const srv = findModelServer(launch?.server);
  if (!srv || !LOCAL_MODEL_AGENTS.has(agentId)) return null;
  const model = launch.model || srv.models?.[0] || '';
  const base = serverBase(srv.url);
  const key = srv.apiKey || 'local';
  if (agentId === 'claude') {
    return { env: {
      ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    } };
  }
  if (agentId === 'qwen') return { env: { OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_KEY: key, OPENAI_MODEL: model } };
  return { opencode: {
    provider: { 'cmdm-local': { npm: '@ai-sdk/openai-compatible', name: srv.name, options: { baseURL: `${base}/v1`, apiKey: key }, models: { [model]: { name: model, tool_call: true } } } },
    model: `cmdm-local/${model}`,
  } };
}

function modelLabel(launch) {
  const srv = findModelServer(launch?.server);
  return srv ? `${launch.model || srv.models?.[0] || '?'} @ ${srv.name}` : '';
}

// ---------- настройки: список серверов ----------
function modelServersEditor() {
  let servers = modelServers().map((s) => ({ ...s, models: [...(s.models || [])] }));
  const box = el('div', { class: 'servers' });
  const render = () => box.replaceChildren(
    ...servers.map((s) => {
      const name = el('input', { type: 'text', value: s.name, placeholder: t('Название'), spellcheck: 'false', oninput: (e) => { s.name = e.target.value; } });
      const url = el('input', { type: 'text', class: 'mono', value: s.url, placeholder: 'http://192.168.1.224:8080', spellcheck: 'false', oninput: (e) => { s.url = e.target.value; } });
      const status = el('div', { class: 'hint server-status' }, s.models?.length ? t('Модели: {0}', s.models.join(', ')) : t('Нажмите «Проверить»'));
      const check = el('button', { type: 'button', class: 'btn small-btn', onclick: async () => {
        check.disabled = true;
        status.textContent = t('Проверяю…');
        const r = await probeModelServer(s.url);
        if (r.error) { status.textContent = t('Ошибка: {0}', r.error); check.disabled = false; return; }
        s.models = r.models;
        status.textContent = t('Модели: {0}. Проверяю вызов инструментов…', r.models.join(', '));
        const tc = r.models[0] ? await testToolCalling(s.url, r.models[0]) : { ok: false };
        status.textContent = tc.ok
          ? t('Модели: {0}. Инструменты работают ✓{1}', r.models.join(', '), tc.speed ? ` · ${Math.round(tc.speed)} ${t('ток/с')}` : '')
          : t('Модели: {0}. Модель не вызвала инструмент — агенты на ней могут работать плохо.', r.models.join(', '));
        check.disabled = false;
      } }, 'Проверить');
      return el('div', { class: 'server-row' },
        el('div', { class: 'row' }, name, url, check,
          el('button', { type: 'button', class: 'icon-btn small', title: t('Удалить'), onclick: () => { servers = servers.filter((x) => x !== s); render(); } }, icon(ICONS.trash))),
        status);
    }),
    el('button', { type: 'button', class: 'btn ghost', onclick: () => {
      servers.push({ id: `srv${uid().replace(/[^a-z0-9]/g, '')}`, name: t('Локальная модель'), url: '', apiKey: '', models: [] });
      render();
    } }, icon(ICONS.plus), t('Добавить сервер')));
  render();
  return { node: box, read: () => servers.filter((s) => s.url.trim()).map((s) => ({ ...s, name: s.name.trim() || serverBase(s.url) })) };
}
