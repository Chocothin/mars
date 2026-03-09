import { getSessionById, updateSessionCliSessionId, updateSessionRestartState } from '../db/terminal-repo';
import type { PtySessionInfo, TerminalSession, WsServerMessage } from '../types/terminal';
import { buildPtyCliLaunchSpec, resolveTerminalRuntime } from './runtime-spec';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_SCROLLBACK_BYTES = 64 * 1024;
const textDecoder = new TextDecoder();

interface PtyAttachOptions {
  cols: number;
  rows: number;
}

interface LaunchPlan {
  mode: PtySessionInfo['mode'];
  providerName: string;
  cwd: string;
  command: string[];
  note: string | null;
}

type PtySubscriber = (event: WsServerMessage) => void;
type PtyProcess = ReturnType<typeof Bun.spawn>;

interface PtyRuntime {
  sessionId: string;
  launch: LaunchPlan;
  process: PtyProcess;
  subscribers: Map<string, PtySubscriber>;
  scrollback: string;
  cols: number;
  rows: number;
}

function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function formatCommand(command: string[]): string {
  return command
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

function describeLaunch(plan: LaunchPlan): PtySessionInfo {
  return {
    mode: plan.mode,
    providerName: plan.providerName,
    cwd: plan.cwd,
    command: formatCommand(plan.command),
    note: plan.note,
  };
}

function appendScrollback(runtime: PtyRuntime, chunk: string): void {
  if (!chunk) {
    return;
  }

  runtime.scrollback = `${runtime.scrollback}${chunk}`;
  if (runtime.scrollback.length > MAX_SCROLLBACK_BYTES) {
    runtime.scrollback = runtime.scrollback.slice(-MAX_SCROLLBACK_BYTES);
  }
}

function buildShellLaunchPlan(session: TerminalSession, providerName: string, note: string | null): LaunchPlan {
  const shellPath = process.env.SHELL || '/bin/zsh';
  return {
    mode: 'shell_fallback',
    providerName,
    cwd: session.workingDirectory,
    command: [shellPath, '-i'],
    note,
  };
}

export class PtyRuntimeManager {
  private runtimes = new Map<string, PtyRuntime>();

  async attach(
    session: TerminalSession,
    subscriberId: string,
    options: PtyAttachOptions,
    onEvent: PtySubscriber,
  ): Promise<void> {
    let runtime = this.runtimes.get(session.id);
    if (!runtime) {
      runtime = await this.createRuntime(session, options);
    }

    runtime.subscribers.set(subscriberId, onEvent);
    onEvent({ type: 'pty_ready', sessionId: session.id, info: describeLaunch(runtime.launch) });

    if (runtime.scrollback.length > 0) {
      onEvent({ type: 'pty_output', sessionId: session.id, data: runtime.scrollback });
    }

    this.resize(session.id, options.cols, options.rows);
  }

  detach(sessionId: string, subscriberId: string): void {
    const runtime = this.runtimes.get(sessionId);
    runtime?.subscribers.delete(subscriberId);
  }

  write(sessionId: string, data: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      throw new Error('PTY session is not attached');
    }

    runtime.process.terminal?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return;
    }

    runtime.cols = normalizeDimension(cols, runtime.cols);
    runtime.rows = normalizeDimension(rows, runtime.rows);
    runtime.process.terminal?.resize(runtime.cols, runtime.rows);
  }

  terminate(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return;
    }

    runtime.process.terminal?.close();
    if (runtime.process.exitCode === null && !runtime.process.killed) {
      runtime.process.kill();
    }
    this.runtimes.delete(sessionId);
  }

  private async createRuntime(session: TerminalSession, options: PtyAttachOptions): Promise<PtyRuntime> {
    const launch = this.resolveLaunchPlan(session);

    try {
      return this.spawnRuntime(session, launch, options);
    } catch (error) {
      if (launch.mode === 'provider_cli') {
        const fallback = buildShellLaunchPlan(
          session,
          launch.providerName,
          `Provider CLI unavailable, attached project shell instead. ${error instanceof Error ? error.message : 'Unknown launch error.'}`,
        );
        return this.spawnRuntime(session, fallback, options);
      }

      throw error;
    }
  }

  private resolveLaunchPlan(session: TerminalSession): LaunchPlan {
    const runtime = resolveTerminalRuntime(session);
    const providerCliSpec = buildPtyCliLaunchSpec(runtime);
    const providerCliPlan = providerCliSpec
      ? {
          mode: 'provider_cli' as const,
          providerName: runtime.providerName,
          cwd: runtime.workingDirectory,
          command: providerCliSpec.command,
          note: providerCliSpec.note,
        }
      : null;

    if (providerCliPlan) {
      return providerCliPlan;
    }

    const note = runtime.useDirectApi === false
      ? 'Interactive provider CLI is not supported for this provider, so the panel is attached to the project shell.'
      : 'This provider uses the direct API, so the panel is attached to the project shell.';

    return buildShellLaunchPlan({ ...session, workingDirectory: runtime.workingDirectory }, runtime.providerName, note);
  }

  private spawnRuntime(session: TerminalSession, launch: LaunchPlan, options: PtyAttachOptions): PtyRuntime {
    const cols = normalizeDimension(options.cols, DEFAULT_COLS);
    const rows = normalizeDimension(options.rows, DEFAULT_ROWS);
    let runtime: PtyRuntime;

    const proc = Bun.spawn(launch.command, {
      cwd: launch.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PWD: launch.cwd,
      },
      terminal: {
        cols,
        rows,
        name: 'xterm-256color',
        data: (_terminal, data) => {
          const current = this.runtimes.get(session.id);
          if (!current) {
            return;
          }

          const text = typeof data === 'string' ? data : textDecoder.decode(data);

          appendScrollback(current, text);
          this.emit(current, { type: 'pty_output', sessionId: session.id, data: text });
        },
      },
      onExit: (_proc, exitCode, signalCode, error) => {
        const current = this.runtimes.get(session.id);
        if (!current) {
          return;
        }

        const shouldRestart = shouldMarkPtySessionRestart(current.launch.mode, current.scrollback, exitCode, error);
        if (shouldRestart) {
          const persisted = getSessionById(session.id);
          if (persisted) {
            updateSessionCliSessionId(session.id, null);
            updateSessionRestartState(
              session.id,
              true,
              'Provider CLI requested a restart. Restart the terminal session to continue.',
              Date.now(),
            );
          }
        }

        if (error) {
          this.emit(current, { type: 'pty_error', sessionId: session.id, error: error.message });
        } else if (shouldRestart) {
          this.emit(current, {
            type: 'pty_error',
            sessionId: session.id,
            error: 'Provider CLI requested a restart. Restart the terminal session to continue.',
          });
        }
        this.emit(current, {
          type: 'pty_exit',
          sessionId: session.id,
          exitCode,
          signalCode,
        });
        current.process.terminal?.close();
        this.runtimes.delete(session.id);
      },
    });

    runtime = {
      sessionId: session.id,
      launch,
      process: proc,
      subscribers: new Map(),
      scrollback: '',
      cols,
      rows,
    };

    this.runtimes.set(session.id, runtime);
    return runtime;
  }

  private emit(runtime: PtyRuntime, event: WsServerMessage): void {
    for (const subscriber of runtime.subscribers.values()) {
      subscriber(event);
    }
  }
}

export function shouldMarkPtySessionRestart(
  mode: PtySessionInfo['mode'],
  output: string,
  exitCode: number | null,
  error?: Error | null,
): boolean {
  if (mode !== 'provider_cli' || error || exitCode !== 0) {
    return false;
  }

  const normalized = output.toLowerCase();
  return normalized.includes('please restart')
    || normalized.includes('restart required')
    || normalized.includes('restart to continue');
}

export const ptyRuntimeManager = new PtyRuntimeManager();
