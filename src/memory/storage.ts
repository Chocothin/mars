import type {
  MemoryFile,
  MemoryTier,
  MemoryFileType,
  MemoryFrontmatter,
  CreateMemoryFileInput,
  UpdateMemoryFileInput,
  MemoryQuery,
  IMemoryStorage,
  MemoryMetadata,
} from '../types/memory';
import { indexFile, updateMetadata, removeFile, queryFiles, getById, recordAccess } from '../db/memory-index';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { estimateTokens, calculateChecksum } from './token-estimator';
import { getProjectById } from '../db/project-repo';
import { mkdirSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';

const MARS_BASE = join(homedir(), '.mars', 'memory');

function resolveBaseDir(tier: MemoryTier, scope: string): string {
  switch (tier) {
    case 'global':
      return join(MARS_BASE, 'global');
    case 'agent':
      return join(MARS_BASE, 'agents', scope);
    case 'project': {
      const project = getProjectById(scope);
      if (project) {
        return join(project.directoryPath, '.mars', 'memory');
      }
      // Fallback for projects not yet in DB (e.g., legacy or orphaned data)
      return join(MARS_BASE, 'projects', scope);
    }
  }
}

function fileTypeFromExtension(filename: string): MemoryFileType {
  const ext = extname(filename).toLowerCase();
  return ext === '.json' ? 'json' : 'markdown';
}

function titleFromFilename(filename: string): string {
  return basename(filename, extname(filename));
}

export class MemoryStorage implements IMemoryStorage {
  getFilePath(tier: MemoryTier, scope: string, filename: string): string {
    return join(resolveBaseDir(tier, scope), filename);
  }

  async ensureDirectoryExists(tier: MemoryTier, scope: string): Promise<void> {
    mkdirSync(resolveBaseDir(tier, scope), { recursive: true });
  }

  async createFile(input: CreateMemoryFileInput): Promise<MemoryFile> {
    await this.ensureDirectoryExists(input.tier, input.scope);

    const id = crypto.randomUUID();
    const now = Date.now();
    const filePath = this.getFilePath(input.tier, input.scope, input.filename);
    const isProtected = input.filename.startsWith('_');
    const fileType = fileTypeFromExtension(input.filename);

    const frontmatter: MemoryFrontmatter = {
      title: titleFromFilename(input.filename),
      tags: input.tags,
      tier: input.tier,
      scope: input.scope,
      createdAt: new Date(now).toISOString(),
      protected: isProtected || undefined,
    };

    const rawContent = serializeFrontmatter(frontmatter, input.content);
    await Bun.write(filePath, rawContent);

    const checksum = calculateChecksum(rawContent);
    const tokenCount = estimateTokens(input.content);
    const sizeBytes = Buffer.byteLength(rawContent, 'utf-8');

    const metadata: MemoryMetadata = {
      id,
      tier: input.tier,
      scope: input.scope,
      filename: input.filename,
      filePath,
      sizeBytes,
      tokenCount,
      isProtected,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      checksum,
    };

    indexFile(metadata);

    return {
      id,
      tier: input.tier,
      scope: input.scope,
      filename: input.filename,
      relativePath: input.filename,
      isProtected,
      content: input.content,
      fileType,
      createdAt: now,
      updatedAt: now,
    };
  }

  async readFile(id: string): Promise<MemoryFile | null> {
    const metadata = getById(id);
    if (!metadata) return null;

    if (!existsSync(metadata.filePath)) {
      console.warn(`[MARS] File on disk missing for id=${id}, path=${metadata.filePath}. Removing stale index entry.`);
      removeFile(id);
      return null;
    }

    const rawContent = await Bun.file(metadata.filePath).text();
    const { content } = parseFrontmatter(rawContent);

    recordAccess(id);

    return {
      id: metadata.id,
      tier: metadata.tier,
      scope: metadata.scope,
      filename: metadata.filename,
      relativePath: metadata.filename,
      isProtected: metadata.isProtected,
      content,
      fileType: fileTypeFromExtension(metadata.filename),
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    };
  }

  async updateFile(id: string, input: UpdateMemoryFileInput): Promise<MemoryFile | null> {
    const metadata = getById(id);
    if (!metadata) return null;

    const now = Date.now();
    const updates: Partial<MemoryMetadata> = { updatedAt: now };
    let currentFilePath = metadata.filePath;
    let currentFilename = metadata.filename;

    if (input.filename && input.filename !== metadata.filename) {
      const newPath = this.getFilePath(metadata.tier, metadata.scope, input.filename);
      renameSync(currentFilePath, newPath);
      currentFilePath = newPath;
      currentFilename = input.filename;
      updates.filename = input.filename;
      updates.filePath = newPath;
      updates.isProtected = input.filename.startsWith('_');
    }

    if (input.tags) {
      updates.tags = input.tags;
    }

    let contentBody: string;

    if (input.content !== undefined) {
      const existingRaw = await Bun.file(currentFilePath).text();
      const { frontmatter } = parseFrontmatter(existingRaw);

      if (input.tags) {
        frontmatter.tags = input.tags;
      }

      const rawContent = serializeFrontmatter(frontmatter, input.content);
      await Bun.write(currentFilePath, rawContent);

      updates.checksum = calculateChecksum(rawContent);
      updates.tokenCount = estimateTokens(input.content);
      updates.sizeBytes = Buffer.byteLength(rawContent, 'utf-8');
      contentBody = input.content;
    } else {
      if (input.tags) {
        const existingRaw = await Bun.file(currentFilePath).text();
        const { frontmatter, content } = parseFrontmatter(existingRaw);
        frontmatter.tags = input.tags;
        const rawContent = serializeFrontmatter(frontmatter, content);
        await Bun.write(currentFilePath, rawContent);
        updates.sizeBytes = Buffer.byteLength(rawContent, 'utf-8');
        updates.checksum = calculateChecksum(rawContent);
        contentBody = content;
      } else {
        const existingRaw = await Bun.file(currentFilePath).text();
        const { content } = parseFrontmatter(existingRaw);
        contentBody = content;
      }
    }

    updateMetadata(id, updates);

    return {
      id: metadata.id,
      tier: metadata.tier,
      scope: metadata.scope,
      filename: currentFilename,
      relativePath: currentFilename,
      isProtected: updates.isProtected ?? metadata.isProtected,
      content: contentBody,
      fileType: fileTypeFromExtension(currentFilename),
      createdAt: metadata.createdAt,
      updatedAt: now,
    };
  }

  async deleteFile(id: string): Promise<boolean> {
    const metadata = getById(id);
    if (!metadata) return false;

    try {
      if (existsSync(metadata.filePath)) {
        unlinkSync(metadata.filePath);
      }
    } catch (err) {
      throw new Error(`Failed to delete file at ${metadata.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    removeFile(id);
    return true;
  }

  // NOTE: For large result sets, loading content for every file is expensive.
  // TODO: Consider lazy content loading or a separate `listMetadata` method.
  async listFiles(query: MemoryQuery): Promise<MemoryFile[]> {
    const metadataList = queryFiles(query);
    const results: MemoryFile[] = [];

    for (const metadata of metadataList) {
      if (!existsSync(metadata.filePath)) {
        console.warn(`[MARS] File on disk missing for id=${metadata.id}, path=${metadata.filePath}. Removing stale index entry.`);
        removeFile(metadata.id);
        continue;
      }

      try {
        const rawContent = await Bun.file(metadata.filePath).text();
        const { content } = parseFrontmatter(rawContent);

        results.push({
          id: metadata.id,
          tier: metadata.tier,
          scope: metadata.scope,
          filename: metadata.filename,
          relativePath: metadata.filename,
          isProtected: metadata.isProtected,
          content,
          fileType: fileTypeFromExtension(metadata.filename),
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
        });
      } catch (err) {
        console.warn(`[MARS] Failed to read file id=${metadata.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // TODO: Handle files that exist on disk but not in SQLite index (future "reindex" feature)

    return results;
  }
}
