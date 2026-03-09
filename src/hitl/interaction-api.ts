import type { InteractionStore } from './interaction-store';
import type { InteractionGate } from './interaction-gate';
import type { InteractionResponse, InteractionStatus, ResponseAction } from './types';
import type { ApiResponse } from '../types/common';

const VALID_RESPONSE_ACTIONS: ResponseAction[] = [
  'approve', 'reject', 'modify', 'answer', 'skip', 'cancel',
];

const VALID_STATUSES: InteractionStatus[] = [
  'pending', 'responded', 'timeout', 'cancelled',
];

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

export class InteractionAPI {
  private store: InteractionStore;
  private gate: InteractionGate;

  constructor(deps: { store: InteractionStore; gate: InteractionGate }) {
    this.store = deps.store;
    this.gate = deps.gate;
  }

  async handleList(url: URL): Promise<Response> {
    const runId = url.searchParams.get('runId');
    const statusFilter = url.searchParams.get('status');
    if (statusFilter && !(VALID_STATUSES as string[]).includes(statusFilter)) {
      return errorResponse(`Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}`, 400);
    }

    const interactions = runId
      ? await this.store.getByRunId(runId)
      : await this.store.list(statusFilter as InteractionStatus | undefined);

    const filteredInteractions = runId && statusFilter
      ? interactions.filter((interaction) => interaction.status === statusFilter)
      : interactions;

    return Response.json({
      success: true,
      data: filteredInteractions,
    } satisfies ApiResponse);
  }

  async handleGet(interactionId: string): Promise<Response> {
    const interaction = await this.store.getById(interactionId);
    if (!interaction) {
      return errorResponse('Interaction not found', 404);
    }

    return Response.json({
      success: true,
      data: interaction,
    } satisfies ApiResponse);
  }

  async handleRespond(interactionId: string, req: Request): Promise<Response> {
    const interaction = await this.store.getById(interactionId);
    if (!interaction) {
      return errorResponse('Interaction not found', 404);
    }

    if (interaction.status !== 'pending') {
      return errorResponse(`Interaction is not pending (current status: ${interaction.status})`, 409);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const input = body as Record<string, unknown>;

    if (!input.action || typeof input.action !== 'string') {
      return errorResponse('action is required and must be a string', 400);
    }
    if (!(VALID_RESPONSE_ACTIONS as string[]).includes(input.action)) {
      return errorResponse(`action must be one of: ${VALID_RESPONSE_ACTIONS.join(', ')}`, 400);
    }
    if (input.message !== undefined && input.message !== null && typeof input.message !== 'string') {
      return errorResponse('message must be a string or null', 400);
    }
    if (input.modifiedPayload !== undefined && input.modifiedPayload !== null &&
        (typeof input.modifiedPayload !== 'object' || Array.isArray(input.modifiedPayload))) {
      return errorResponse('modifiedPayload must be an object or null', 400);
    }

    const response: InteractionResponse = {
      action: input.action as ResponseAction,
      message: (input.message as string | null) ?? null,
      modifiedPayload: (input.modifiedPayload as Record<string, unknown> | null) ?? null,
      respondedBy: 'human',
    };

    try {
      await this.gate.respond(interactionId, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to respond';
      return errorResponse(message, 400);
    }

    const updated = await this.store.getById(interactionId);

    return Response.json({
      success: true,
      data: updated,
    } satisfies ApiResponse);
  }


}
