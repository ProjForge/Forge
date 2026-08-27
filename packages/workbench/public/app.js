const state = { token: '', projects: [], project: null, agents: [], tasks: [], executions: [], contextPackages: [], view: 'overview' }
const $ = (selector) => document.querySelector(selector)

function setView(view) {
  state.view = view
  document.documentElement.dataset.workspaceView = view
  for (const section of document.querySelectorAll('[data-views]')) {
    section.hidden = !section.dataset.views.split(' ').includes(view)
  }
  for (const tab of document.querySelectorAll('.view-tab')) {
    const active = tab.dataset.view === view
    tab.classList.toggle('active', active)
    if (active) tab.setAttribute('aria-current', 'page')
    else tab.removeAttribute('aria-current')
  }
  for (const action of document.querySelectorAll('[data-action-views]')) {
    action.hidden = !action.dataset.actionViews.split(' ').includes(view)
    const primary = action.dataset.primaryViews?.split(' ').includes(view) === true
    action.classList.toggle('primary', primary)
    action.classList.toggle('secondary', !primary)
  }
}

for (const tab of document.querySelectorAll('.view-tab')) tab.addEventListener('click', () => setView(tab.dataset.view))
for (const metric of document.querySelectorAll('[data-target-view]')) metric.addEventListener('click', () => setView(metric.dataset.targetView))
setView(state.view)

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
  showMessage('')
  renderProjects()
  $('#project-name').textContent = project.name
  $('#project-description').textContent = project.description || project.projectKey
  for (const selector of ['#export-project', '#add-agent', '#add-task', '#add-memory', '#add-decision', '#query', '#search-button']) $(selector).disabled = false
  $('#tasks').textContent = 'Cargando…'
  $('#executions').textContent = 'Cargando…'
  $('#memories').textContent = 'Cargando…'
  $('#decisions').textContent = 'Cargando…'
  $('#agents').textContent = 'Cargando…'
  $('#context-packages').textContent = 'Cargando…'
  for (const selector of ['#metric-open-tasks', '#metric-running-executions', '#metric-knowledge']) $(selector).textContent = '…'
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
    $('#metric-open-tasks').textContent = String(catalog.tasks.filter((task) => !['done', 'cancelled'].includes(task.status)).length)
    $('#metric-running-executions').textContent = String(catalog.executions.filter((execution) => execution.status === 'running').length)
    $('#metric-knowledge').textContent = String(catalog.memories.length + catalog.decisions.length)
    populateAgentOptions()
    renderCatalog('#memories', catalog.memories, 'memory')
    renderCatalog('#decisions', catalog.decisions, 'decision')
    renderTasks(catalog.tasks)
    renderExecutions(catalog.executions)
    renderAgents(catalog.agents)
    renderContextPackages(catalog.contextPackages)
    renderNextStep()
  } catch (error) { showMessage(error.message, true) }
}

function showMessage(message, error = false) {
  const node = $('#workspace-message')
  node.textContent = message
  node.classList.toggle('error', error)
  node.hidden = !message
  node.setAttribute('role', error ? 'alert' : 'status')
}

function showSearchMessage(message, error = false) {
  const node = $('#search-message')
  node.textContent = message
  node.classList.toggle('error', error)
}

function renderNextStep() {
  const title = $('#next-step-title')
  const description = $('#next-step-description')
  const action = $('#next-step-action')
  if (!state.project) { action.hidden = true; return }

  let recommendation
  if (!state.agents.length) recommendation = ['Asigna el primer agente', 'Un agente asignado permite convertir una tarea en una ejecución trazable.', 'agent', 'Asignar agente']
  else if (!state.tasks.length) recommendation = ['Crea la primera tarea', 'Define el objetivo que debe ejecutar el agente dentro de este proyecto.', 'task', 'Crear tarea']
  else if (state.tasks.some((task) => !task.assignedAgentId)) recommendation = ['Asigna las tareas pendientes', 'Hay tareas sin responsable. Asígnales un agente antes de iniciarlas.', 'operation', 'Revisar tareas']
  else {
    const running = state.executions.filter((execution) => execution.status === 'running')
    const unprotected = running.find((execution) => !state.contextPackages.some((contextPackage) => contextPackage.executionId === execution.id))
    if (unprotected) recommendation = ['Protege el trabajo en curso', 'Compila su paquete de continuidad antes de cerrar la ejecución.', 'operation', 'Ver ejecución']
    else if (running.length) recommendation = ['Finaliza la ejecución', 'La continuidad ya está protegida. Registra ahora el resultado de la ejecución.', 'operation', 'Finalizar trabajo']
    else if (state.tasks.some((task) => task.status === 'in_progress')) recommendation = ['Inicia la ejecución preparada', 'La tarea está en curso y tiene agente; ya puede comenzar su ejecución.', 'operation', 'Iniciar ejecución']
    else if (state.tasks.some((task) => !['done', 'cancelled'].includes(task.status))) recommendation = ['Prepara la siguiente tarea', 'Revisa su responsable y cambia su estado a En curso cuando pueda comenzar.', 'operation', 'Abrir trabajo']
    else recommendation = ['Captura lo aprendido', 'El trabajo está cerrado. Conserva el conocimiento útil como memoria del proyecto.', 'memory', 'Guardar memoria']
  }
  title.textContent = recommendation[0]
  description.textContent = recommendation[1]
  action.dataset.nextAction = recommendation[2]
  action.textContent = recommendation[3]
  action.hidden = false
}

