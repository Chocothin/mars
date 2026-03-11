import type { Agent } from '../types/agent';
import type { McpServer } from '../types/mcp-server';
import type { Task } from '../types/task';
import type { IMemoryStorage } from '../types/memory';
import type { TaskExecutionOutput, OrchestrationBrief } from '../orchestrator/types';
import type { AgentContext, ToolConfig } from './types';
import type { Message } from '../messaging/types';
import { resolveMcpScope } from '../mcp/resolution';
import { createInternalOrchestratorMcpServer } from '../mcp/internal-orchestrator';

// ─── IContextBuilder: 에이전트 실행 컨텍스트 조립 인터페이스 ───

export interface ContextBuildParams {
  agent: Agent;
  task: Task;
  priorResults?: TaskExecutionOutput[];
  projectDirectory: string;
  orchestrationBrief?: OrchestrationBrief;
  projectId?: string;
  overrideMcpServerIds?: readonly string[];
  unreadMessages?: Message[];
  autonomousMode?: boolean;
}

export interface IContextBuilder {
  build(params: ContextBuildParams): Promise<AgentContext>;
}

// ─── ContextBuilder: 에이전트 실행에 필요한 전체 컨텍스트 조립 ───

export class ContextBuilder implements IContextBuilder {
  private memoryStorage: IMemoryStorage | null;

  constructor(memoryStorage?: IMemoryStorage) {
    this.memoryStorage = memoryStorage ?? null;
  }

  async build(params: ContextBuildParams): Promise<AgentContext> {
    const { agent, task, priorResults, projectDirectory, orchestrationBrief, unreadMessages, autonomousMode } = params;

    const systemPrompt = this.assembleSystemPrompt(agent, task, priorResults, orchestrationBrief, unreadMessages, autonomousMode);
    const resolvedMcp = resolveMcpScope({
      projectId: params.projectId,
      agentId: agent.id,
      overrideMcpServerIds: params.overrideMcpServerIds,
    });
    const projectScopedServers = this.withInternalOrchestratorServer(resolvedMcp.mcpServers, params.projectId);
    const tools = this.collectTools(projectScopedServers);
    const memory = await this.loadMemory(agent);

    return {
      agent,
      task,
      systemPrompt,
      tools,
      memory,
      priorResults: priorResults?.map((r) => r.result) ?? [],
      workingDirectory: projectDirectory,
      orchestrationBrief: orchestrationBrief ?? null,
      mcpServerIds: projectScopedServers.map((server) => server.id),
      mcpServers: projectScopedServers,
    };
  }

  private assembleSystemPrompt(
    agent: Agent,
    task: Task,
    priorResults?: TaskExecutionOutput[],
    brief?: OrchestrationBrief,
    unreadMessages?: Message[],
    autonomousMode?: boolean,
  ): string {
    const sections: string[] = [];

    if (autonomousMode) {
      sections.push(this.formatAutonomousDirective());
    }

    if (agent.systemPrompt) {
      sections.push(agent.systemPrompt);
    }

    if (brief) {
      sections.push(this.formatOrchestrationBrief(brief));
    } else if (priorResults && priorResults.length > 0) {
      sections.push(this.formatPriorResults(priorResults));
    }

    sections.push(this.formatTaskSection(task));

    sections.push(this.formatCollaborationGuide());

    if (unreadMessages && unreadMessages.length > 0) {
      sections.push(this.formatUnreadMessages(unreadMessages));
    }

    return sections.join('\n\n');
  }

  private formatUnreadMessages(messages: Message[]): string {
    const lines = [`## 📬 Unread Messages`, '', `You have ${messages.length} unread message${messages.length === 1 ? '' : 's'}:`];

    for (const msg of messages) {
      const timeAgo = this.formatTimeAgo(msg.createdAt);
      lines.push('', `[FROM: ${msg.from}] (${msg.type}, ${timeAgo})`);
      lines.push(JSON.stringify(msg.payload, null, 2));
    }

    return lines.join('\n');
  }

