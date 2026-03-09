import { createHash } from 'node:crypto';
import { getAgentById } from '../db/agent-repo';
import { getProjectById } from '../db/project-repo';
import { getProviderById } from '../db/provider-repo';
import { resolveMcpScope } from '../mcp/resolution';
import type { Provider, ProviderConfig, ProviderType } from '../types/provider';
import type { TerminalSession } from '../types/terminal';
import { writeMcpConfig, buildCodexMcpFlags } from './provider/mcp-config-writer';

const TERMINAL_LAUNCH_POLICY_VERSION = 2;

export interface TerminalRuntimeSpec {
  fingerprint: string;
  projectId: string;
  agentId: string;
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  authMethod: Provider['authMethod'];
  workingDirectory: string;
  modelId: string;
  mergedMcpServerIds: string[];
  mcpConfigPath?: string;
  cliPath: string | null;
  useDirectApi: boolean;
  permissionMode?: ProviderConfig['permissionMode'];
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  defaultModel?: string;
  customArgs: string[];
}

export interface TerminalCliLaunchSpec {
  command: string[];
  note: string | null;
}

function getDefaultCliPath(providerType: ProviderType): string | null {
  switch (providerType) {
    case 'anthropic':
      return '/Users/mk-mac-391/.claude/local/claude';
    case 'openai':
      return '/usr/local/bin/codex';
    default:
      return null;
  }
}

function buildFingerprintPayload(session: TerminalSession, runtime: Omit<TerminalRuntimeSpec, 'fingerprint'>): Record<string, unknown> {
  return {
    launchPolicyVersion: TERMINAL_LAUNCH_POLICY_VERSION,
    projectId: session.projectId,
    projectDirectory: runtime.workingDirectory,
    agentId: session.agentId,
    providerId: runtime.providerId,
    providerType: runtime.providerType,
    authMethod: runtime.authMethod,
    useDirectApi: runtime.useDirectApi,
    cliPath: runtime.cliPath,
    modelId: runtime.modelId,
    sandboxMode: runtime.sandboxMode ?? null,
    defaultModel: runtime.defaultModel ?? null,
    permissionMode: runtime.permissionMode ?? null,
    customArgs: runtime.customArgs,
    sessionMcpServerIds: session.mcpServerIds,
    mergedMcpServerIds: runtime.mergedMcpServerIds,
  };
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function resolveOpenAiSandboxMode(permissionMode?: ProviderConfig['permissionMode']): TerminalRuntimeSpec['sandboxMode'] {
  if (permissionMode === 'bypassPermissions') {
    return 'danger-full-access';
  }

  return 'workspace-write';
}

export function resolveTerminalRuntime(session: TerminalSession): TerminalRuntimeSpec {
  const agent = getAgentById(session.agentId);
  if (!agent) {
    throw new Error('Agent not found: ' + session.agentId);
  }

  const project = getProjectById(session.projectId);
  if (!project) {
    throw new Error('Project not found: ' + session.projectId);
  }

  const provider = getProviderById(agent.providerId);
  if (!provider) {
    throw new Error('Provider not found: ' + agent.providerId);
  }

  const resolvedMcp = resolveMcpScope({
    projectId: project.id,
    agentId: agent.id,
    overrideMcpServerIds: session.mcpServerIds,
  });

  const runtimeWithoutFingerprint: Omit<TerminalRuntimeSpec, 'fingerprint'> = {
    projectId: project.id,
    agentId: agent.id,
    providerId: provider.id,
    providerName: provider.name,
    providerType: provider.providerType,
    authMethod: provider.authMethod,
    workingDirectory: project.directoryPath,
    modelId: agent.modelId,
    mergedMcpServerIds: resolvedMcp.mcpServerIds,
    mcpConfigPath: resolvedMcp.mcpServers.length > 0 ? writeMcpConfig(resolvedMcp.mcpServers) : undefined,
    cliPath: provider.config.cliPath ?? getDefaultCliPath(provider.providerType),
    useDirectApi: provider.config.useDirectApi !== false,
    permissionMode: provider.config.permissionMode,
    sandboxMode: provider.providerType === 'openai'
      ? resolveOpenAiSandboxMode(provider.config.permissionMode)
      : undefined,
    defaultModel: provider.config.defaultModel,
    customArgs: [...(provider.config.customArgs ?? [])],
  };

  return {
    ...runtimeWithoutFingerprint,
    fingerprint: sha256(JSON.stringify(buildFingerprintPayload(session, runtimeWithoutFingerprint))),
  };
}

export function buildPtyCliLaunchSpec(runtime: TerminalRuntimeSpec): TerminalCliLaunchSpec | null {
  if (runtime.useDirectApi || !runtime.cliPath) {
    return null;
  }

  if (runtime.providerType === 'anthropic') {
    const command = [runtime.cliPath];
    if (runtime.defaultModel ?? runtime.modelId) {
      command.push('--model', runtime.defaultModel ?? runtime.modelId);
    }
    if (runtime.permissionMode) {
      command.push('--permission-mode', runtime.permissionMode);
    }
    if (runtime.mcpConfigPath) {
      command.push('--mcp-config', runtime.mcpConfigPath);
    }
    command.push(...runtime.customArgs);
    return { command, note: null };
  }

  if (runtime.providerType === 'openai') {
    const command = [runtime.cliPath];
    if (runtime.defaultModel ?? runtime.modelId) {
      command.push('--model', runtime.defaultModel ?? runtime.modelId);
    }
    command.push('--cd', runtime.workingDirectory);
    if (runtime.sandboxMode === 'danger-full-access') {
      command.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      command.push('--sandbox', runtime.sandboxMode ?? 'workspace-write', '--ask-for-approval', 'on-request');
    }
    if (runtime.mcpConfigPath) {
      command.push(...buildCodexMcpFlags(runtime.mcpConfigPath));
    }
    command.push(...runtime.customArgs);
    return { command, note: null };
  }

  return null;
}
