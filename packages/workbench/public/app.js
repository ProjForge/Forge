const state = { token: '', projects: [], project: null, agents: [], tasks: [], executions: [], contextPackages: [] }
const $ = (selector) => document.querySelector(selector)

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-forge-token': state.token, ...(options.headers || {}) },
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || 'La operación ha fallado')
  return payload.result
}

function item(tagName, className, text) {
  const node = document.createElement(tagName)
  node.className = className
  node.textContent = text
  return node
}

function renderProjects() {
  const container = $('#projects')
  container.replaceChildren()
  const filter = $('#project-filter').value.trim().toLocaleLowerCase()
  const projects = filter
    ? state.projects.filter((project) => `${project.name} ${project.projectKey}`.toLocaleLowerCase().includes(filter))
    : state.projects
  for (const project of projects) {
    const button = item('button', `project-button${state.project?.id === project.id ? ' active' : ''}`, '')
    button.type = 'button'
    button.append(item('strong', '', project.name), item('span', '', project.projectKey))
    button.addEventListener('click', () => selectProject(project))
    container.append(button)
  }
}

$('#project-filter').addEventListener('input', renderProjects)

function renderCatalog(target, records, kind) {
  const container = $(target)
  container.replaceChildren()
  container.classList.toggle('empty', records.length === 0)
  if (!records.length) { container.textContent = `No hay ${kind === 'memory' ? 'memorias' : 'decisiones'} todavía.`; return }
  for (const record of records) {
    const card = item('article', 'catalog-item', '')
    card.append(item('strong', '', record.title || 'Sin título'))
    if (record.summary || record.rationale) card.append(item('p', '', record.summary || record.rationale))
    const meta = item('div', 'meta', '')
    meta.append(item('span', '', kind === 'memory' ? record.memoryType : record.decisionKey), item('span', '', kind === 'memory' ? record.importance : record.status), item('span', '', new Date(record.updatedAt).toLocaleDateString()))
    card.append(meta)
    container.append(card)
  }
}

const taskStatusLabels = { proposed: 'Propuesta', ready: 'Lista', in_progress: 'En curso', blocked: 'Bloqueada', done: 'Terminada', cancelled: 'Cancelada' }

function renderTasks(tasks) {
  const container = $('#tasks')
  container.replaceChildren()
  container.classList.toggle('empty', tasks.length === 0)
  if (!tasks.length) { container.textContent = 'No hay tareas todavía.'; return }
  for (const task of tasks) {
    const card = item('article', 'catalog-item task-item', '')
    card.append(item('strong', '', task.title))
    if (task.objective) card.append(item('p', '', task.objective))
    const controls = item('div', 'task-controls', '')
    const meta = item('div', 'meta', '')
    meta.append(item('span', '', task.taskKey), item('span', '', task.priority), item('span', '', `v${task.version}`))
    const statusSelect = document.createElement('select')
    statusSelect.setAttribute('aria-label', `Estado de ${task.title}`)
    for (const [value, label] of Object.entries(taskStatusLabels)) statusSelect.add(new Option(label, value, false, task.status === value))
    statusSelect.addEventListener('change', async () => {
      statusSelect.disabled = true
      try {
        await api(`/api/projects/${state.project.id}/tasks/${task.id}/status`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: task.version, status: statusSelect.value }) })
        await selectProject(state.project)
      } catch (error) { showMessage(error.message, true); statusSelect.value = task.status }
      finally { statusSelect.disabled = false }
    })
    const agentSelect = document.createElement('select')
    agentSelect.setAttribute('aria-label', `Agente asignado a ${task.title}`)
    agentSelect.add(new Option('Sin agente', '', false, task.assignedAgentId === null))
    for (const agent of state.agents) agentSelect.add(new Option(agent.name, agent.id, false, task.assignedAgentId === agent.id))
    agentSelect.addEventListener('change', async () => {
      agentSelect.disabled = true
      try {
        await api(`/api/projects/${state.project.id}/tasks/${task.id}/assignment`, {
          method: 'PATCH',
          body: JSON.stringify({ expectedVersion: task.version, assignedAgentId: agentSelect.value || null }),
        })
        await selectProject(state.project)
      } catch (error) { showMessage(error.message, true); agentSelect.value = task.assignedAgentId || '' }
      finally { agentSelect.disabled = false }
    })
    controls.append(meta, agentSelect, statusSelect)
    card.append(controls)
    if (task.assignedAgentId) {
      const running = state.executions.some((execution) => execution.taskId === task.id && execution.status === 'running')
      const start = item('button', 'secondary workflow-button', running ? 'Ejecución activa' : 'Iniciar ejecución')
      start.type = 'button'
      start.disabled = running || task.status !== 'in_progress'
      start.title = task.status === 'in_progress' ? '' : 'Pon la tarea en curso antes de iniciar una ejecución.'
      start.addEventListener('click', async () => {
        start.disabled = true
        try {
          const requestId = crypto.randomUUID()
          await api(`/api/projects/${state.project.id}/tasks/${task.id}/executions`, {
            method: 'POST',
            body: JSON.stringify({
              agentId: task.assignedAgentId,
              executionKey: `human:${task.taskKey.slice(0, 100)}:${requestId}`,
              policyVersion: 'workbench-human-v1',
              idempotencyKey: requestId,
            }),
          })
          await selectProject(state.project)
        } catch (error) { showMessage(error.message, true); start.disabled = false }
      })
      card.append(start)
    }
    container.append(card)
  }
}

