const $ = (selector) => document.querySelector(selector)
const sections = {
  inicio: ['Inicio', 'Buscar proyectos o tareas'],
  proyectos: ['Proyectos', 'Buscar por nombre o clave'],
  tareas: ['Tareas', 'Buscar por título o clave'],
}
const statusLabels = { proposed: 'Propuesta', ready: 'Lista', in_progress: 'En curso', blocked: 'Bloqueada', done: 'Completada', cancelled: 'Cancelada' }
const priorityLabels = { low: 'Baja', normal: 'Normal', high: 'Alta', critical: 'Crítica' }

function node(tag, text, className = '') {
  const element = document.createElement(tag)
  element.textContent = text
  element.className = className
  return element
}

function button(text, click) {
  const element = node('button', text, 'secondary')
  element.type = 'button'
  element.addEventListener('click', click)
  return element
}

function route(hash) {
  const [path, query] = hash.slice(1).split('?')
  const [section, projectId, tasks, taskId, extra] = path.split('/')
  if (section === 'proyectos' && projectId && !extra) {
    if (!tasks) return { section: 'proyectos', projectId }
    if (tasks === 'tareas' && taskId) return { section: 'tareas', projectId, taskId }
  }
  return { section: Object.hasOwn(sections, section) ? section : 'inicio', params: new URLSearchParams(query) }
}

function queryPath(kind, params, cursor) {
  const query = new URLSearchParams(params)
  if (cursor) {
    query.set('cursorId', cursor.id)
    query.set('cursorAt', cursor.createdAt)
  }
  return '/api/discovery/' + kind + '?' + query
}

function resultRow(kind, record, select) {
  const project = kind === 'projects'
  const name = project ? record.name : record.title
  const row = node('li', '', 'discovery-result')
  const link = select ? button(name, () => select(record)) : node('a', name, 'discovery-link')
  if (!select) {
    link.href = '#proyectos/' + (project ? record.id : record.projectId + '/tareas/' + record.id)
    link.id = 'result-' + record.id
    link.dataset.result = 'true'
  }
  row.append(link, node('span', project ? record.projectKey : record.taskKey, 'result-key'))
  if (!project) {
    const details = node('div', '', 'result-details')
    details.append(node('span', record.projectName), node('span', statusLabels[record.status], 'result-status'),
      node('span', 'Prioridad ' + priorityLabels[record.priority].toLowerCase()),
      node('span', record.assignedAgentName || 'Sin responsable'))
    row.append(details)
  }
  return row
}

function showGroup({ container, label, kind, params, api, signal, snapshot, select, target }) {
  const panel = node('section', '', 'discovery-panel')
  if (label) panel.append(node('h2', label))
  const status = node('p', '', 'muted')
  status.setAttribute('role', 'status')
  const list = node('ul', '', 'discovery-list')
  const controls = node('div', '', 'discovery-controls')
  panel.append(status, list, controls)
  container.append(panel)

  function append(records) {
    list.append(...records.map((record) => resultRow(kind, record, select)))
  }

  function actions() {
    controls.replaceChildren()
    if (snapshot.nextCursor) controls.append(button('Cargar más ' + (kind === 'projects' ? 'proyectos' : 'tareas'), () => load(true)))
    if (target) {
      const link = node('a', kind === 'projects' ? 'Ver todos los proyectos' : 'Ver todas las tareas', 'discovery-link')
      link.href = target
      controls.append(link)
    }
  }

  async function load(more) {
    const cursor = more ? snapshot.nextCursor : null
    controls.replaceChildren()
    status.textContent = more ? 'Cargando más resultados…' : 'Buscando…'
    try {
      const page = await api(queryPath(kind, params, cursor), { signal })
      if (signal.aborted) return
      snapshot.items ??= []
      snapshot.items.push(...page.items)
      snapshot.nextCursor = page.nextCursor
      append(page.items)
      status.textContent = snapshot.items.length ? snapshot.items.length + ' resultados' : 'No hay resultados.'
      actions()
      if (more) list.children[snapshot.items.length - page.items.length]?.querySelector('a,button')?.focus()
    } catch {
      if (signal.aborted) return
      status.textContent = 'No se pudo cargar el listado.'
      controls.append(button('Reintentar', () => load(more)))
    }
  }

  if (snapshot.items) {
    append(snapshot.items)
    status.textContent = snapshot.items.length ? snapshot.items.length + ' resultados' : 'No hay resultados.'
    actions()
  } else void load(false)
}

