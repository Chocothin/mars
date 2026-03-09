import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BootstrapStateError, OrchestrationBootstrapService } from './bootstrap-service';
import { getEngine } from '../orchestrator/factory';
import { getDb } from '../db/index';
import { deleteRun } from '../db/run-repo';
import { deleteTaskExecutionsByRunId } from '../db/task-exec-repo';
import { TaskService } from '../tasks/service';
import type {
  BootstrapDependencyEdge,
  BootstrapMaterializationResult,
  BootstrapSuggestedTask,
  OrchestrationBootstrapManifest,
} from './types';

const ORCHESTRATION_DIR = '.mars/orchestration';
const MANIFEST_FILE = 'bootstrap.json';

export class BootstrapMaterializationService {
  private bootstrapService: OrchestrationBootstrapService;
  private taskService: TaskService;

  constructor(deps?: {
    bootstrapService?: OrchestrationBootstrapService;
    taskService?: TaskService;
  }) {
    this.bootstrapService = deps?.bootstrapService ?? new OrchestrationBootstrapService();
    this.taskService = deps?.taskService ?? new TaskService();
  }

  async materialize(projectId: string): Promise<BootstrapMaterializationResult> {
    const bootstrap = await this.bootstrapService.getBootstrap(projectId);
    if (!bootstrap) {
      throw new BootstrapStateError('Project bootstrap not found. Re-bootstrap is required.', 404);
    }

    const existingMaterialization = bootstrap.manifest.materialization;
    if (existingMaterialization && existingMaterialization.proposalGeneratedAt === bootstrap.proposal.generatedAt) {
      throw new BootstrapStateError('Bootstrap proposal already materialized for this project.', 409);
    }

    const proposalTasks = [
      ...bootstrap.proposal.suggestedRootTasks,
      bootstrap.proposal.suggestedFinalTestTask,
    ];
    const projectAgentIds = new Set(bootstrap.proposal.project.agentIds);

    const createdTaskIds: string[] = [];
    const createdTaskIdByProposalId = new Map<string, string>();
    let createdRunId: string | null = null;

    try {
      for (const task of proposalTasks) {
        const createdTask = await this.taskService.create(projectId, {
          title: task.title,
          description: task.description,
          priority: task.priority,
          assignedAgentId: task.assignedAgentId && projectAgentIds.has(task.assignedAgentId)
            ? task.assignedAgentId
            : undefined,
          status: 'backlog',
        });
        createdTaskIds.push(createdTask.id);
        createdTaskIdByProposalId.set(task.id, createdTask.id);
      }

      const dependencyPairs = this.buildDependencyPairs(
        bootstrap.proposal.suggestedRootTasks,
        bootstrap.proposal.suggestedFinalTestTask,
        bootstrap.proposal.dependencyEdges,
      );

      let dependencyCount = 0;
      for (const dependency of dependencyPairs) {
        const taskId = createdTaskIdByProposalId.get(dependency.taskId);
        const dependsOnTaskId = createdTaskIdByProposalId.get(dependency.dependsOnTaskId);
        if (!taskId || !dependsOnTaskId) {
          continue;
        }

        await this.taskService.addDependency(projectId, taskId, dependsOnTaskId);
        dependencyCount += 1;
      }

      const materializedRootTaskIds = proposalTasks
        .map((task) => createdTaskIdByProposalId.get(task.id))
        .filter((taskId): taskId is string => typeof taskId === 'string');

      const run = await getEngine().createRun(projectId, materializedRootTaskIds);
      createdRunId = run.id;

      const nextManifest: OrchestrationBootstrapManifest = {
        ...bootstrap.manifest,
        materialization: {
          proposalGeneratedAt: bootstrap.proposal.generatedAt,
          materializedAt: Date.now(),
          createdTaskIds,
          dependencyCount,
          runId: run.id,
          runStatus: run.status,
          noRunStarted: true,
        },
      };

      const manifestPath = join(bootstrap.proposal.project.directoryPath, ORCHESTRATION_DIR, MANIFEST_FILE);
      this.assertManifestReadable(manifestPath);
      writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2), 'utf8');

      return {
        createdTaskIds,
        dependencyCount,
        alreadyMaterialized: false,
        runId: run.id,
        runStatus: run.status,
        noRunStarted: true,
      };
    } catch (error) {
      await this.rollbackMaterialization(projectId, createdTaskIds, createdRunId);
      throw error;
    }
  }

  private async rollbackMaterialization(projectId: string, createdTaskIds: string[], runId: string | null): Promise<void> {
    if (runId) {
      deleteTaskExecutionsByRunId(runId);
      deleteRun(runId);
    }

    const db = getDb();
    for (const taskId of [...createdTaskIds].reverse()) {
      db.prepare('DELETE FROM task_dependencies WHERE task_id = $taskId OR depends_on_task_id = $taskId').run({ $taskId: taskId });
      await this.taskService.delete(projectId, taskId);
    }
  }

  private buildDependencyPairs(
    rootTasks: BootstrapSuggestedTask[],
    finalTestTask: BootstrapSuggestedTask,
    dependencyEdges: BootstrapDependencyEdge[],
  ): Array<{ taskId: string; dependsOnTaskId: string }> {
    const tasks = [...rootTasks, finalTestTask];
    const knownTaskIds = new Set(tasks.map((task) => task.id));
    const seen = new Set<string>();
    const pairs: Array<{ taskId: string; dependsOnTaskId: string }> = [];

    for (const task of tasks) {
      for (const dependsOnTaskId of task.dependsOnIds) {
        this.pushDependencyPair(pairs, seen, knownTaskIds, task.id, dependsOnTaskId);
      }
    }

    for (const edge of dependencyEdges) {
      if (edge.type !== 'blocks') {
        continue;
      }

      this.pushDependencyPair(pairs, seen, knownTaskIds, edge.toTaskId, edge.fromTaskId);
    }

    return pairs;
  }

  private pushDependencyPair(
    pairs: Array<{ taskId: string; dependsOnTaskId: string }>,
    seen: Set<string>,
    knownTaskIds: Set<string>,
    taskId: string,
    dependsOnTaskId: string,
  ): void {
    if (!knownTaskIds.has(taskId) || !knownTaskIds.has(dependsOnTaskId) || taskId === dependsOnTaskId) {
      return;
    }

    const key = `${taskId}:${dependsOnTaskId}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    pairs.push({ taskId, dependsOnTaskId });
  }

  private assertManifestReadable(manifestPath: string): void {
    try {
      JSON.parse(readFileSync(manifestPath, 'utf8')) as OrchestrationBootstrapManifest;
    } catch {
      throw new BootstrapStateError('Project bootstrap artifacts are corrupt. Re-bootstrap is required.', 409);
    }
  }
}
