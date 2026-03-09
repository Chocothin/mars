import type { Skill, CreateSkillInput, UpdateSkillInput, SkillQuery, ISkillService } from '../types/skill';
import {
  insertSkill,
  getSkillById,
  getSkillByName,
  updateSkillMeta,
  deleteSkill as deleteSkillMeta,
  querySkills,
} from '../db/skill-repo';
import {
  skillFilePath,
  writeSkillFile,
  readSkillFile,
  deleteSkillFile,
  renameSkillFile,
} from './storage';
import { randomUUID } from 'node:crypto';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export class SkillService implements ISkillService {
  async create(input: CreateSkillInput): Promise<Skill> {
    this.validateName(input.name);

    const existing = getSkillByName(input.name);
    if (existing) {
      throw new Error(`Skill with name "${input.name}" already exists`);
    }

    const now = Date.now();
    const filePath = await writeSkillFile(input.name, input.content);

    const meta = {
      id: randomUUID(),
      name: input.name,
      filePath,
      createdAt: now,
      updatedAt: now,
    };

    insertSkill(meta);

    return {
      id: meta.id,
      name: meta.name,
      content: input.content,
      filePath: meta.filePath,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
  }

  async getById(id: string): Promise<Skill | null> {
    const meta = getSkillById(id);
    if (!meta) return null;

    const content = await readSkillFile(meta.filePath);
    if (content === null) {
      deleteSkillMeta(id);
      return null;
    }

    return {
      id: meta.id,
      name: meta.name,
      content,
      filePath: meta.filePath,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
  }

  async update(id: string, input: UpdateSkillInput): Promise<Skill | null> {
    const meta = getSkillById(id);
    if (!meta) return null;

    let currentName = meta.name;
    let currentFilePath = meta.filePath;
    const updates: { name?: string; filePath?: string } = {};

    if (input.name !== undefined && input.name !== meta.name) {
      this.validateName(input.name);

      const byName = getSkillByName(input.name);
      if (byName && byName.id !== id) {
        throw new Error(`Skill with name "${input.name}" already exists`);
      }

      const newFilePath = skillFilePath(input.name);
      renameSkillFile(currentFilePath, newFilePath);
      currentName = input.name;
      currentFilePath = newFilePath;
      updates.name = input.name;
      updates.filePath = newFilePath;
    }

    if (input.content !== undefined) {
      await writeSkillFile(currentName, input.content);
    }

    const hasDbUpdates = Object.keys(updates).length > 0;
    if (hasDbUpdates) {
      updateSkillMeta(id, updates);
    } else if (input.content !== undefined) {
      updateSkillMeta(id, {});
    }

    const content = await readSkillFile(currentFilePath);

    const updatedMeta = getSkillById(id);
    if (!updatedMeta) return null;

    return {
      id: updatedMeta.id,
      name: updatedMeta.name,
      content: content ?? '',
      filePath: updatedMeta.filePath,
      createdAt: updatedMeta.createdAt,
      updatedAt: updatedMeta.updatedAt,
    };
  }

  async delete(id: string): Promise<boolean> {
    const meta = getSkillById(id);
    if (!meta) return false;

    deleteSkillFile(meta.filePath);
    return deleteSkillMeta(id);
  }

  async list(query: SkillQuery): Promise<Skill[]> {
    const metaList = querySkills(query);
    const results: Skill[] = [];

    for (const meta of metaList) {
      const content = await readSkillFile(meta.filePath);
      if (content === null) {
        deleteSkillMeta(meta.id);
        continue;
      }

      results.push({
        id: meta.id,
        name: meta.name,
        content,
        filePath: meta.filePath,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      });
    }

    return results;
  }

  private validateName(name: string): void {
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(
        'Skill name must start with a lowercase letter or digit, and contain only lowercase letters, digits, hyphens, and underscores',
      );
    }
  }
}
