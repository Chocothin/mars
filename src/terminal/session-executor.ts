import type { TerminalSession, TerminalMessage, WsServerMessage, ISessionExecutor, CommandContext } from '../types/terminal';
import type { ProviderRequest, ProviderEvent, LLMProvider } from './provider/types';
import { InputRouter } from './input/input-router';
import { ShellExecutor } from './input/shell-executor';
import { SkillResolver } from './input/skill-resolver';
import { commandProcessor } from './command-processor';
import { providerRegistry } from './provider/registry';
import { SkillService } from '../skills/service';
import { insertMessage, updateSessionStatus, updateSessionWorkingDirectory, updateSessionCliSessionId } from '../db/terminal-repo';
import { randomUUID } from 'node:crypto';

export class SessionExecutor implements ISessionExecutor {
  private inputRouter = new InputRouter();
  private shellExecutor = new ShellExecutor();
  private skillResolver = new SkillResolver(new SkillService());
  private executingSessions = new Map<string, boolean>();
  private activeProviders = new Map<string, LLMProvider>();

  async execute(
    session: TerminalSession,
    content: string,
    onEvent: (event: WsServerMessage) => void,
  ): Promise<void> {
    if (session.restartRequired) {
      onEvent({
        type: 'error',
        sessionId: session.id,
        error: session.restartReason ?? 'Terminal session restart required before continuing.',
      });
      return;
    }

    this.executingSessions.set(session.id, true);

    try {
      updateSessionStatus(session.id, 'executing');
      onEvent({ type: 'status_changed', sessionId: session.id, status: 'executing' });

      const userMessage: TerminalMessage = {
        id: randomUUID(),
        sessionId: session.id,
        role: 'user',
        type: 'text',
        content,
        metadata: null,
        createdAt: Date.now(),
      };
      insertMessage(userMessage);
      onEvent({ type: 'message_stored', message: userMessage });

      const route = this.inputRouter.route(content);

      switch (route.type) {
        case 'message':
          await this.handleLLMMessage(session, route.text, onEvent);
          break;
        case 'shell':
          await this.handleShellCommand(session, route.command, onEvent);
          break;
        case 'builtin':
          await this.handleBuiltinCommand(session, route.name, route.args, onEvent);
          break;
        case 'skill':
          await this.handleSkillInvocation(session, route.skillName, route.remainder, onEvent);
          break;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      onEvent({ type: 'error', sessionId: session.id, error: message });
    } finally {
      this.executingSessions.delete(session.id);
      this.activeProviders.delete(session.id);
      updateSessionStatus(session.id, 'idle');
      onEvent({ type: 'status_changed', sessionId: session.id, status: 'idle' });
    }
  }

  abort(sessionId: string): void {
    const provider = this.activeProviders.get(sessionId);
    if (provider) {
      provider.abort(sessionId);
    }
    this.shellExecutor.abort(sessionId);
    this.executingSessions.delete(sessionId);
    this.activeProviders.delete(sessionId);
    updateSessionStatus(sessionId, 'idle');
  }

  isExecuting(sessionId: string): boolean {
    return this.executingSessions.has(sessionId);
  }

  private async handleLLMMessage(
    session: TerminalSession,
    text: string,
    onEvent: (event: WsServerMessage) => void,
    systemContext?: string,
  ): Promise<void> {
    const provider = providerRegistry.getForSession(session);
    this.activeProviders.set(session.id, provider);

    const request: ProviderRequest = {
      message: text,
      sessionId: session.id,
      workingDirectory: session.workingDirectory,
      continueSession: session.cliSessionId ?? undefined,
    };

    if (systemContext) {
      request.systemContext = systemContext;
    }

    const messageId = randomUUID();
    onEvent({ type: 'stream_start', sessionId: session.id, messageId });

    let fullContent = '';

    for await (const event of provider.sendMessage(request)) {
      switch (event.type) {
        case 'text_delta':
          fullContent += event.content;
          onEvent({ type: 'content_delta', sessionId: session.id, delta: event.content });
          break;
        case 'thinking_delta':
          onEvent({ type: 'reasoning_delta', sessionId: session.id, delta: event.content });
          break;
        case 'tool_use_start':
          onEvent({ type: 'tool_use_start', sessionId: session.id, toolName: event.toolName, toolId: event.toolId });
          break;
        case 'tool_use_delta':
          onEvent({ type: 'tool_use_delta', sessionId: session.id, toolId: event.toolId, delta: event.content });
          break;
        case 'tool_result':
          onEvent({ type: 'tool_result', sessionId: session.id, toolId: event.toolId, result: event.output });
          break;
        case 'error':
          onEvent({ type: 'error', sessionId: session.id, error: event.message });
          break;
        case 'complete': {
          if (event.metadata?.sessionId) {
            updateSessionCliSessionId(session.id, event.metadata.sessionId);
          }

          const assistantMessage: TerminalMessage = {
            id: messageId,
            sessionId: session.id,
            role: 'assistant',
            type: 'text',
            content: fullContent,
            metadata: event.metadata
              ? {
                  durationMs: event.metadata.durationMs,
                  costUsd: event.metadata.costUsd,
                  numTurns: event.metadata.numTurns,
                  model: undefined,
                }
              : null,
            createdAt: Date.now(),
          };
          insertMessage(assistantMessage);
          onEvent({ type: 'stream_end', sessionId: session.id, message: assistantMessage });
          break;
        }
      }
    }
  }

  private async handleShellCommand(
    session: TerminalSession,
    command: string,
    onEvent: (event: WsServerMessage) => void,
  ): Promise<void> {
    let fullOutput = '';
    let exitCode: number | undefined;

    for await (const output of this.shellExecutor.execute(command, session.workingDirectory)) {
      if (output.type === 'stdout' || output.type === 'stderr') {
        fullOutput += output.content;
        onEvent({ type: 'content_delta', sessionId: session.id, delta: output.content });
      }
      if (output.type === 'exit') {
        exitCode = output.exitCode;
      }
    }

    const resultMessage: TerminalMessage = {
      id: randomUUID(),
      sessionId: session.id,
      role: 'system',
      type: 'command_result',
      content: fullOutput,
      metadata: { exitCode },
      createdAt: Date.now(),
    };
    insertMessage(resultMessage);
    onEvent({ type: 'message_stored', message: resultMessage });
  }

  private async handleBuiltinCommand(
    session: TerminalSession,
    name: string,
    args: string[],
    onEvent: (event: WsServerMessage) => void,
  ): Promise<void> {
    const context: CommandContext = {
      sessionId: session.id,
      workingDirectory: session.workingDirectory,
      projectId: session.projectId,
      agentId: session.agentId,
    };

    const result = await commandProcessor.execute('/' + name + ' ' + args.join(' '), context);

    if (result.sideEffects?.workingDirectoryChanged) {
      updateSessionWorkingDirectory(session.id, result.sideEffects.workingDirectoryChanged);
    }

    onEvent({ type: 'command_result', sessionId: session.id, result });
  }

  private async handleSkillInvocation(
    session: TerminalSession,
    skillName: string,
    remainder: string,
    onEvent: (event: WsServerMessage) => void,
  ): Promise<void> {
    const skill = await this.skillResolver.resolve(skillName);

    if (!skill) {
      onEvent({ type: 'error', sessionId: session.id, error: 'Skill not found: ' + skillName });
      return;
    }

    const message = remainder || 'Execute skill: ' + skillName;
    await this.handleLLMMessage(session, message, onEvent, skill.content);
  }
}

export const sessionExecutor = new SessionExecutor();
