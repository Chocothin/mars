import { join } from 'node:path';
import { getDb } from '../db/index';
import { eventBus } from '../events/bus';
import { SessionManager } from '../execution/session-manager';
import { ContextBuilder } from '../execution/context-builder';
import { AgentRunner } from '../execution/agent-runner';
import { ClaudeCliExecutor } from '../providers/claude-cli';
import { AgentService } from '../agents/service';
import { TaskService } from '../tasks/service';
import { InteractionStore } from '../hitl/interaction-store';
import { InteractionGate } from '../hitl/interaction-gate';
import { DEFAULT_APPROVAL_CONFIG } from '../hitl/simple-config';
import { TaskScheduler } from './scheduler';
import { TaskDecomposer } from './decomposer';
import { ClaimManager } from './claim';
import { HeartbeatManager } from './heartbeat';
import { MessageService } from '../messaging/service';
import { SummarizerService, SummaryListener } from '../summarizer';
import { OrchestratorEngine } from './engine';
import { ResultReviewer } from './reviewer';
import { getDefaultProvider } from '../db/provider-repo';

// ─── Shared orchestrator instances (lazy singleton) ─────────────────────────

let engineInstance: OrchestratorEngine | null = null;
let decomposerInstance: TaskDecomposer | null = null;
let claimManagerInstance: ClaimManager | null = null;
let heartbeatManagerInstance: HeartbeatManager | null = null;
let messageServiceInstance: MessageService | null = null;
let interactionStoreInstance: InteractionStore | null = null;
let interactionGateInstance: InteractionGate | null = null;
let summaryListenerInstance: SummaryListener | null = null;

function ensureInitialized(): void {
  if (engineInstance) return;

  const sessionManager = new SessionManager();
  const cliExecutor = new ClaudeCliExecutor();
  const contextBuilder = new ContextBuilder();
  const agentRunner = new AgentRunner(sessionManager, cliExecutor);

  const agentService = new AgentService();
  const taskService = new TaskService();

  const dataDir = join(process.env.HOME ?? '.', '.mars', 'data', 'interactions');
  interactionStoreInstance = new InteractionStore({ db: getDb(), dataDir });
  interactionGateInstance = new InteractionGate({ store: interactionStoreInstance, config: DEFAULT_APPROVAL_CONFIG });

  const scheduler = new TaskScheduler();
  decomposerInstance = new TaskDecomposer({ agentRunner, taskService, agentService });
  claimManagerInstance = new ClaimManager();
  heartbeatManagerInstance = new HeartbeatManager();
  messageServiceInstance = new MessageService();

  const summarizerService = new SummarizerService();
  summaryListenerInstance = new SummaryListener(eventBus, summarizerService);

  const defaultProvider = getDefaultProvider();
  const reviewer = new ResultReviewer({
    interactionGate: interactionGateInstance,
    cliExecutor,
    reviewerProviderId: defaultProvider?.id ?? undefined,
  });

  engineInstance = new OrchestratorEngine({
    decomposer: decomposerInstance,
    scheduler,
    runner: agentRunner,
    contextBuilder,
    interactionGate: interactionGateInstance,
    agentService,
    taskService,
    claimManager: claimManagerInstance,
    heartbeatManager: heartbeatManagerInstance,
    messageService: messageServiceInstance,
    reviewer,
  });

  setInterval(() => sessionManager.cleanupStale(60000), 60000);

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

export function getClaimManager(): ClaimManager {
  ensureInitialized();
  return claimManagerInstance!;
}

export function getHeartbeatManager(): HeartbeatManager {
  ensureInitialized();
  return heartbeatManagerInstance!;
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
