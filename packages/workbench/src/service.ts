import type {
  CatalogPage,
  CreateTaskInput,
  Decision,
  DecisionCatalogItem,
  Execution,
  Memory,
  MemoryCatalogItem,
  Project,
  RegisterProjectInput,
  RememberInput,
  SaveDecisionInput,
  SemanticSearchResult,
  Task,
  TaskStatus,
  TextSearchInput,
} from 'forge-semantic-bridge/workbench'

export interface WorkbenchGateway {
  assertReady(): Promise<{ serverVersion: string; schemaVersion: string; vectorVersion: string | null }>
  listProjects(input?: { limit?: number }): Promise<CatalogPage<Project>>
  listMemories(input: { projectId: string; limit?: number }): Promise<CatalogPage<MemoryCatalogItem>>
  listDecisions(input: { projectId: string; limit?: number }): Promise<CatalogPage<DecisionCatalogItem>>
  listTasks(input: { projectId: string; limit?: number }): Promise<CatalogPage<Task>>
  listExecutions(input: { projectId: string; limit?: number }): Promise<CatalogPage<Execution>>
  registerProject(input: RegisterProjectInput): Promise<Project>
  remember(input: RememberInput): Promise<Memory>
  saveDecision(input: SaveDecisionInput): Promise<Decision>
  createTask(input: CreateTaskInput): Promise<Task>
  updateTaskStatus(input: { projectId: string; taskId: string; expectedVersion: number; status: TaskStatus }): Promise<Task>
}

export interface TextSearchPort {
  search(input: TextSearchInput): Promise<SemanticSearchResult[]>
}

export class ForgeWorkbenchService {
  constructor(
    private readonly gateway: WorkbenchGateway,
    private readonly searchPort: TextSearchPort,
  ) {}

  status() {
    return this.gateway.assertReady()
  }

  async projects(): Promise<Project[]> {
    return (await this.gateway.listProjects({ limit: 100 })).items
  }

  async catalog(projectId: string): Promise<{
    memories: MemoryCatalogItem[]
    decisions: DecisionCatalogItem[]
    tasks: Task[]
    executions: Execution[]
  }> {
    const [memories, decisions, tasks, executions] = await Promise.all([
      this.gateway.listMemories({ projectId, limit: 50 }),
      this.gateway.listDecisions({ projectId, limit: 50 }),
      this.gateway.listTasks({ projectId, limit: 50 }),
      this.gateway.listExecutions({ projectId, limit: 50 }),
    ])
    return { memories: memories.items, decisions: decisions.items, tasks: tasks.items, executions: executions.items }
  }

  registerProject(input: RegisterProjectInput) {
    return this.gateway.registerProject(input)
  }

  remember(input: RememberInput) {
    return this.gateway.remember(input)
  }

  saveDecision(input: SaveDecisionInput) {
    return this.gateway.saveDecision(input)
  }

  createTask(input: CreateTaskInput) {
    return this.gateway.createTask(input)
  }

  updateTaskStatus(input: { projectId: string; taskId: string; expectedVersion: number; status: TaskStatus }) {
    return this.gateway.updateTaskStatus(input)
  }

  search(input: TextSearchInput) {
    return this.searchPort.search(input)
  }
}
