import type {
  ICompactor,
  CompactionResult,
  CompactionEstimate,
  MemoryMetadata,
  MemoryTier,
} from '../types/memory';
import { queryFiles, getById } from '../db/memory-index';

const ESTIMATED_COMPRESSION_RATIO = 0.3;

export class MemoryCompactor implements ICompactor {
  async identifyTargets(
    tier: MemoryTier,
    scope: string,
    maxTokens: number,
  ): Promise<MemoryMetadata[]> {
    const compactableFiles = queryFiles({
      tier,
      scope,
      isProtected: false,
      sortBy: 'tokenCount',
      sortOrder: 'desc',
      limit: 500,
    });

    const allScopeFiles = queryFiles({ tier, scope, limit: 500 });
    const totalTokens = allScopeFiles.reduce((sum, f) => sum + f.tokenCount, 0);

    if (totalTokens <= maxTokens) {
      return [];
    }

    const targets: MemoryMetadata[] = [];
    let tokensToFree = totalTokens - maxTokens;

    for (const file of compactableFiles) {
      if (tokensToFree <= 0) break;
      targets.push(file);
      tokensToFree -= file.tokenCount;
    }

    return targets;
  }

  async compact(fileIds: string[]): Promise<CompactionResult> {
    if (fileIds.length === 0) {
      throw new Error('No file IDs provided for compaction');
    }

    this.validateCompactableFiles(fileIds);

    throw new Error(
      'Compaction not yet implemented — requires LLM provider integration. ' +
      'Use estimateCompaction() to preview what would happen.',
    );
  }

  async estimateCompaction(fileIds: string[]): Promise<CompactionEstimate> {
    if (fileIds.length === 0) {
      return {
        targetFiles: 0,
        currentTokens: 0,
        estimatedResultTokens: 0,
        estimatedSaving: 0,
      };
    }

    const validFiles = this.validateCompactableFiles(fileIds);
    const currentTokens = validFiles.reduce((sum, f) => sum + f.tokenCount, 0);
    const estimatedResultTokens = Math.ceil(currentTokens * ESTIMATED_COMPRESSION_RATIO);

    return {
      targetFiles: validFiles.length,
      currentTokens,
      estimatedResultTokens,
      estimatedSaving: currentTokens - estimatedResultTokens,
    };
  }

  private validateCompactableFiles(fileIds: string[]): MemoryMetadata[] {
    const files: MemoryMetadata[] = [];

    for (const id of fileIds) {
      const meta = getById(id);
      if (!meta) {
        throw new Error(`Memory file not found: ${id}`);
      }
      if (meta.isProtected) {
        throw new Error(`Cannot compact protected file: ${meta.filename}`);
      }
      files.push(meta);
    }

    return files;
  }
}
