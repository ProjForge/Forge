import type {
  CatalogPage,
  Agent,
  ContinuationPackage,
  ContinuationPackageCatalogItem,
  CompileContinuationInput,
  CreateTaskInput,
  Decision,
  DecisionCatalogItem,
  Execution,
  ExecutionStatus,
  Memory,
  MemoryCatalogItem,
  Project,
  ProjectAgentAssignment,
  ProjectAgentCatalogItem,
  RegisterAgentInput,
  RegisterProjectInput,
  RememberInput,
  SaveDecisionInput,
  SemanticSearchResult,
  StartExecutionInput,
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
  listProjectAgents(input: { projectId: string; limit?: number; status?: 'active' | 'inactive' }): Promise<CatalogPage<ProjectAgentCatalogItem>>
  listContinuationPackages(input: { projectId: string; limit?: number }): Promise<CatalogPage<ContinuationPackageCatalogItem>>
  registerProject(input: RegisterProjectInput): Promise<Project>
  registerAgent(input: RegisterAgentInput): Promise<Agent>
  assignAgent(projectId: string, agentId: string, assignmentRole?: string): Promise<ProjectAgentAssignment>
  remember(input: RememberInput): Promise<Memory>
  saveDecision(input: SaveDecisionInput): Promise<Decision>
  createTask(input: CreateTaskInput): Promise<Task>
  updateTaskStatus(input: { projectId: string; taskId: string; expectedVersion: number; status: TaskStatus }): Promise<Task>
  updateTaskAssignment(input: { projectId: string; taskId: string; expectedVersion: number; assignedAgentId: string | null }): Promise<Task>
  loadContinuationContext(projectId: string, packageId: string): Promise<ContinuationPackage>
  startExecution(input: StartExecutionInput): Promise<Execution>
  compileContinuationContext(input: CompileContinuationInput): Promise<ContinuationPackage>
  finishExecution(input: { projectId: string; executionId: string; agentId: string; expectedVersion: number; status: Extract<ExecutionStatus, 'succeeded' | 'failed' | 'cancelled'> }): Promise<Execution>
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
    agents: ProjectAgentCatalogItem[]
    contextPackages: ContinuationPackageCatalogItem[]
  }> {
    const [memories, decisions, tasks, executions, agents, contextPackages] = await Promise.all([
      this.gateway.listMemories({ projectId, limit: 50 }),
      this.gateway.listDecisions({ projectId, limit: 50 }),
      this.gateway.listTasks({ projectId, limit: 50 }),
      this.gateway.listExecutions({ projectId, limit: 50 }),
      this.gateway.listProjectAgents({ projectId, status: 'active', limit: 50 }),
      this.gateway.listContinuationPackages({ projectId, limit: 50 }),
    ])
    return {
      memories: memories.items,
      decisions: decisions.items,
      tasks: tasks.items,
      executions: executions.items,
      agents: agents.items,
      contextPackages: contextPackages.items,
    }
  }

  registerProject(input: RegisterProjectInput) {
    return this.gateway.registerProject(input)
  }

  async registerAndAssignAgent(input: RegisterAgentInput & { projectId: string; assignmentRole?: string }) {
    const agent = await this.gateway.registerAgent(input)
    const assignment = await this.gateway.assignAgent(input.projectId, agent.id, input.assignmentRole)
    return { agent, assignment }
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

  updateTaskAssignment(input: { projectId: string; taskId: string; expectedVersion: number; assignedAgentId: string | null }) {
    return this.gateway.updateTaskAssignment(input)
  }

  continuation(projectId: string, packageId: string) {
    return this.gateway.loadContinuationContext(projectId, packageId)
  }

  startExecution(input: StartExecutionInput) {
    return this.gateway.startExecution(input)
  }

  compileContinuation(input: CompileContinuationInput) {
    return this.gateway.compileContinuationContext(input)
  }

  finishExecution(input: { projectId: string; executionId: string; agentId: string; expectedVersion: number; status: Extract<ExecutionStatus, 'succeeded' | 'failed' | 'cancelled'> }) {
    return this.gateway.finishExecution(input)
  }

  search(input: TextSearchInput) {
    return this.searchPort.search(input)
  }
}
