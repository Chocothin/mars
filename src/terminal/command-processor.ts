import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import type { CommandDefinition, CommandContext, CommandResult } from '../types/terminal';

export class CommandProcessor {
  private commands: Map<string, CommandDefinition>;

  constructor() {
    this.commands = new Map();
    this.registerBuiltInCommands();
  }

  private registerBuiltInCommands(): void {
    this.register({
      name: 'cd',
      description: 'Change working directory',
      usage: '/cd <path>',
      execute: async (args: string[], context: CommandContext): Promise<CommandResult> => {
        if (args.length === 0) {
          return {
            output: context.workingDirectory,
            success: true,
          };
        }

        const targetPath = args[0];
        if (!targetPath) {
          return {
            output: 'cd: path required',
            success: false,
          };
        }

        const resolvedPath = targetPath.startsWith('/') ? targetPath : resolve(context.workingDirectory, targetPath);

        try {
          const stats = statSync(resolvedPath);
          if (!stats.isDirectory()) {
            return {
              output: `cd: not a directory: ${targetPath}`,
              success: false,
            };
          }
        } catch {
          return {
            output: `cd: no such directory: ${targetPath}`,
            success: false,
          };
        }

        return {
          output: resolvedPath,
          success: true,
          sideEffects: {
            workingDirectoryChanged: resolvedPath,
          },
        };
      },
    });

    this.register({
      name: 'pwd',
      description: 'Print working directory',
      usage: '/pwd',
      execute: async (args: string[], context: CommandContext): Promise<CommandResult> => {
        return {
          output: context.workingDirectory,
          success: true,
        };
      },
    });

    this.register({
      name: 'clear',
      description: 'Clear terminal history',
      usage: '/clear',
      execute: async (args: string[], context: CommandContext): Promise<CommandResult> => {
        return {
          output: '',
          success: true,
          sideEffects: {
            clearTerminal: true,
          },
        };
      },
    });

    this.register({
      name: 'help',
      description: 'Show available commands',
      usage: '/help',
      execute: async (args: string[], context: CommandContext): Promise<CommandResult> => {
        const commands = Array.from(this.commands.values());
        const lines = ['Available commands:', ''];

        for (const cmd of commands) {
          lines.push(`  /${cmd.name}  ${cmd.description}`);
          lines.push(`         Usage: ${cmd.usage}`);
          lines.push('');
        }

        return {
          output: lines.join('\n'),
          success: true,
        };
      },
    });
  }

  register(command: CommandDefinition): void {
    this.commands.set(command.name, command);
  }

  isCommand(input: string): boolean {
    return input.startsWith('/');
  }

  parse(input: string): { name: string; args: string[] } | null {
    if (!this.isCommand(input)) {
      return null;
    }

    const trimmed = input.slice(1).trim();
    if (!trimmed) {
      return null;
    }

    const parts = trimmed.split(/\s+/);
    const name = parts[0];
    if (!name) {
      return null;
    }

    const args = parts.slice(1);

    return { name, args };
  }

  async execute(input: string, context: CommandContext): Promise<CommandResult> {
    const parsed = this.parse(input);

    if (!parsed) {
      return {
        output: 'Invalid command format. Type /help for available commands.',
        success: false,
      };
    }

    const command = this.commands.get(parsed.name);

    if (!command) {
      return {
        output: `Unknown command: /${parsed.name}. Type /help for available commands.`,
        success: false,
      };
    }

    return command.execute(parsed.args, context);
  }

  getCommands(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }
}

export const commandProcessor = new CommandProcessor();
