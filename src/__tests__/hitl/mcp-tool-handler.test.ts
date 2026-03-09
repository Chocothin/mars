import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { initDatabase, getDb } from '../../db/index';
import { McpToolHandler } from '../../hitl/mcp-tool-handler';
import type { McpToolInput, McpToolOutput } from '../../hitl/mcp-tool-handler';
import { InteractionStore } from '../../hitl/interaction-store';
import { InteractionGate } from '../../hitl/interaction-gate';
import { DEFAULT_APPROVAL_CONFIG } from '../../hitl/simple-config';

let store: InteractionStore;
let gate: InteractionGate;
let handler: McpToolHandler;

beforeAll(async () => {
  process.env.MARS_DB_PATH = ':memory:';
  initDatabase();
  store = new InteractionStore({ db: getDb(), dataDir: '/tmp/mars-test-hitl' });
  await store.initialize();
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM interactions');
  gate = new InteractionGate({ store, config: DEFAULT_APPROVAL_CONFIG });
  handler = new McpToolHandler({ gate });
});

afterEach(() => {
  gate.dispose();
});

describe('McpToolHandler', () => {
  describe('getToolDefinition', () => {
    it('returns correct tool name', () => {
      const def = handler.getToolDefinition();
      expect(def.name).toBe('mars_request_input');
    });

    it('includes required fields in schema', () => {
      const def = handler.getToolDefinition();
      expect(def.inputSchema.required).toContain('question_type');
      expect(def.inputSchema.required).toContain('title');
      expect(def.inputSchema.required).toContain('description');
    });

    it('schema has additionalProperties false', () => {
      const def = handler.getToolDefinition();
      expect(def.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('handleToolCall', () => {
    it('with clarification type returns system auto-response (Level 2)', async () => {
      const input: McpToolInput = {
        question_type: 'clarification',
        title: 'Need clarification',
        description: 'What format should the output be?',
      };

      const result = await handler.handleToolCall({ input, runId: 'run-clarify-1' });

      expect(result.action).toBe('answer');
      expect(result.responded_by).toBe('system');
      expect(result.data).toEqual({});
    });

    it('with destructive_action blocks until responded (Level 3)', async () => {
      const input: McpToolInput = {
        question_type: 'destructive_action',
        title: 'Delete database',
        description: 'About to drop all tables',
      };

      const resultPromise = handler.handleToolCall({ input, runId: 'run-destruct-1' });

      await new Promise(r => setTimeout(r, 50));

      const pendingIds = gate.getPendingIds();
      expect(pendingIds).toHaveLength(1);
      const interactionId = pendingIds[0]!;

      await gate.respond(interactionId, {
        action: 'approve',
        message: 'Go ahead',
        modifiedPayload: null,
        respondedBy: 'human',
      });

      const result = await resultPromise;
      expect(result.action).toBe('approve');
      expect(result.message).toBe('Go ahead');
      expect(result.responded_by).toBe('human');
    });

    it('maps options correctly with isDefault on first option', async () => {
      const input: McpToolInput = {
        question_type: 'clarification',
        title: 'Pick format',
        description: 'Choose output format',
        options: [
          { value: 'json', label: 'JSON' },
          { value: 'csv', label: 'CSV', description: 'Comma separated' },
          { value: 'xml', label: 'XML' },
        ],
      };

      await handler.handleToolCall({ input, runId: 'run-options-1' });

      const interactions = await store.getByRunId('run-options-1');
      expect(interactions).toHaveLength(1);
      const interaction = interactions[0]!;
      expect(interaction.question.options).toHaveLength(3);

      const firstOption = interaction.question.options![0]!;
      expect(firstOption.value).toBe('json');
      expect(firstOption.label).toBe('JSON');
      expect(firstOption.isDefault).toBe(true);
      expect(firstOption.description).toBeNull();

      const secondOption = interaction.question.options![1]!;
      expect(secondOption.value).toBe('csv');
      expect(secondOption.label).toBe('CSV');
      expect(secondOption.isDefault).toBe(false);
      expect(secondOption.description).toBe('Comma separated');

      const thirdOption = interaction.question.options![2]!;
      expect(thirdOption.isDefault).toBe(false);
    });

    it('sets priority to critical for destructive_action', async () => {
      const input: McpToolInput = {
        question_type: 'destructive_action',
        title: 'Drop table',
        description: 'Dropping users table',
      };

      const resultPromise = handler.handleToolCall({ input, runId: 'run-priority-critical' });

      await new Promise(r => setTimeout(r, 50));

      const pendingIds = gate.getPendingIds();
      const interactionId = pendingIds[0]!;

      await gate.respond(interactionId, {
        action: 'approve',
        message: 'OK',
        modifiedPayload: null,
        respondedBy: 'human',
      });

      await resultPromise;

      const interactions = await store.getByRunId('run-priority-critical');
      const interaction = interactions[0]!;
      expect(interaction.metadata.priority).toBe('critical');
    });

    it('sets priority to high for non-destructive types', async () => {
      const input: McpToolInput = {
        question_type: 'clarification',
        title: 'Quick question',
        description: 'Is this correct?',
      };

      await handler.handleToolCall({ input, runId: 'run-priority-high' });

      const interactions = await store.getByRunId('run-priority-high');
      const interaction = interactions[0]!;
      expect(interaction.metadata.priority).toBe('high');
    });

    it('with no options sets options to null', async () => {
      const input: McpToolInput = {
        question_type: 'clarification',
        title: 'No options question',
        description: 'Just a plain question',
      };

      await handler.handleToolCall({ input, runId: 'run-no-options' });

      const interactions = await store.getByRunId('run-no-options');
      const interaction = interactions[0]!;
      expect(interaction.question.options).toBeNull();
    });

    it('with no suggested_answer sets suggestedMessage to null', async () => {
      const input: McpToolInput = {
        question_type: 'clarification',
        title: 'No suggestion',
        description: 'No suggested answer provided',
      };

      await handler.handleToolCall({ input, runId: 'run-no-suggestion' });

      const interactions = await store.getByRunId('run-no-suggestion');
      const interaction = interactions[0]!;
      expect(interaction.question.suggestedMessage).toBeNull();
    });

    it('passes context as payload', async () => {
      const input: McpToolInput = {
        question_type: 'clarification',
        title: 'With context',
        description: 'Has context data',
        context: { foo: 'bar' },
      };

      await handler.handleToolCall({ input, runId: 'run-context' });

      const interactions = await store.getByRunId('run-context');
      const interaction = interactions[0]!;
      expect(interaction.question.payload).toEqual({ foo: 'bar' });
    });

    it('with empty context defaults to empty object payload', async () => {
      const input: McpToolInput = {
        question_type: 'clarification',
        title: 'No context',
        description: 'No context provided',
      };

      await handler.handleToolCall({ input, runId: 'run-no-context' });

      const interactions = await store.getByRunId('run-no-context');
      const interaction = interactions[0]!;
      expect(interaction.question.payload).toEqual({});
    });
  });
});
