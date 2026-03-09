import { join } from 'node:path';
import { getDb } from '../db/index';
import { eventBus } from '../events/bus';
import { ContextBuilder } from '../execution/context-builder';
import { ClaudeCliExecutor } from '../providers/claude-cli';
import { AgentService } from '../agents/service';
import { TaskService } from '../tasks/service';
import { InteractionStore } from '../hitl/interaction-store';
import { InteractionGate } from '../hitl/interaction-gate';
import { DEFAULT_APPROVAL_CONFIG } from '../hitl/simple-config';
import { TaskDecomposer } from './decomposer';
import { MessageService } from '../messaging/service';
import { SummarizerService, SummaryListener } from '../summarizer';
import { OrchestratorEngine } from './engine';
import { ResultReviewer } from './reviewer';
import { AgentPool } from './agent-pool';
import { ReactiveScheduler } from './reactive-scheduler';
import { OrchestratorRegistry } from './orchestrator-registry';
import { getDefaultProvider } from '../db/provider-repo';

// ─── Shared orchestrator instances (lazy singleton) ─────────────────────────

let engineInstance: OrchestratorEngine | null = null;
let decomposerInstance: TaskDecomposer | null = null;
let messageServiceInstance: MessageService | null = null;
let interactionStoreInstance: InteractionStore | null = null;
let interactionGateInstance: InteractionGate | null = null;
let summaryListenerInstance: SummaryListener | null = null;
let orchestratorRegistryInstance: OrchestratorRegistry | null = null;

function ensureInitialized(): void {
  if (engineInstance) return;

  const cliExecutor = new ClaudeCliExecutor();
  const contextBuilder = new ContextBuilder();

  const agentService = new AgentService();
  const taskService = new TaskService();

  const dataDir = join(process.env.HOME ?? '.', '.mars', 'data', 'interactions');
  interactionStoreInstance = new InteractionStore({ db: getDb(), dataDir });
  interactionGateInstance = new InteractionGate({ store: interactionStoreInstance, config: DEFAULT_APPROVAL_CONFIG });

  const pool = new AgentPool();
  const scheduler = new ReactiveScheduler();
  decomposerInstance = new TaskDecomposer({ cliExecutor, taskService, agentService });
  messageServiceInstance = new MessageService();

  const summarizerService = new SummarizerService();
  summaryListenerInstance = new SummaryListener(eventBus, summarizerService);

  const defaultProvider = getDefaultProvider();
  const reviewer = new ResultReviewer({
    cliExecutor,
    reviewerProviderId: defaultProvider?.id ?? undefined,
  });

  engineInstance = new OrchestratorEngine({
    pool,
    scheduler,
    contextBuilder,
    interactionGate: interactionGateInstance,
    agentService,
    taskService,
    cliExecutor,
    messageService: messageServiceInstance,
    reviewer,
    decomposer: decomposerInstance,
  });

  orchestratorRegistryInstance = new OrchestratorRegistry({
    cliExecutor,
    agentService,
  });

  if (!process.env.MARS_MCP_MODE) {
    engineInstance.recoverZombieRuns();
  }
}

export function getEngine(): OrchestratorEngine {
  ensureInitialized();
  return engineInstance!;
}

export function getDecomposer(): TaskDecomposer {
  ensureInitialized();
  return decomposerInstance!;
}

export function getMessageService(): MessageService {
  ensureInitialized();
  return messageServiceInstance!;
}

export function getInteractionStore(): InteractionStore {
  ensureInitialized();
  return interactionStoreInstance!;
}

export function getInteractionGate(): InteractionGate {
  ensureInitialized();
  return interactionGateInstance!;
}

export function getOrchestratorRegistry(): OrchestratorRegistry {
  ensureInitialized();
  return orchestratorRegistryInstance!;
}

export function getAgentPool(): import('./agent-pool').AgentPool {
  ensureInitialized();
  return engineInstance!.getAgentPool();
}