  private formatTimeAgo(timestamp: number): string {
    const diffMs = Date.now() - timestamp;
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) {
      return `${diffSec}s ago`;
    }

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) {
      return `${diffMin}min ago`;
    }

    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) {
      return `${diffHour}h ago`;
    }

    return new Date(timestamp).toISOString();
  }

  private formatOrchestrationBrief(brief: OrchestrationBrief): string {
    const lines = ['## Orchestration Context'];

    lines.push('', `**Run Goal:** ${brief.runGoal}`);
    lines.push(`**Position:** ${brief.positionInPlan}`);

    if (brief.downstreamHint) {
      lines.push(`**Downstream:** ${brief.downstreamHint}`);
    }

    lines.push('', `**Task Objective:** ${brief.taskObjective}`);

    if (brief.priorResults.length > 0) {
      lines.push('', '### Prior Task Results');
      for (const pr of brief.priorResults) {
        lines.push('', `#### ${pr.taskTitle} (${pr.taskId})`, '', pr.result);
        if (pr.filesModified.length > 0) {
          lines.push('', 'Files modified:', ...pr.filesModified.map((f) => `- ${f}`));
        }
      }
    }

    return lines.join('\n');
  }

  private formatTaskSection(task: Task): string {
    const lines = [`## Task: ${task.title}`];
    if (task.description) { lines.push('', task.description); }
    lines.push('', `Priority: ${task.priority}`);

    if (task.acceptanceCriteria?.length > 0) {
      lines.push('', '## ✅ Acceptance Criteria — ALL must be met');
      task.acceptanceCriteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
      if (task.expectedOutputs?.length > 0) {
        lines.push('', '### Expected Outputs');
        task.expectedOutputs.forEach(o => lines.push(`- ${o}`));
      }
      lines.push('', '## Self-Verification (MANDATORY)');
      lines.push('Before completing this task, you MUST:');
      lines.push('1. Review EACH acceptance criterion above');
      lines.push('2. Verify your output satisfies ALL criteria — not most, ALL');
      lines.push('3. If ANY criterion is not met, continue working');
      lines.push('4. In your final output, confirm each criterion:');
      lines.push('   ✅ Criterion 1: [how met]');
      lines.push('   ✅ Criterion 2: [how met]');
      lines.push('5. Do NOT report completion with unmet criteria');
    }

    if (task.retryCount > 0 && task.reviewFeedback) {
      lines.push('', `## ⚠️ Retry Attempt #${task.retryCount + 1}`);
      lines.push('Previous attempt was reviewed and found insufficient.');
      lines.push('', '### Review Feedback:');
      lines.push(task.reviewFeedback);
      lines.push('', 'Address ALL feedback points. Build on your previous work.');
    }

    return lines.join('\n');
  }

  private formatPriorResults(results: TaskExecutionOutput[]): string {
    const lines = ['## Prior Task Results'];

    for (let i = 0; i < results.length; i++) {
      const entry = results[i]!;
      lines.push('', `### Result ${i + 1}`, '', entry.result);

      if (entry.filesModified.length > 0) {
        lines.push('', 'Files modified:', ...entry.filesModified.map((f) => `- ${f}`));
      }
    }

    return lines.join('\n');
  }

  private collectTools(mcpServers: readonly McpServer[]): ToolConfig[] {
    const tools: ToolConfig[] = [];

    for (const server of mcpServers) {
      tools.push({
        name: server.name,
        source: 'mcp',
        mcpServerId: server.id,
        enabled: true,
      });
    }

    return tools;
  }

  private withInternalOrchestratorServer(mcpServers: readonly McpServer[], projectId?: string): McpServer[] {
    if (!projectId) {
      return [...mcpServers];
    }

    const internalServer = createInternalOrchestratorMcpServer(projectId);
    if (mcpServers.some((server) => server.id === internalServer.id)) {
      return [...mcpServers];
    }

    return [internalServer, ...mcpServers];
  }

  private async loadMemory(agent: Agent): Promise<string> {
    if (!this.memoryStorage) return '';

    const files = await this.memoryStorage.listFiles({
      tier: 'agent',
      scope: agent.id,
    });

     if (files.length === 0) return '';

     const sections = files.map((f) => `### ${f.filename}\n${f.content}`);
     return `## Agent Memory\n\n${sections.join('\n\n')}`;
   }

   private formatAutonomousDirective(): string {
     return [
       '## 🚨 자율 실행 모드 (Autonomous Mode)',
       '',
       '이 태스크는 자율 실행 모드로 실행됩니다. 다음 규칙을 반드시 따르세요:',
       '',
       '1. **질문 금지**: 사용자에게 선택지를 묻거나 확인을 요청하지 마세요. 스스로 최선의 판단을 내리세요.',
       '2. **즉시 구현**: 설계 확인, 방향 제안, 승인 요청 없이 바로 코드를 작성하세요.',
       '3. **완전한 산출물**: 실행 가능한 코드 파일을 실제로 생성/수정해야 합니다. 설명만 하는 것은 허용되지 않습니다.',
       '4. **Acceptance Criteria 충족**: 모든 완료 기준을 만족할 때까지 작업을 계속하세요.',
       '5. **빌드 확인**: 가능하면 빌드/타입체크를 실행하여 에러가 없는지 확인하세요.',
       '',
       '❌ 하지 마세요: "어떤 방식을 원하시나요?", "다음 중 선택해주세요", "확인이 필요합니다"',
       '✅ 해야 하는 것: 바로 파일을 생성하고, 코드를 작성하고, 결과를 검증하세요.',
       '',
       '## ⛔ 스킬/플러그인 제한',
       '',
       '`superpowers`, `brainstorming`, `writing-plans`, `receiving-code-review`, `requesting-code-review` 등 외부 스킬/플러그인을 호출하지 마세요.',
       '스킬 invoke, 스킬 로드, 스킬 체크 절차를 일체 건너뛰세요.',
       '코드 작성에만 집중하세요.',
     ].join('\n');
   }

   private formatCollaborationGuide(): string {
     return '';
   }
}