export function createDiscoveryNavigation({ api, openProject, openTask, leaveProject }) {
  const query = $('#discovery-query')
  const status = $('#discovery-status')
  const priority = $('#discovery-priority')
  const picker = $('#project-picker')
  const projectLabel = $('#project-picker-open')
  const pickerInput = $('#project-picker-query')
  let activeHash = ''
  let projectId = null
  let controller
  let timer
  let pickerController
  let pickerTimer
  let previousList
  let previousHistoryState = history.state

  function abortSearch() {
    clearTimeout(timer)
    controller?.abort()
    controller = new AbortController()
    return controller.signal
  }

  function showLists(params, { reuse = false } = {}) {
    const { section } = route(location.hash)
    const signal = abortSearch()
    const container = $('#discovery-groups')
    container.replaceChildren()
    const q = params.get('q') || ''
    const home = section === 'inicio'
    const snapshots = reuse && previousList?.hash === location.hash ? previousList.snapshots : {}
    previousList = { hash: location.hash, snapshots }
    if (section !== 'tareas') {
      const limit = home && !q ? 5 : 30
      showGroup({ container, kind: 'projects', api, signal, snapshot: snapshots.projects ??= {},
        label: home ? (q ? 'Proyectos' : 'Proyectos recientes') : '',
        params: { q, limit }, target: home ? '#proyectos' + (q ? '?' + new URLSearchParams({ q }) : '') : null })
    }
    if (section !== 'proyectos') {
      const taskParams = section === 'tareas' ? params : { q, limit: q ? 30 : 8, status: q ? 'all' : 'active' }
      showGroup({ container, kind: 'tasks', api, signal, snapshot: snapshots.tasks ??= {},
        label: home ? (q ? 'Tareas' : 'Tareas activas recientes') : '',
        params: taskParams, target: home ? '#tareas' + (q ? '?' + new URLSearchParams({ q, status: 'all' }) : '') : null })
    }
    if (section === 'tareas' && projectId) {
      projectLabel.textContent = 'Proyecto seleccionado'
      void api('/api/projects/' + encodeURIComponent(projectId), { signal }).then((project) => {
        if (!signal.aborted) projectLabel.textContent = project.name
      }).catch(() => {
        if (!signal.aborted) projectLabel.textContent = 'Proyecto no disponible'
      })
    } else projectLabel.textContent = 'Todos los proyectos'
  }

  function updateQuery(delay) {
    const { section } = route(location.hash)
    const params = new URLSearchParams()
    if (query.value.trim()) params.set('q', query.value.trim())
    if (section === 'tareas') {
      if (projectId) params.set('projectId', projectId)
      if (status.value && status.value !== 'active') params.set('status', status.value)
      if (priority.value) params.set('priority', priority.value)
    }
    abortSearch()
    history.replaceState(null, '', '#' + section + (params.size ? '?' + params : ''))
    previousHistoryState = null
    activeHash = location.hash
    if (delay) {
      const loading = node('p', 'Buscando…', 'muted')
      loading.setAttribute('role', 'status')
      $('#discovery-groups').replaceChildren(loading)
      timer = setTimeout(() => showLists(params), delay)
    } else showLists(params)
  }

  function pickProject() {
    clearTimeout(pickerTimer)
    pickerController?.abort()
    pickerController = new AbortController()
    const result = $('#project-picker-results')
    result.replaceChildren()
    showGroup({
      container: result, kind: 'projects', params: { q: pickerInput.value.trim() },
      api, signal: pickerController.signal, snapshot: {},
      select: (project) => selectProjectFilter(project.id),
    })
  }

  function selectProjectFilter(id) {
    projectId = id
    picker.close()
    updateQuery(0)
  }

  async function render({ focus = true, restore = null, resetView = true } = {}) {
    activeHash = location.hash
    const target = route(activeHash)
    const detail = Boolean(target.projectId)
    const signal = abortSearch()
    if (resetView) leaveProject()
    const projectWorkspace = $('#project-workspace')
    const taskDetail = $('#task-detail')
    projectWorkspace.hidden = true
    taskDetail.hidden = true
    $('#discovery').hidden = detail
    $('#detail-links').hidden = !detail
    $('#detail-project').hidden = true
    const feedback = $('#detail-feedback')
    feedback.hidden = true
    $('#workspace-message').hidden = true
    for (const link of document.querySelectorAll('.discovery-nav a')) {
      if (link.hash === '#' + target.section) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    if (!detail) {
      const [title, label] = sections[target.section]
      $('#discovery-title').textContent = title
      $('#discovery-label').textContent = label
      $('#project-entry-actions').hidden = target.section === 'tareas'
      $('#task-filters').hidden = target.section !== 'tareas'
      query.value = target.params.get('q') || ''
      status.value = target.params.get('status') || 'active'
      priority.value = target.params.get('priority') || ''
      projectId = target.params.get('projectId')
      showLists(target.params, { reuse: Boolean(restore) })
      if (focus) (document.getElementById(restore) || $('#discovery-title')).focus()
      return
    }

    const back = $('#detail-back')
    const fallback = target.taskId ? '#tareas' : '#proyectos'
    back.href = history.state?.returnTo || fallback
    const section = route(back.hash).section
    back.textContent = '← Volver a ' + (route(back.hash).projectId ? 'proyecto' : sections[section][0].toLowerCase())
    feedback.hidden = false
    feedback.textContent = 'Cargando detalle…'
    try {
      const path = '/api/projects/' + encodeURIComponent(target.projectId)
      const [project, task] = await Promise.all([
        api(path, { signal }),
        target.taskId && api(path + '/tasks/' + encodeURIComponent(target.taskId), { signal }),
      ])
      if (signal.aborted) return
      feedback.hidden = true
      if (task) {
        const projectLink = $('#detail-project')
        projectLink.href = '#proyectos/' + project.id
        projectLink.textContent = project.name
        projectLink.hidden = back.hash === projectLink.hash
        taskDetail.hidden = false
        $('#task-detail-title').textContent = task.title
        if (focus) $('#task-detail-title').focus()
        await openTask(project, task, signal)
      } else {
        projectWorkspace.hidden = false
        $('#project-all-tasks').href = '#tareas?' + new URLSearchParams({ projectId: project.id })
        const loading = openProject(project, signal, resetView)
        if (focus && !restore) $('#project-name').focus()
        await loading
        if (focus && restore && !signal.aborted) (document.getElementById(restore) || $('#project-name')).focus()
      }
    } catch (error) {
      if (signal.aborted) return
      feedback.hidden = false
      feedback.textContent = error.status === 404 ? 'El proyecto o la tarea ya no está disponible.' : 'No se pudo cargar el detalle.'
      feedback.append(button('Reintentar', () => render()))
      if (focus) back.focus()
    }
  }

  function navigate(hash, source) {
    if (hash === location.hash) return Promise.resolve()
    const returnTo = source ? location.hash || '#inicio' : null
    history.pushState(returnTo ? { returnTo, restore: source } : null, '', hash)
    previousHistoryState = history.state
    return render()
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#"]')
    if (!link || link.target || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    if (link.id === 'detail-back' && history.state?.returnTo === link.hash) history.back()
    else void navigate(link.hash, link.dataset.result && link.id)
  })

  function onHistory() {
    if (activeHash === location.hash) return
    const previous = previousHistoryState
    previousHistoryState = history.state
    void render({ restore: previous?.returnTo === (location.hash || '#inicio') ? previous.restore : null })
  }

  // Direct links can also be opened by typing a fragment or using browser history.
  window.addEventListener('popstate', onHistory)
  window.addEventListener('hashchange', onHistory)
  $('#discovery-search').addEventListener('submit', (event) => { event.preventDefault(); updateQuery(0) })
  query.addEventListener('input', () => updateQuery(250))
  status.addEventListener('change', () => updateQuery(0))
  priority.addEventListener('change', () => updateQuery(0))
  projectLabel.addEventListener('click', () => { pickerInput.value = ''; picker.showModal(); pickProject() })
  pickerInput.addEventListener('input', () => {
    clearTimeout(pickerTimer)
    pickerController?.abort()
    $('#project-picker-results').textContent = 'Buscando…'
    pickerTimer = setTimeout(pickProject, 250)
  })
  pickerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); pickProject() }
  })
  picker.addEventListener('close', () => { clearTimeout(pickerTimer); pickerController?.abort() })
  $('#clear-project-filter').addEventListener('click', () => selectProjectFilter(null))
  return {
    start: () => render({ focus: Boolean(location.hash) }),
    refresh: () => render({ focus: false, resetView: false }),
    updateTask: (task, agentName) => {
      const items = previousList?.snapshots.tasks?.items
      const index = items?.findIndex((row) => row.id === task.id) ?? -1
      if (index < 0) return
      const { section, params } = route(previousList.hash)
      const filter = params.get('status') || (section === 'inicio' && params.get('q') ? 'all' : 'active')
      const matches = filter === 'all' || filter === task.status
        || (filter === 'active' && !['done', 'cancelled'].includes(task.status))
      if (matches) {
        const row = items[index]
        row.status = task.status
        if (agentName !== undefined) row.assignedAgentName = agentName
      } else items.splice(index, 1)
    },
    openProject: (project) => { previousList = undefined; return navigate('#proyectos/' + project.id) },
  }
}
