import { streamText, tool } from 'ai';
import type { ToolSet } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { LLMProvider, ProviderRequest, ProviderEvent } from './types';
import { getProviderById } from '../../db/provider-repo';
import { getMessagesBySession } from '../../db/terminal-repo';
import { convertToModelMessages } from './message-converter';
import type { ReasoningLevel } from '../../types/agent';
import type { InteractionGate } from '../../hitl/interaction-gate';
import { McpToolHandler } from '../../hitl/mcp-tool-handler';
import { mcpConnectionPool } from '../../mcp/pool';
import { getMcpServerById } from '../../db/mcp-server-repo';

const REASONING_BUDGET: Record<ReasoningLevel, number | null> = {
  none: null,
  low: 1024,
  medium: 4096,
  high: 10000,
  max: 32000,
};

function resolveThinkingConfig(
  model: string | undefined,
  reasoningLevel: ReasoningLevel | undefined,
): { type: 'enabled'; budgetTokens: number } | { type: 'disabled' } | undefined {
  if (!reasoningLevel || reasoningLevel === 'none') return undefined;

  const budget = REASONING_BUDGET[reasoningLevel];
  if (budget === null) return undefined;

  const supportsThinking = model?.includes('opus') || model?.includes('sonnet');
  if (!supportsThinking) return undefined;

  return { type: 'enabled', budgetTokens: budget };
}

export interface HitlDeps {
  interactionGate: InteractionGate;
  runContext: { runId: string; taskId?: string; agentId?: string; sessionId?: string };
}

export class AnthropicApiProvider implements LLMProvider {
  readonly id: string;
  readonly name: string = 'Anthropic API';
  private abortControllers: Map<string, AbortController> = new Map();
  private reasoningLevel: ReasoningLevel | undefined;
  private hitlDeps: HitlDeps | undefined;
  private mcpToolHandler: McpToolHandler | undefined;

  constructor(providerId: string, hitlDeps?: HitlDeps) {
    this.id = providerId;
    this.hitlDeps = hitlDeps;
    if (hitlDeps) {
      this.mcpToolHandler = new McpToolHandler({ gate: hitlDeps.interactionGate });
    }
  }

  setReasoningLevel(level: ReasoningLevel): void {
    this.reasoningLevel = level;
  }

  async *sendMessage(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const provider = getProviderById(this.id);
    if (!provider) {
      yield { type: 'error', message: 'Provider not found' };
      return;
    }

    if (!provider.apiKey) {
      yield { type: 'error', message: 'API key not configured for provider' };
      return;
    }

    const anthropic = createAnthropic({
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl ?? undefined,
    });

    const model = request.model ?? provider.config.defaultModel ?? 'claude-sonnet-4-20250514';
    const thinkingConfig = resolveThinkingConfig(model, this.reasoningLevel);

    const previousMessages = getMessagesBySession({
      sessionId: request.sessionId,
      limit: 100,
    });
    const historyMessages = convertToModelMessages(previousMessages);
    historyMessages.push({ role: 'user', content: request.message });

    const abortController = new AbortController();
    this.abortControllers.set(request.sessionId, abortController);

    const startTime = Date.now();

    try {
      const allTools = await this.resolveTools(request);

      const result = streamText({
        model: anthropic(model),
        system: request.systemContext ?? undefined,
        messages: historyMessages,
        abortSignal: abortController.signal,
        providerOptions: thinkingConfig
          ? { anthropic: { thinking: thinkingConfig } }
          : undefined,
        onStepFinish: () => {},
        ...(allTools ? { tools: allTools, maxSteps: 25 } : {}),
      });

      for await (const part of result.fullStream) {
        if (abortController.signal.aborted) break;

        switch (part.type) {
          case 'text-delta':
            yield { type: 'text_delta', content: part.text };
            break;
          case 'reasoning-delta':
            yield { type: 'thinking_delta', content: part.text };
            break;
          case 'tool-input-start':
            yield {
              type: 'tool_use_start',
              toolName: part.toolName,
              toolId: part.id,
            };
            break;
          case 'tool-input-delta':
            yield {
              type: 'tool_use_delta',
              toolId: part.id,
              content: part.delta,
            };
            break;
          case 'tool-result': {
            const output = typeof part.output === 'string'
              ? part.output
              : JSON.stringify(part.output);
            yield {
              type: 'tool_result',
              toolId: part.toolCallId,
              output,
            };
            break;
          }
          case 'error':
            yield { type: 'error', message: String(part.error) };
            break;
          case 'finish':
            break;
          default:
            break;
        }
      }

      const usage = await result.usage;
      const finishReason = await result.finishReason;
      const durationMs = Date.now() - startTime;

      yield {
        type: 'complete',
        metadata: {
          durationMs,
          sessionId: request.sessionId,
          isError: finishReason === 'error',
          numTurns: 1,
        },
      };
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        yield { type: 'complete', metadata: { durationMs: Date.now() - startTime, isError: false } };
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message };
      yield { type: 'complete', metadata: { durationMs: Date.now() - startTime, isError: true } };
    } finally {
      this.abortControllers.delete(request.sessionId);
    }
  }

  abort(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
  }

  async isAvailable(): Promise<boolean> {
    const provider = getProviderById(this.id);
    return provider !== null && provider.apiKey !== null;
  }

  private async resolveTools(request: ProviderRequest): Promise<ToolSet | undefined> {
    const hitlTools = this.buildHitlTools(request.sessionId);
    const mcpTools = await this.resolveMcpTools(request.mcpServerIds);

    if (!hitlTools && !mcpTools) return undefined;

    return {
      ...(mcpTools ?? {}),
      ...(hitlTools ?? {}),
    };
  }

  private async resolveMcpTools(serverIds?: string[]): Promise<ToolSet | undefined> {
    if (!serverIds || serverIds.length === 0) return undefined;

    const servers = serverIds
      .map((id) => getMcpServerById(id))
      .filter((s): s is NonNullable<typeof s> => s !== null && s.enabled);

    if (servers.length === 0) return undefined;

    try {
      const tools = await mcpConnectionPool.getTools(servers);
      return Object.keys(tools).length > 0 ? tools : undefined;
    } catch {
      return undefined;
    }
  }

  private buildHitlTools(sessionId: string) {
    if (!this.hitlDeps || !this.mcpToolHandler) return undefined;

    const handler = this.mcpToolHandler;
    const ctx = this.hitlDeps.runContext;

    return {
      mars_request_input: tool({
        description:
          'Request input or approval from the human user. ' +
          'Use this when you need clarification, confirmation for a destructive action, ' +
          'or when you are stuck and need guidance. ' +
          'The tool call will block until the user responds.',
        inputSchema: z.object({
          question_type: z.enum([
            'clarification',
            'destructive_action',
            'ambiguity_resolution',
            'permission_request',
            'agent_stuck',
          ]),
          title: z.string(),
          description: z.string(),
          suggested_answer: z.string().optional(),
          options: z.array(z.object({
            value: z.string(),
            label: z.string(),
            description: z.string().optional(),
          })).optional(),
          context: z.record(z.string(), z.unknown()).optional(),
        }),
        execute: async (input) => {
          const result = await handler.handleToolCall({
            input,
            runId: ctx.runId,
            taskId: ctx.taskId ?? '',
            agentId: ctx.agentId ?? '',
            sessionId: ctx.sessionId ?? sessionId,
          });
          return JSON.stringify(result);
        },
      }),
    };
  }
}