function renderAgents(agents) {
  const container = $('#agents')
  container.replaceChildren()
  container.classList.toggle('empty', agents.length === 0)
  if (!agents.length) { container.textContent = 'No hay agentes asignados.'; return }
  for (const agent of agents) {
    const card = item('article', 'catalog-item', '')
    card.append(item('strong', '', agent.name))
    const meta = item('div', 'meta', '')
    meta.append(item('span', '', agent.agentKey), item('span', '', agent.assignmentRole || agent.role || 'sin rol'), item('span', '', agent.assignmentStatus))
    card.append(meta)
    container.append(card)
  }
}

async function inspectContinuation(summary) {
  const content = $('#context-detail')
  content.textContent = 'Cargando paquete…'
  openDialog('#context-dialog')
  try {
    const context = await api(`/api/projects/${state.project.id}/context-packages/${summary.id}`)
    content.replaceChildren()
    content.append(item('h3', '', context.task.title))
    const meta = item('div', 'meta', '')
    meta.append(
      item('span', '', `${context.memories.length} memorias`),
      item('span', '', `${context.decisions.length} decisiones`),
      item('span', '', context.staleSources.length ? `${context.staleSources.length} fuentes obsoletas` : 'vigente'),
    )
    content.append(meta, item('p', '', context.task.objective || 'Sin objetivo descrito.'))
    content.append(item('h4', '', 'Huella inmutable'), item('code', 'package-hash', context.packageHash))
    for (const [title, records] of [['Memorias', context.memories], ['Decisiones', context.decisions]]) {
      content.append(item('h4', '', title))
      const list = document.createElement('ul')
      for (const record of records) list.append(item('li', '', record.title || record.decisionKey || 'Sin título'))
      if (!records.length) list.append(item('li', 'muted', 'Ninguna incluida.'))
      content.append(list)
    }
  } catch (error) { content.textContent = error.message }
}

function renderContextPackages(packages) {
  const container = $('#context-packages')
  container.replaceChildren()
  container.classList.toggle('empty', packages.length === 0)
  if (!packages.length) { container.textContent = 'No hay paquetes de continuidad.'; return }
  for (const contextPackage of packages) {
    const button = item('button', 'catalog-item inspect-button', '')
    button.type = 'button'
    button.append(item('strong', '', `Paquete ${contextPackage.id.slice(0, 8)}`))
    const meta = item('div', 'meta', '')
    meta.append(item('span', '', `${contextPackage.itemCount} fuentes`), item('span', '', new Date(contextPackage.createdAt).toLocaleString()))
    button.append(meta)
    button.addEventListener('click', () => inspectContinuation(contextPackage))
    container.append(button)
  }
}

function populateAgentOptions() {
  const select = $('#task-agent')
  select.replaceChildren(new Option('Sin agente', ''))
  for (const agent of state.agents) select.add(new Option(agent.name, agent.id))
}

