import type { InteractionGate } from './interaction-gate';
import type { InteractionRequest, QuestionType, InteractionOption } from './types';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
}

export interface McpToolInput {
  question_type: string;
  title: string;
  description: string;
  suggested_answer?: string;
  options?: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
  context?: Record<string, unknown>;
}

export interface McpToolOutput {
  action: string;
  message: string;
  data: Record<string, unknown>;
  responded_by: string;
}

export class McpToolHandler {
  private gate: InteractionGate;

  constructor(deps: { gate: InteractionGate }) {
    this.gate = deps.gate;
  }

  getToolDefinition(): McpToolDefinition {
    return {
      name: 'mars_request_input',
      description:
        'Request input or approval from the human user. ' +
        'Use this when you need clarification, confirmation for a destructive action, ' +
        'or when you are stuck and need guidance. ' +
        'The tool call will block until the user responds.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          question_type: {
            type: 'string' as const,
            enum: [
              'clarification',
              'destructive_action',
              'ambiguity_resolution',
              'permission_request',
              'agent_stuck',
            ],
            description: 'The type of question being asked',
          },
          title: {
            type: 'string' as const,
            description: 'Short title summarizing the question (shown as header)',
          },
          description: {
            type: 'string' as const,
            description: 'Detailed description of what you need from the user (supports markdown)',
          },
          suggested_answer: {
            type: 'string' as const,
            description: 'Your suggested answer or proposed action (optional)',
          },
          options: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                value: { type: 'string' as const, description: 'Option identifier' },
                label: { type: 'string' as const, description: 'Display text' },
                description: { type: 'string' as const, description: 'Option description' },
              },
              required: ['value', 'label'],
            },
            description: 'List of options for the user to choose from (optional)',
          },
          context: {
            type: 'object' as const,
            additionalProperties: true,
            description: 'Additional context data relevant to the question (optional)',
          },
        },
        required: ['question_type', 'title', 'description'],
        additionalProperties: false,
      },
    };
  }

  async handleToolCall(params: {
    input: McpToolInput;
    runId: string;
    taskId?: string;
    agentId?: string;
    sessionId?: string;
  }): Promise<McpToolOutput> {
    const { input, runId, taskId, agentId, sessionId } = params;

    const options: InteractionOption[] | null = input.options
      ? input.options.map((opt, idx) => ({
          value: opt.value,
          label: opt.label,
          description: opt.description ?? null,
          isDefault: idx === 0,
        }))
      : null;

    const request: InteractionRequest = {
      type: input.question_type as QuestionType,
      runId,
      taskId,
      agentId,
      sessionId,
      question: {
        title: input.title,
        description: input.description,
        payload: input.context ?? {},
        suggestedAction: 'answer',
        suggestedMessage: input.suggested_answer ?? null,
        options,
      },
      metadata: {
        source: 'agent',
        priority: input.question_type === 'destructive_action' ? 'critical' : 'high',
      },
    };

    const response = await this.gate.request(request);

    return {
      action: response.action,
      message: response.message ?? 'No message provided',
      data: response.modifiedPayload ?? {},
      responded_by: response.respondedBy,
    };
  }
}
