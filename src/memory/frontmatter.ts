import type { MemoryFrontmatter } from '../types/memory';

/**
 * Parse YAML frontmatter delimited by `---` from a Markdown string.
 * Supports key: value, booleans, and `- item` arrays. No nested objects.
 */
export function parseFrontmatter(raw: string): { frontmatter: MemoryFrontmatter; content: string } {
  const trimmed = raw.trimStart();

  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, content: raw };
  }

  const afterOpening = trimmed.indexOf('\n');
  if (afterOpening === -1) {
    return { frontmatter: {}, content: raw };
  }

  const rest = trimmed.slice(afterOpening + 1);
  const closingIdx = rest.indexOf('\n---');
  if (closingIdx === -1) {
    return { frontmatter: {}, content: raw };
  }

  const yamlBlock = rest.slice(0, closingIdx);
  const afterClosing = rest.slice(closingIdx + 4);
  const content = afterClosing.startsWith('\n') ? afterClosing.slice(1) : afterClosing;

  const frontmatter = parseYamlBlock(yamlBlock);
  return { frontmatter, content };
}

/**
 * Serialize MemoryFrontmatter + content back to a raw Markdown string.
 * Omits the `---` block entirely if no frontmatter fields have values.
 */
export function serializeFrontmatter(frontmatter: MemoryFrontmatter, content: string): string {
  const lines: string[] = [];

  if (frontmatter.title != null) {
    lines.push(`title: ${frontmatter.title}`);
  }
  if (frontmatter.tags != null && frontmatter.tags.length > 0) {
    lines.push('tags:');
    for (const tag of frontmatter.tags) {
      lines.push(`  - ${tag}`);
    }
  }
  if (frontmatter.tier != null) {
    lines.push(`tier: ${frontmatter.tier}`);
  }
  if (frontmatter.scope != null) {
    lines.push(`scope: ${frontmatter.scope}`);
  }
  if (frontmatter.createdAt != null) {
    lines.push(`createdAt: ${frontmatter.createdAt}`);
  }
  if (frontmatter.protected != null) {
    lines.push(`protected: ${frontmatter.protected}`);
  }

  if (lines.length === 0) {
    return content;
  }

  return `---\n${lines.join('\n')}\n---\n${content}`;
}

function parseYamlBlock(yaml: string): MemoryFrontmatter {
  const fm: MemoryFrontmatter = {};
  const lines = yaml.split('\n');

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const arrayItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayItemMatch && currentKey !== null && currentArray !== null) {
      const captured = arrayItemMatch[1];
      if (captured !== undefined) {
        currentArray.push(stripQuotes(captured.trim()));
      }
      continue;
    }

    if (currentKey !== null && currentArray !== null) {
      assignValue(fm, currentKey, currentArray);
      currentKey = null;
      currentArray = null;
    }

    const kvMatch = line.match(/^([a-zA-Z_]\w*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1] ?? '';
    const rawValue = (kvMatch[2] ?? '').trim();

    if (rawValue === '') {
      currentKey = key;
      currentArray = [];
    } else {
      assignValue(fm, key, parseValue(rawValue));
    }
  }

  if (currentKey !== null && currentArray !== null) {
    assignValue(fm, currentKey, currentArray);
  }

  return fm;
}

function parseValue(raw: string): string | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return stripQuotes(raw);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function assignValue(fm: MemoryFrontmatter, key: string, value: string | boolean | string[]): void {
  switch (key) {
    case 'title':
      if (typeof value === 'string') fm.title = value;
      break;
    case 'tags':
      if (Array.isArray(value)) fm.tags = value;
      break;
    case 'tier':
      if (typeof value === 'string' && (value === 'global' || value === 'project' || value === 'agent')) {
        fm.tier = value;
      }
      break;
    case 'scope':
      if (typeof value === 'string') fm.scope = value;
      break;
    case 'createdAt':
      if (typeof value === 'string') fm.createdAt = value;
      break;
    case 'protected':
      if (typeof value === 'boolean') fm.protected = value;
      break;
  }
}
