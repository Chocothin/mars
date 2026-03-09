import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import type { ApiResponse } from '../types/common';

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  currentPath: string;
  parent: string | null;
  directories: DirectoryEntry[];
}

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { success: false, error: message } satisfies ApiResponse,
    { status },
  );
}

export async function handleFilesystemRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/filesystem')) return null;
  if (req.method !== 'GET') return null;

  if (url.pathname === '/api/filesystem/browse') {
    return handleBrowse(url);
  }

  return null;
}

async function handleBrowse(url: URL): Promise<Response> {
  const requestedPath = url.searchParams.get('path') || homedir();
  const currentPath = resolve(requestedPath);
  const parent = currentPath === '/' ? null : dirname(currentPath);

  try {
    const entries = await readdir(currentPath, { withFileTypes: true });
    const directories: DirectoryEntry[] = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        name: entry.name,
        path: resolve(currentPath, entry.name),
      }));

    const data: BrowseResult = { currentPath, parent, directories };
    return Response.json({ success: true, data } satisfies ApiResponse<BrowseResult>);
  } catch {
    return errorResponse(`Cannot read directory: ${currentPath}`, 400);
  }
}