function renderExecutions(executions) {
  const container = $('#executions')
  container.replaceChildren()
  container.classList.toggle('empty', executions.length === 0)
  if (!executions.length) { container.textContent = 'No hay ejecuciones todavía.'; return }
  for (const execution of executions) {
    const card = item('article', 'catalog-item', '')
    card.append(item('strong', '', execution.executionKey || 'Ejecución sin clave'))
    const meta = item('div', 'meta', '')
    meta.append(item('span', '', execution.status), item('span', '', execution.taskId ? 'vinculada a tarea' : 'sin tarea'), item('span', '', new Date(execution.updatedAt).toLocaleString()))
    card.append(meta)
    if (execution.status === 'running' && execution.taskId && execution.agentId) {
      const actions = item('div', 'execution-actions', '')
      const hasContext = state.contextPackages.some((contextPackage) => contextPackage.executionId === execution.id)
      const compile = item('button', 'secondary workflow-button', hasContext ? 'Continuidad lista' : 'Compilar continuidad')
      compile.type = 'button'
      compile.disabled = hasContext
      compile.addEventListener('click', async () => {
        compile.disabled = true
        try {
          await api(`/api/projects/${state.project.id}/executions/${execution.id}/continuation`, {
            method: 'POST',
            body: JSON.stringify({ taskId: execution.taskId, agentId: execution.agentId, idempotencyKey: crypto.randomUUID() }),
          })
          await selectProject(state.project)
        } catch (error) { showMessage(error.message, true); compile.disabled = false }
      })
      const finish = document.createElement('select')
      finish.setAttribute('aria-label', `Finalizar ${execution.executionKey || 'ejecución'}`)
      finish.add(new Option('Finalizar…', ''))
      const success = new Option('Completada', 'succeeded')
      success.disabled = !hasContext
      finish.add(success)
      finish.add(new Option('Fallida', 'failed'))
      finish.add(new Option('Cancelada', 'cancelled'))
      finish.addEventListener('change', async () => {
        if (!finish.value) return
        finish.disabled = true
        try {
          await api(`/api/projects/${state.project.id}/executions/${execution.id}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ agentId: execution.agentId, expectedVersion: execution.version, status: finish.value }),
          })
          await selectProject(state.project)
        } catch (error) { showMessage(error.message, true); finish.value = ''; finish.disabled = false }
      })
      actions.append(compile, finish)
      card.append(actions)
    }
    container.append(card)
  }
}

async function selectProject(project) {
  state.project = project
  renderProjects()
  $('#project-name').textContent = project.name
  $('#project-description').textContent = project.description || project.projectKey
  for (const selector of ['#add-agent', '#add-task', '#add-memory', '#add-decision', '#query', '#search-button']) $(selector).disabled = false
  $('#tasks').textContent = 'Cargando…'
  $('#executions').textContent = 'Cargando…'
  $('#memories').textContent = 'Cargando…'
  $('#decisions').textContent = 'Cargando…'
  $('#agents').textContent = 'Cargando…'
  $('#context-packages').textContent = 'Cargando…'
  try {
    const catalog = await api(`/api/projects/${project.id}/catalog`)
    $('#task-count').textContent = String(catalog.tasks.length)
    $('#execution-count').textContent = String(catalog.executions.length)
    $('#memory-count').textContent = String(catalog.memories.length)
    $('#decision-count').textContent = String(catalog.decisions.length)
    $('#agent-count').textContent = String(catalog.agents.length)
    $('#context-count').textContent = String(catalog.contextPackages.length)
    state.agents = catalog.agents
    state.tasks = catalog.tasks
    state.executions = catalog.executions
    state.contextPackages = catalog.contextPackages
    populateAgentOptions()
    renderCatalog('#memories', catalog.memories, 'memory')
    renderCatalog('#decisions', catalog.decisions, 'decision')
    renderTasks(catalog.tasks)
    renderExecutions(catalog.executions)
    renderAgents(catalog.agents)
    renderContextPackages(catalog.contextPackages)
  } catch (error) { showMessage(error.message, true) }
}

function showMessage(message, error = false) {
  const node = $('#search-message')
  node.textContent = message
  node.classList.toggle('error', error)
}

const recoveryLabels = {
  logical: 'Copia lógica', pitr: 'PITR', walTransport: 'Transporte WAL', baseBackup: 'Base física',
}
const healthLabels = { healthy: 'Sano', degraded: 'Atención', failed: 'Fallo', unconfigured: 'Sin configurar' }

function renderRecoveryHealth(recovery) {
  const overall = $('#recovery-overall')
  overall.className = `health-badge ${recovery.overall}`
  overall.textContent = healthLabels[recovery.overall] || 'Desconocido'
  const container = $('#recovery-health')
  container.replaceChildren()
  for (const key of ['logical', 'pitr', 'walTransport', 'baseBackup']) {
    const component = recovery[key]
    const card = item('article', `recovery-card ${component.state}`, '')
    const heading = item('div', 'recovery-card-heading', '')
    heading.append(item('strong', '', recoveryLabels[key]), item('span', `health-badge ${component.state}`, healthLabels[component.state]))
    card.append(heading, item('p', '', component.summary))
    if (component.updatedAt) card.append(item('time', '', `Actualizado ${new Date(component.updatedAt).toLocaleString()}`))
    if (Array.isArray(component.checks) && component.checks.length) {
      const checks = item('ul', 'recovery-checks', '')
      for (const check of component.checks) checks.append(item('li', check.status.toLowerCase(), `${check.name}: ${check.detail}`))
      card.append(checks)
    }
    container.append(card)
  }
}

function renderResults(results) {
  const container = $('#results')
  container.replaceChildren()
  results.forEach((result, index) => {
    const card = item('article', 'result', '')
    card.append(item('span', 'rank', String(index + 1).padStart(2, '0')))
    const copy = document.createElement('div')
    const title = item('strong', '', result.title || 'Sin título')
    title.prepend(item('span', 'tag', result.sourceKind))
    copy.append(title, item('p', '', result.summary || 'Sin resumen disponible.'))
    card.append(copy, item('span', 'score', `${(result.score * 100).toFixed(1)}%`))
    container.append(card)
  })
}

$('#search-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!state.project) return
  const query = $('#query').value.trim()
  if (!query) return
  $('#search-button').disabled = true
  showMessage($('#rerank').checked ? 'Buscando y reordenando localmente…' : 'Buscando…')
  try {
    const results = await api('/api/search', { method: 'POST', body: JSON.stringify({ projectId: state.project.id, query, rerank: $('#rerank').checked }) })
    renderResults(results)
    showMessage(`${results.length} resultados · ${$('#rerank').checked ? 'precisión local' : 'búsqueda rápida'}`)
  } catch (error) { showMessage(error.message, true) }
  finally { $('#search-button').disabled = false }
})

function openDialog(selector) { $(selector).showModal() }
for (const cancel of document.querySelectorAll('dialog [value="cancel"]')) {
  cancel.addEventListener('click', (event) => {
    event.preventDefault()
    cancel.closest('dialog').close()
  })
}
$('#new-project').addEventListener('click', () => openDialog('#project-dialog'))
$('#add-agent').addEventListener('click', () => openDialog('#agent-dialog'))
$('#add-task').addEventListener('click', () => openDialog('#task-dialog'))
$('#add-memory').addEventListener('click', () => openDialog('#memory-dialog'))
$('#add-decision').addEventListener('click', () => openDialog('#decision-dialog'))

function bindForm(formSelector, submit) {
  const form = $(formSelector)
  form.addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return
    event.preventDefault()
    const error = form.querySelector('.form-error')
    error.textContent = ''
    try {
      await submit(Object.fromEntries(new FormData(form)))
      form.reset(); form.closest('dialog').close()
    } catch (cause) { error.textContent = cause.message }
  })
}

bindForm('#project-form', async (data) => {
  const project = await api('/api/projects', { method: 'POST', body: JSON.stringify(data) })
  state.projects.unshift(project); await selectProject(project)
})
bindForm('#memory-form', async (data) => {
  await api(`/api/projects/${state.project.id}/memories`, { method: 'POST', body: JSON.stringify({ ...data, idempotencyKey: crypto.randomUUID() }) })
  await selectProject(state.project)
})
bindForm('#agent-form', async (data) => {
  await api(`/api/projects/${state.project.id}/agents`, { method: 'POST', body: JSON.stringify(data) })
  await selectProject(state.project)
})
bindForm('#task-form', async (data) => {
  await api(`/api/projects/${state.project.id}/tasks`, { method: 'POST', body: JSON.stringify({ ...data, idempotencyKey: crypto.randomUUID() }) })
  await selectProject(state.project)
})
bindForm('#decision-form', async (data) => {
  await api(`/api/projects/${state.project.id}/decisions`, { method: 'POST', body: JSON.stringify({ ...data, idempotencyKey: crypto.randomUUID() }) })
  await selectProject(state.project)
})

async function boot() {
  try {
    state.token = (await (await fetch('/api/bootstrap')).json()).token
    const [status, projects] = await Promise.all([api('/api/status'), api('/api/projects')])
    state.projects = projects
    renderRecoveryHealth(status.recovery)
    $('#health-dot').classList.add('good')
    $('#health').textContent = `PostgreSQL ${status.serverVersion} · Schema ${status.schemaVersion}`
    renderProjects()
    const initial = projects.find((project) => project.projectKey === 'forge-core') || projects[0]
    if (initial) await selectProject(initial)
  } catch (error) {
    $('#health').textContent = 'FORGE no disponible'
    showMessage(error.message, true)
  }
}

void boot()
