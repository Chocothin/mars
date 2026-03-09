import { randomUUID } from 'node:crypto';
import type { ShellOutput } from '../provider/types';

export class ShellExecutor {
  private processes = new Map<string, ReturnType<typeof Bun.spawn>>();

  async *execute(
    command: string,
    workingDirectory: string,
  ): AsyncGenerator<ShellOutput> {
    const processId = randomUUID();
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd: workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.processes.set(processId, proc);

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield {
          type: 'stdout',
          content: decoder.decode(value, { stream: true }),
        };
      }

      const stderrText = await new Response(proc.stderr).text();
      if (stderrText) {
        yield { type: 'stderr', content: stderrText };
      }

      const exitCode = await proc.exited;
      yield { type: 'exit', content: '', exitCode };
    } finally {
      this.processes.delete(processId);
    }
  }

  abort(processId: string): void {
    const proc = this.processes.get(processId);
    if (proc) {
      proc.kill('SIGTERM');
      this.processes.delete(processId);
    }
  }
}
