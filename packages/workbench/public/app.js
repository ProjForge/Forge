const state = { token: '', projects: [], project: null }
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
    const select = document.createElement('select')
    select.setAttribute('aria-label', `Estado de ${task.title}`)
    for (const [value, label] of Object.entries(taskStatusLabels)) select.add(new Option(label, value, false, task.status === value))
    select.addEventListener('change', async () => {
      select.disabled = true
      try {
        await api(`/api/projects/${state.project.id}/tasks/${task.id}/status`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: task.version, status: select.value }) })
        await selectProject(state.project)
      } catch (error) { showMessage(error.message, true); select.value = task.status }
      finally { select.disabled = false }
    })
    controls.append(meta, select)
    card.append(controls)
    container.append(card)
  }
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
    container.append(card)
  }
}

async function selectProject(project) {
  state.project = project
  renderProjects()
  $('#project-name').textContent = project.name
  $('#project-description').textContent = project.description || project.projectKey
  for (const selector of ['#add-task', '#add-memory', '#add-decision', '#query', '#search-button']) $(selector).disabled = false
  $('#tasks').textContent = 'Cargando…'
  $('#executions').textContent = 'Cargando…'
  $('#memories').textContent = 'Cargando…'
  $('#decisions').textContent = 'Cargando…'
  try {
    const catalog = await api(`/api/projects/${project.id}/catalog`)
    $('#task-count').textContent = String(catalog.tasks.length)
    $('#execution-count').textContent = String(catalog.executions.length)
    $('#memory-count').textContent = String(catalog.memories.length)
    $('#decision-count').textContent = String(catalog.decisions.length)
    renderCatalog('#memories', catalog.memories, 'memory')
    renderCatalog('#decisions', catalog.decisions, 'decision')
    renderTasks(catalog.tasks)
    renderExecutions(catalog.executions)
  } catch (error) { showMessage(error.message, true) }
}

function showMessage(message, error = false) {
  const node = $('#search-message')
  node.textContent = message
  node.classList.toggle('error', error)
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
$('#new-project').addEventListener('click', () => openDialog('#project-dialog'))
$('#add-task').addEventListener('click', () => openDialog('#task-dialog'))
$('#add-memory').addEventListener('click', () => openDialog('#memory-dialog'))
$('#add-decision').addEventListener('click', () => openDialog('#decision-dialog'))

function bindForm(formSelector, submit) {
  const form = $(formSelector)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (event.submitter?.value === 'cancel') { form.closest('dialog').close(); return }
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