$('#next-step-action').addEventListener('click', () => {
  const action = $('#next-step-action').dataset.nextAction
  if (action === 'agent') openDialog('#agent-dialog')
  else if (action === 'task') openDialog('#task-dialog')
  else if (action === 'memory') openDialog('#memory-dialog')
  else setView('operation')
})

const recoveryLabels = {
  logical: 'Copia lógica', pitr: 'PITR', walTransport: 'Transporte WAL', baseBackup: 'Base física',
}
const healthLabels = { healthy: 'Sano', degraded: 'Atención', failed: 'Fallo', unconfigured: 'Sin configurar' }

function renderRecoveryHealth(recovery) {
  const overall = $('#recovery-overall')
  overall.className = `health-badge ${recovery.overall}`
  overall.textContent = healthLabels[recovery.overall] || 'Desconocido'
  const metric = $('#metric-recovery')
  metric.textContent = healthLabels[recovery.overall] || 'Desconocido'
  metric.className = recovery.overall
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
  showSearchMessage($('#rerank').checked ? 'Buscando y reordenando localmente…' : 'Buscando…')
  try {
    const results = await api('/api/search', { method: 'POST', body: JSON.stringify({ projectId: state.project.id, query, rerank: $('#rerank').checked }) })
    renderResults(results)
    showSearchMessage(`${results.length} resultados · ${$('#rerank').checked ? 'precisión local' : 'búsqueda rápida'}`)
  } catch (error) { showSearchMessage(error.message, true) }
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
$('#import-project').addEventListener('click', () => openDialog('#import-dialog'))
$('#add-agent').addEventListener('click', () => openDialog('#agent-dialog'))
$('#add-task').addEventListener('click', () => openDialog('#task-dialog'))
$('#add-memory').addEventListener('click', () => openDialog('#memory-dialog'))
$('#add-decision').addEventListener('click', () => openDialog('#decision-dialog'))

function downloadName(response, fallback) {
  const match = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/i)
  return match?.[1] || fallback
}

$('#export-project').addEventListener('click', async () => {
  if (!state.project) return
  const button = $('#export-project')
  button.disabled = true
  showMessage('Preparando paquete portable…')
  try {
    const response = await fetch(`/api/projects/${state.project.id}/export`, { headers: { 'x-forge-token': state.token } })
    if (!response.ok) {
      const payload = await response.json()
      throw new Error(payload.error?.message || 'No se pudo exportar el proyecto')
    }
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = downloadName(response, `${state.project.projectKey}.forge-project`)
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    showMessage('Proyecto exportado. Contiene conocimiento del proyecto: protégelo como los datos originales.')
  } catch (error) { showMessage(error.message, true) }
  finally { button.disabled = false }
})

const blockedRepositorySegment = /^(\.git|node_modules|vendor|dist|build|target|coverage|\.next|\.venv|venv)$/i
const blockedRepositoryName = /(^|[._-])(env|secret|secrets|credential|credentials|token|tokens|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|id_rsa|id_ed25519)([._-]|$)|^(\.npmrc|\.pypirc|\.netrc|\.aws)$|\.(pem|key|pfx|p12|keystore)$/i
const supportedRootFile = /^(readme|agents|changelog|contributing|security|roadmap)(\.(md|mdx|txt|rst))?$|^(package\.json|cargo\.toml|pyproject\.toml|go\.mod|requirements\.txt|pom\.xml|build\.gradle(?:\.kts)?|composer\.json)$/i
const supportedDocument = /\.(md|mdx|txt|rst)$/i

function repositoryRelativePath(file) {
  const path = (file.webkitRelativePath || file.name).replaceAll('\\', '/')
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(1).join('/') : parts[0]
}

