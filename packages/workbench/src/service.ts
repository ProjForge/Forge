import type {
  CatalogPage,
  Decision,
  DecisionCatalogItem,
  Memory,
  MemoryCatalogItem,
  Project,
  RegisterProjectInput,
  RememberInput,
  SaveDecisionInput,
  SemanticSearchResult,
  TextSearchInput,
} from 'forge-semantic-bridge/workbench'

export interface WorkbenchGateway {
  assertReady(): Promise<{ serverVersion: string; schemaVersion: string; vectorVersion: string | null }>
  listProjects(input?: { limit?: number }): Promise<CatalogPage<Project>>
  listMemories(input: { projectId: string; limit?: number }): Promise<CatalogPage<MemoryCatalogItem>>
  listDecisions(input: { projectId: string; limit?: number }): Promise<CatalogPage<DecisionCatalogItem>>
  registerProject(input: RegisterProjectInput): Promise<Project>
  remember(input: RememberInput): Promise<Memory>
  saveDecision(input: SaveDecisionInput): Promise<Decision>
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
  }> {
    const [memories, decisions] = await Promise.all([
      this.gateway.listMemories({ projectId, limit: 50 }),
      this.gateway.listDecisions({ projectId, limit: 50 }),
    ])
    return { memories: memories.items, decisions: decisions.items }
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

  search(input: TextSearchInput) {
    return this.searchPort.search(input)
  }
}
