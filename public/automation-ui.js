const API = '/api/automation';
const panel = document.querySelector('#automationPanel');
const toggle = document.querySelector('#automationToggle');
const taskMap = new Map();
const categoryNames = {
  terminal: ['Terminal e CLI', 'Somente comandos validados; o terminal nativo é separado e sai dos controles integrados.'],
  files: ['Arquivos', 'Somente pastas concedidas, com credenciais e perfis protegidos bloqueados.'],
  apps: ['Programas', 'Abertura de navegador, calculadora ou editor da lista permitida; cada início pede aprovação.'],
  browser: ['Navegador Playwright', 'Contexto isolado e temporário; conceda cada origem HTTPS exata separadamente.']
};

function addActivity(message, kind = 'info') {
  const feed = document.querySelector('#autoTaskList');
  const row = document.createElement('div');
  row.className = 'auto-audit-item';
  row.textContent = `${new Date().toLocaleTimeString('pt-BR')} · ${kind} · ${String(message).slice(0, 500)}`;
  feed.prepend(row);
  while (feed.querySelectorAll('.auto-audit-item').length > 12) feed.lastElementChild.remove();
}

async function request(path, method = 'GET', body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Falha HTTP ${response.status}`);
  return data;
}

function statusLabel(status) {
  return ({ queued: 'na fila', awaiting_confirmation: 'aguardando sua aprovação', running: 'em execução', completed: 'concluída', failed: 'erro', cancelled: 'cancelada', interrupted_after_effect: 'interrompida após início do efeito — resultado incerto' })[status] || status;
}

function renderTask(task) {
  taskMap.set(task.id, task);
  const container = document.querySelector('#autoTaskList');
  const old = container.querySelector(`[data-task-id="${CSS.escape(task.id)}"]`);
  const card = document.createElement('article');
  card.className = 'auto-task';
  card.dataset.taskId = task.id;
  const title = document.createElement('strong');
  title.textContent = task.summary || `${task.category}: ${task.action}`;
  const status = document.createElement('small');
  status.textContent = `${statusLabel(task.status)} · ${new Date(task.updatedAt || task.createdAt).toLocaleTimeString('pt-BR')}`;
  card.append(title, status);

  if (task.confirmation?.prompt) {
    const prompt = document.createElement('p');
    prompt.textContent = task.confirmation.prompt;
    card.append(prompt);
    if (task.confirmation.details) {
      const details = document.createElement('pre');
      details.textContent = JSON.stringify(task.confirmation.details, null, 2);
      card.append(details);
    }
  }
  if (task.output) {
    const output = document.createElement('pre');
    output.textContent = task.output;
    card.append(output);
  }
  if (task.error) {
    const error = document.createElement('pre');
    error.style.color = '#ffb3bf';
    error.textContent = `Erro: ${task.error}`;
    card.append(error);
  }
  if (task.status === 'awaiting_confirmation') {
    const actions = document.createElement('div');
    actions.className = 'auto-inline';
    const approve = document.createElement('button');
    approve.type = 'button'; approve.textContent = 'Aprovar esta ação';
    const preview = task.confirmation?.details?.preview;
    if (typeof preview === 'string') {
      approve.disabled = true;
      const review = document.createElement('label');
      review.className = 'auto-review';
      const checked = document.createElement('input');
      checked.type = 'checkbox';
      const reviewText = document.createElement('span');
      reviewText.textContent = 'Revisei o payload integral no bloco rolável acima.';
      checked.addEventListener('change', () => { approve.disabled = !checked.checked; });
      review.append(checked, reviewText);
      card.append(review);
    }
    approve.addEventListener('click', () => decideTask(task, true));
    const deny = document.createElement('button');
    deny.type = 'button'; deny.textContent = 'Recusar';
    deny.addEventListener('click', () => decideTask(task, false));
    actions.append(approve, deny);
    card.append(actions);
  } else if (['queued', 'running'].includes(task.status)) {
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancelar tarefa';
    cancel.addEventListener('click', async () => {
      try { await request(`/tasks/${encodeURIComponent(task.id)}/cancel`, 'POST', {}); }
      catch (error) { addActivity(error.message, 'erro'); }
    });
    card.append(cancel);
  }
  if (old) old.replaceWith(card);
  else container.prepend(card);
  while (container.querySelectorAll('.auto-task').length > 20) container.lastElementChild.remove();
  if (['completed', 'failed', 'cancelled', 'interrupted_after_effect'].includes(task.status)) addActivity(`${task.summary}: ${statusLabel(task.status)}`, task.status);
}

async function decideTask(task, approved) {
  const details = task.confirmation?.details;
  const detail = details?.preview !== undefined
    ? `\n\nO payload integral (${details.byteLength ?? details.characterLength ?? String(details.preview).length} bytes/caracteres) está exibido no cartão. Confirme somente após revisar o bloco completo.`
    : details ? `\n\nOperação revisada:\n${JSON.stringify(details, null, 2)}` : '';
  if (approved && !window.confirm(`${task.confirmation?.prompt || 'Confirmar esta operação?'}${detail}`)) return;
  try {
    await request(`/tasks/${encodeURIComponent(task.id)}/decision`, 'POST', { approved });
    addActivity(approved ? `Ação aprovada: ${task.summary}` : `Ação recusada: ${task.summary}`, approved ? 'aprovação' : 'recusa');
  } catch (error) { addActivity(error.message, 'erro'); }
}

function renderPermissions(permissions = {}) {
  const host = document.querySelector('#autoPermissions');
  host.replaceChildren();
  for (const [category, [title, detail]] of Object.entries(categoryNames)) {
    const label = document.createElement('label');
    label.className = 'auto-permission';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = permissions.enabled?.[category] === true;
    checkbox.addEventListener('change', async () => {
      const enabled = checkbox.checked;
      if (enabled && !window.confirm(`Autorizar categoria: ${title}?\n${detail}\nA autorização não concede acesso ilimitado.`)) {
        checkbox.checked = false; return;
      }
      checkbox.disabled = true;
      try {
        const result = await request(`/permissions/${category}`, 'PATCH', { enabled, confirmed: enabled });
        renderPermissions(result.permissions);
        addActivity(enabled ? `Permissão concedida: ${title}` : `Permissão revogada: ${title}`, 'permissão');
        if (result.auditWarning) addActivity('O estado mudou, mas o evento não foi gravado na auditoria. Verifique o disco/permissões.', 'aviso de auditoria');
      } catch (error) { checkbox.checked = !enabled; addActivity(error.message, 'erro'); }
      finally { checkbox.disabled = false; }
    });
    const text = document.createElement('span');
    text.textContent = `${title}: ${checkbox.checked ? 'ATIVA' : 'desativada'} — ${detail}`;
    label.append(checkbox, text); host.append(label);
  }

  renderScopeList('#autoRoots', permissions.fileRoots || [], value => request('/scopes/files', 'DELETE', { path: value }));
  renderScopeList('#autoOrigins', permissions.browserOrigins || [], value => request('/scopes/browser', 'DELETE', { origin: value }));
}

function renderScopeList(selector, values, revoke) {
  const list = document.querySelector(selector);
  list.replaceChildren();
  for (const value of values) {
    const item = document.createElement('li');
    const text = document.createElement('span'); text.textContent = value;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Revogar';
    button.addEventListener('click', async () => {
      try {
        const label = selector === '#autoRoots' ? 'pasta' : 'origem';
        if (!window.confirm(`Revogar imediatamente o acesso a esta ${label}?`)) return;
        const result = await revoke(value);
        renderPermissions(result.permissions);
        addActivity(`Escopo revogado: ${value}`, 'permissão');
        if (result.auditWarning) addActivity('Escopo revogado, mas o evento não pôde ser gravado na auditoria.', 'aviso de auditoria');
      } catch (error) { addActivity(error.message, 'erro'); }
    });
    item.append(text, button); list.append(item);
  }
}

function renderAudit(entries = []) {
  const host = document.querySelector('#autoAudit');
  host.replaceChildren();
  for (const entry of [...entries].reverse()) {
    const row = document.createElement('div');
    row.className = 'auto-audit-item';
    row.textContent = `${entry.timestamp || ''} · ${entry.category}:${entry.action} · ${entry.status}`;
    host.append(row);
  }
  if (!entries.length) host.textContent = 'Nenhuma ação registrada.';
}

async function submitTask(path, body, method = 'POST') {
  try {
    const result = await request(path, method, body);
    if (result.task) renderTask(result.task);
    else if (result.permissions) renderPermissions(result.permissions);
    if (result.task && path === '/files' && ['create', 'write'].includes(body.action)) document.querySelector('#autoFileContent').value = '';
    if (result.task && path === '/browser/action' && body.action === 'fill') document.querySelector('#autoValue').value = '';
    if (result.auditWarning) addActivity('A ação foi aplicada, mas o evento não pôde ser gravado na auditoria.', 'aviso de auditoria');
    addActivity(`Solicitação enviada: ${path}`, 'etapa');
  } catch (error) { addActivity(error.message, 'erro'); }
}

function setPanel(open) {
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  if (open) document.querySelector('#autoCommand').focus();
}
toggle.addEventListener('click', () => setPanel(panel.hidden));
document.querySelector('#automationClose').addEventListener('click', () => setPanel(false));

for (const category of Object.keys(categoryNames)) {
  // Cada alternância passa por um diálogo de consentimento antes da concessão.
  void category;
}

document.querySelector('#autoGrantRoot').addEventListener('click', () => {
  const value = document.querySelector('#autoRoot').value.trim();
  if (!value) return addActivity('Informe uma pasta existente para conceder acesso.', 'erro');
  if (!window.confirm(`Conceder acesso de arquivos apenas a esta pasta?\n${value}\n\nArquivos de credenciais/perfis continuam bloqueados.`)) return;
  void submitTask('/scopes/files', { path: value, confirmed: true });
});

document.querySelector('#autoGrantOrigin').addEventListener('click', () => {
  const value = document.querySelector('#autoOrigin').value.trim();
  if (!value) return addActivity('Informe uma origem HTTPS exata.', 'erro');
  if (!window.confirm(`Conceder acesso do Playwright somente à origem HTTPS ${value}?\nIsso não autoriza cliques ou preenchimento sem confirmação.`)) return;
  void submitTask('/scopes/browser', { origin: value, confirmed: true });
});

document.querySelector('#autoRunCommand').addEventListener('click', () => {
  const command = document.querySelector('#autoCommand').value.trim();
  if (!command) return;
  addActivity(`Comando solicitado: ${command}`, 'comando');
  void submitTask('/terminal/run', { command });
});
document.querySelector('#autoCommand').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); document.querySelector('#autoRunCommand').click(); }
});
document.querySelector('#autoOpenTerminal').addEventListener('click', () => {
  if (!window.confirm('Abrir o terminal nativo do sistema? Ele fica fora dos controles de comando do GRID SOUL.')) return;
  void submitTask('/terminal/open', { confirmed: true });
});

document.querySelector('#autoFileSubmit').addEventListener('click', () => {
  const action = document.querySelector('#autoFileAction').value;
  const path = document.querySelector('#autoFilePath').value.trim();
  const destination = document.querySelector('#autoFileDestination').value.trim();
  const content = document.querySelector('#autoFileContent').value;
  if (!path) return addActivity('Informe o caminho dentro da pasta concedida.', 'erro');
  const body = { action, path, destination, content, confirmed: true };
  if (['create', 'write', 'mkdir', 'rename', 'delete'].includes(action)) {
    const description = action === 'delete' ? 'excluir permanentemente um arquivo' : `executar a operação ${action}`;
    if (!window.confirm(`Solicitar ${description} em ${path}? A tarefa ficará pendente para uma segunda aprovação.`)) return;
  }
  void submitTask('/files', body);
});

document.querySelector('#autoNavigate').addEventListener('click', () => {
  const url = document.querySelector('#autoUrl').value.trim();
  if (!url) return addActivity('Informe a URL do site autorizado.', 'erro');
  void submitTask('/browser/navigate', { url });
});
document.querySelector('#autoReadPage').addEventListener('click', () => void submitTask('/browser/action', { action: 'read' }));
document.querySelector('#autoFill').addEventListener('click', () => {
  const field = document.querySelector('#autoField').value.trim();
  const value = document.querySelector('#autoValue').value;
  if (!field) return addActivity('Informe o rótulo acessível do campo.', 'erro');
  void submitTask('/browser/action', { action: 'fill', field, value });
});
document.querySelector('#autoClick').addEventListener('click', () => {
  const role = document.querySelector('#autoClickRole').value;
  const target = document.querySelector('#autoClickTarget').value.trim();
  if (!target) return addActivity('Informe o nome acessível exato do botão ou link.', 'erro');
  void submitTask('/browser/action', { action: 'click', role, target });
});
document.querySelector('#autoCloseBrowser').addEventListener('click', async () => {
  try { await request('/browser/close', 'POST', {}); addActivity('Sessão Playwright fechada.', 'browser'); }
  catch (error) { addActivity(error.message, 'erro'); }
});

document.querySelectorAll('[data-auto-app]').forEach(button => button.addEventListener('click', () => {
  void submitTask('/apps/open', { app: button.dataset.autoApp });
}));
document.querySelector('#autoStopAll').addEventListener('click', async () => {
  if (!window.confirm('Interromper imediatamente todas as tarefas e fechar a sessão Playwright?')) return;
  try {
    const result = await request('/stop', 'POST', {});
    addActivity('Todas as tarefas em andamento foram interrompidas; a resposta aguarda a finalização dos cancelamentos.', 'parada');
    if (result.auditWarning) addActivity('A parada foi aplicada, mas o evento não pôde ser gravado na auditoria.', 'aviso de auditoria');
  }
  catch (error) { addActivity(error.message, 'erro'); }
});

async function initializePanel() {
  try {
    const [permissionData, taskData, auditData] = await Promise.all([
      request('/permissions'), request('/tasks'), request('/audit')
    ]);
    renderPermissions(permissionData.permissions);
    document.querySelector('#autoBrowserMode').textContent = permissionData.browserHeadless
      ? 'Playwright está em modo sem janela; para login manual, inicie com GRID_SOUL_AUTOMATION_HEADLESS=0.'
      : 'Playwright está visível; autenticação e senhas são exclusivamente manuais.';
    taskData.tasks.forEach(renderTask);
    renderAudit(auditData.entries);
  } catch (error) { addActivity(`Painel local indisponível: ${error.message}`, 'erro'); }

  const events = new EventSource(`${API}/events`);
  let streamUnavailable = false;
  events.addEventListener('snapshot', event => {
    const snapshot = JSON.parse(event.data);
    renderPermissions(snapshot.permissions);
    snapshot.tasks.forEach(renderTask);
    renderAudit(snapshot.audit);
  });
  events.addEventListener('task', event => renderTask(JSON.parse(event.data)));
  events.addEventListener('permissions', event => renderPermissions(JSON.parse(event.data)));
  events.addEventListener('audit', event => renderAudit(JSON.parse(event.data)));
  events.addEventListener('stopped', () => addActivity('Todas as tarefas foram interrompidas.', 'parada'));
  events.onopen = () => {
    if (streamUnavailable) addActivity('Canal de eventos restabelecido; o estado foi sincronizado novamente.', 'conexão');
    streamUnavailable = false;
  };
  events.onerror = () => {
    if (!streamUnavailable) addActivity('Canal de eventos interrompido; reconectando. Enquanto isso, atividades podem estar desatualizadas.', 'aviso de conexão');
    streamUnavailable = true;
  };
}

void initializePanel();
