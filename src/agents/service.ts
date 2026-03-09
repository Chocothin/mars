import type { Agent, CreateAgentInput, UpdateAgentInput, AgentQuery, IAgentService } from '../types/agent';
import { REASONING_LEVELS } from '../types/agent';
import { insertAgent, getAgentById, getAgentByName, updateAgent, deleteAgent, queryAgents } from '../db/agent-repo';
import { getProviderById } from '../db/provider-repo';
import { getMcpServerById } from '../db/mcp-server-repo';
import { getSkillById } from '../db/skill-repo';
import { randomUUID } from 'node:crypto';

export class AgentService implements IAgentService {
  async create(input: CreateAgentInput): Promise<Agent> {
    if (input.reasoningLevel && !REASONING_LEVELS.includes(input.reasoningLevel)) {
      throw new Error(`Invalid reasoning level: ${input.reasoningLevel}`);
    }
    if (input.workerCount !== undefined && (!Number.isInteger(input.workerCount) || input.workerCount < 1)) {
      throw new Error(`Invalid worker count: ${input.workerCount}`);
    }

    const existing = getAgentByName(input.name);
    if (existing) {
      throw new Error(`Agent with name "${input.name}" already exists`);
    }

    const provider = getProviderById(input.providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${input.providerId}`);
    }

    if (input.mcpServerIds && input.mcpServerIds.length > 0) {
      this.validateMcpServerIds(input.mcpServerIds);
    }
    if (input.skillIds && input.skillIds.length > 0) {
      this.validateSkillIds(input.skillIds);
    }

    const now = Date.now();
    const agent: Agent = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? '',
      providerId: input.providerId,
      modelId: input.modelId,
      systemPrompt: input.systemPrompt ?? '',
      reasoningLevel: input.reasoningLevel ?? 'none',
      workerCount: input.workerCount ?? 1,
      mcpServerIds: input.mcpServerIds ?? [],
      skillIds: input.skillIds ?? [],
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    insertAgent(agent);
    return agent;
  }

  async getById(id: string): Promise<Agent | null> {
    return getAgentById(id);
  }

  async update(id: string, input: UpdateAgentInput): Promise<Agent | null> {
    const existing = getAgentById(id);
    if (!existing) {
      return null;
    }

    if (input.name !== undefined && input.name !== existing.name) {
      const byName = getAgentByName(input.name);
      if (byName && byName.id !== id) {
        throw new Error(`Agent with name "${input.name}" already exists`);
      }
    }

    if (input.reasoningLevel && !REASONING_LEVELS.includes(input.reasoningLevel)) {
      throw new Error(`Invalid reasoning level: ${input.reasoningLevel}`);
    }
    if (input.workerCount !== undefined && (!Number.isInteger(input.workerCount) || input.workerCount < 1)) {
      throw new Error(`Invalid worker count: ${input.workerCount}`);
    }

    if (input.providerId !== undefined) {
      const provider = getProviderById(input.providerId);
      if (!provider) {
        throw new Error(`Provider not found: ${input.providerId}`);
      }
    }

    if (input.mcpServerIds !== undefined && input.mcpServerIds.length > 0) {
      this.validateMcpServerIds(input.mcpServerIds);
    }
    if (input.skillIds !== undefined && input.skillIds.length > 0) {
      this.validateSkillIds(input.skillIds);
    }

    const updates: Partial<Agent> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.providerId !== undefined) updates.providerId = input.providerId;
    if (input.modelId !== undefined) updates.modelId = input.modelId;
    if (input.systemPrompt !== undefined) updates.systemPrompt = input.systemPrompt;
    if (input.reasoningLevel !== undefined) updates.reasoningLevel = input.reasoningLevel;
    if (input.workerCount !== undefined) updates.workerCount = input.workerCount;
    if (input.mcpServerIds !== undefined) updates.mcpServerIds = input.mcpServerIds;
    if (input.skillIds !== undefined) updates.skillIds = input.skillIds;
    if (input.enabled !== undefined) updates.enabled = input.enabled;

    const changed = updateAgent(id, updates);
    if (!changed) {
      return existing;
    }

    return getAgentById(id);
  }

  async delete(id: string): Promise<boolean> {
    return deleteAgent(id);
  }

  async list(query: AgentQuery): Promise<Agent[]> {
    return queryAgents(query);
  }

  private validateMcpServerIds(ids: string[]): void {
    for (const mcpId of ids) {
      if (mcpId.startsWith('builtin:')) continue;
      const server = getMcpServerById(mcpId);
      if (!server) {
        throw new Error(`MCP server not found: ${mcpId}`);
      }
    }
  }

  private validateSkillIds(ids: string[]): void {
    for (const skillId of ids) {
      const skill = getSkillById(skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${skillId}`);
      }
    }
  }
}
