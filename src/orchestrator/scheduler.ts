import type {
  ExecutionPlan,
  ExecutionBatch,
  DependencyEdge,
} from './types';

// ─── ITaskScheduler: 태스크 의존성 기반 실행 계획 생성 ───

export interface ITaskScheduler {
  // 의존성 그래프 분석 → 배치 기반 실행 계획 생성 (Kahn's topological sort)
  createPlan(taskIds: string[], dependencies: DependencyEdge[]): ExecutionPlan;

  // 순환 의존성 검출 — null이면 순환 없음, 배열이면 순환에 참여하는 edge 그룹
  detectCycles(dependencies: DependencyEdge[]): DependencyEdge[][] | null;

  // 완료된 태스크를 고려하여 다음 실행 가능한 배치 반환
  getNextBatch(plan: ExecutionPlan, completedTaskIds: Set<string>): ExecutionBatch | null;
}

// ─── TaskScheduler: Kahn's Algorithm 기반 구현 ───

export class TaskScheduler implements ITaskScheduler {
  createPlan(taskIds: string[], dependencies: DependencyEdge[]): ExecutionPlan {
    const taskSet = new Set(taskIds);

    const relevantDeps = dependencies.filter(
      (d) => taskSet.has(d.fromTaskId) && taskSet.has(d.toTaskId),
    );

    const cycles = this.detectCycles(relevantDeps);
    if (cycles) {
      const cycleEdges = cycles[0] ?? [];
      const involvedIds = [...new Set(cycleEdges.flatMap((e) => [e.fromTaskId, e.toTaskId]))];
      throw new Error(
        `Circular dependency detected among tasks: ${involvedIds.join(', ')}`,
      );
    }

    const batches = this.topologicalSort(taskIds, relevantDeps);

    return {
      batches,
      dependencyGraph: relevantDeps,
    };
  }

  detectCycles(dependencies: DependencyEdge[]): DependencyEdge[][] | null {
    const nodes = new Set<string>();
    const adjacency = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const dep of dependencies) {
      nodes.add(dep.fromTaskId);
      nodes.add(dep.toTaskId);
    }

    for (const node of nodes) {
      adjacency.set(node, []);
      inDegree.set(node, 0);
    }

    for (const dep of dependencies) {
      adjacency.get(dep.fromTaskId)!.push(dep.toTaskId);
      inDegree.set(dep.toTaskId, inDegree.get(dep.toTaskId)! + 1);
    }

    const queue: string[] = [];
    for (const [node, degree] of inDegree) {
      if (degree === 0) queue.push(node);
    }

    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      visited.add(current);

      for (const neighbor of adjacency.get(current)!) {
        const newDegree = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    if (visited.size === nodes.size) {
      return null;
    }

    const cycleNodes = new Set(
      [...nodes].filter((n) => !visited.has(n)),
    );

    const cycleEdges = dependencies.filter(
      (d) => cycleNodes.has(d.fromTaskId) && cycleNodes.has(d.toTaskId),
    );

    return cycleEdges.length > 0 ? [cycleEdges] : null;
  }

  getNextBatch(plan: ExecutionPlan, completedTaskIds: Set<string>): ExecutionBatch | null {
    for (const batch of plan.batches) {
      const pendingInBatch = batch.taskIds.filter(
        (id) => !completedTaskIds.has(id),
      );

      if (pendingInBatch.length === 0) continue;

      const allDepsComplete = pendingInBatch.every((taskId) => {
        const deps = plan.dependencyGraph.filter(
          (d) => d.toTaskId === taskId && d.type === 'blocks',
        );
        return deps.every((d) => completedTaskIds.has(d.fromTaskId));
      });

      if (allDepsComplete) {
        return {
          batchIndex: batch.batchIndex,
          taskIds: pendingInBatch,
        };
      }
    }

    return null;
  }

  // ─── Kahn's Topological Sort ───

  private topologicalSort(taskIds: string[], dependencies: DependencyEdge[]): ExecutionBatch[] {
    const adjacency = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const id of taskIds) {
      adjacency.set(id, []);
      inDegree.set(id, 0);
    }

    for (const dep of dependencies) {
      if (dep.type !== 'blocks') continue;
      adjacency.get(dep.fromTaskId)!.push(dep.toTaskId);
      inDegree.set(dep.toTaskId, inDegree.get(dep.toTaskId)! + 1);
    }

    const batches: ExecutionBatch[] = [];
    let batchIndex = 0;
    const remaining = new Set(taskIds);

    while (remaining.size > 0) {
      const ready: string[] = [];

      for (const id of remaining) {
        if (inDegree.get(id)! === 0) {
          ready.push(id);
        }
      }

      if (ready.length === 0) {
        break;
      }

      batches.push({ batchIndex, taskIds: ready });

      for (const id of ready) {
        remaining.delete(id);
        for (const neighbor of adjacency.get(id)!) {
          inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
        }
      }

      batchIndex++;
    }

    return batches;
  }
}