function supportedRepositoryFile(file) {
  const path = repositoryRelativePath(file)
  const parts = path.split('/')
  const name = parts.at(-1)
  if (!path || parts.some((part) => blockedRepositorySegment.test(part) || blockedRepositoryName.test(part))) return false
  return parts.length === 1 ? supportedRootFile.test(name) : /^(docs?|documentation|adr|architecture|decisions)$/i.test(parts[0]) && supportedDocument.test(name)
}

function selectedRepositoryFiles() {
  return [...$('#repository-files').files].filter(supportedRepositoryFile).slice(0, 64)
}

function updateImportSource() {
  const source = $('#import-source').value
  for (const panel of document.querySelectorAll('[data-import-source]')) panel.hidden = panel.dataset.importSource !== source
  $('#import-preview').textContent = source === 'repository'
    ? 'Selecciona una carpeta. FORGE mostrará cuántos documentos seguros puede importar.'
    : 'Selecciona un paquete .forge-project. Su checksum se verificará antes de escribir.'
}

$('#import-source').addEventListener('change', updateImportSource)
$('#repository-files').addEventListener('change', () => {
  const all = [...$('#repository-files').files]
  const supported = selectedRepositoryFiles()
  const root = all[0]?.webkitRelativePath?.split('/')[0] || ''
  const form = $('#import-form')
  if (root) {
    if (!form.elements.name.value) form.elements.name.value = root
    if (!form.elements.projectKey.value) form.elements.projectKey.value = root.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  }
  $('#import-preview').textContent = `${supported.length} documentos compatibles · ${all.length - supported.length} archivos excluidos`
})

$('#bundle-file').addEventListener('change', async () => {
  const file = $('#bundle-file').files[0]
  if (!file) return
  try {
    const bundle = JSON.parse(await file.text())
    if (bundle.format !== 'forge-project' || bundle.formatVersion !== 1 || !bundle.payload?.project) throw new Error('Formato no reconocido')
    const form = $('#import-form')
    form.elements.projectKey.value = `${bundle.payload.project.projectKey}-import`
    form.elements.name.value = bundle.payload.project.name
    form.elements.description.value = bundle.payload.project.description || ''
    $('#import-preview').textContent = `${bundle.payload.memories?.length || 0} memorias · ${bundle.payload.decisions?.length || 0} decisiones · ${bundle.payload.tasks?.length || 0} tareas`
  } catch (error) { $('#import-preview').textContent = `Paquete no válido: ${error.message}` }
})

$('#import-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return
  event.preventDefault()
  const form = event.currentTarget
  const error = form.querySelector('.form-error')
  const submit = form.querySelector('button.primary')
  error.textContent = ''
  submit.disabled = true
  try {
    const source = form.elements.sourceType.value
    let result
    if (source === 'repository') {
      const files = selectedRepositoryFiles()
      if (!files.length) throw new Error('La carpeta no contiene documentación compatible.')
      let total = 0
      const contents = []
      for (const file of files) {
        if (file.size > 128 * 1024) throw new Error(`El documento ${repositoryRelativePath(file)} es demasiado grande.`)
        const content = await file.text()
        total += content.length
        if (content.length > 32_000 || total > 1_000_000) throw new Error('La documentación seleccionada supera los límites seguros de importación.')
        contents.push({ path: repositoryRelativePath(file), content })
      }
      result = await api('/api/imports/repository', {
        method: 'POST',
        body: JSON.stringify({
          projectKey: form.elements.projectKey.value,
          name: form.elements.name.value,
          description: form.elements.description.value || undefined,
          files: contents,
          idempotencyKey: crypto.randomUUID(),
        }),
      })
    } else {
      const file = $('#bundle-file').files[0]
      if (!file || file.size > 4 * 1024 * 1024) throw new Error('Selecciona un paquete FORGE de hasta 4 MiB.')
      result = await api('/api/imports/forge-project', {
        method: 'POST',
        body: JSON.stringify({
          bundle: JSON.parse(await file.text()),
          targetProjectKey: form.elements.projectKey.value,
          targetProjectName: form.elements.name.value,
          mode: form.elements.mode.value,
          idempotencyKey: crypto.randomUUID(),
        }),
      })
    }
    state.projects = await api('/api/projects')
    form.reset()
    updateImportSource()
    form.closest('dialog').close()
    await selectProject(result.project)
    showMessage(`Importación completa: ${result.imported.memories} memorias, ${result.imported.decisions} decisiones y ${result.imported.tasks} tareas.`)
  } catch (cause) { error.textContent = cause.message }
  finally { submit.disabled = false }
})

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
