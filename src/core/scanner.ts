import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CategoryId, FileEntry, Manifest } from './types';
import { sha256 } from './hash';

export interface SourceDir {
  category: CategoryId;
  /** Absolute directory path. */
  dir: string;
  /** File suffixes to include; empty means all files. */
  suffixes: string[];
  /** true to walk subdirectories recursively (skills trees). */
  recursive: boolean;
}

export function userHome(): string {
  return os.homedir();
}

export function vscodeUserDir(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(userHome(), 'Library', 'Application Support', 'Code', 'User');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(userHome(), 'AppData', 'Roaming'), 'Code', 'User');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(userHome(), '.config'), 'Code', 'User');
  }
}

/**
 * User-level Copilot config sources, mirroring VS Code 1.139 built-in discovery
 * (verified against the workbench source and official docs).
 *
 * Scope: Copilot-owned locations only. Claude Code-specific dirs
 * (~/.claude/skills, ~/.claude/rules, ~/.claude/agents) are intentionally
 * excluded — this tool does not take over other tools' config management.
 * ~/.agents/skills is the agentskills.io open standard dir that Copilot reads
 * natively, so it stays in scope.
 *
 * Note: several of these dirs are commonly symlinked to the same target
 * (e.g. ~/.agents/skills and ~/.claude/skills -> ~/.codexkeep/skills).
 * scanManifest dedupes by realpath so shared targets are scanned once.
 */
export function defaultSources(): SourceDir[] {
  const home = userHome();
  const user = vscodeUserDir();
  return [
    { category: 'skills', dir: path.join(home, '.agents', 'skills'), suffixes: [], recursive: true },
    { category: 'skills', dir: path.join(home, '.copilot', 'skills'), suffixes: [], recursive: true },
    { category: 'instructions', dir: path.join(home, '.copilot', 'instructions'), suffixes: ['.md', '.mdc'], recursive: false },
    { category: 'agents', dir: path.join(home, '.copilot', 'agents'), suffixes: ['.md'], recursive: false },
    { category: 'hooks', dir: path.join(home, '.copilot', 'hooks'), suffixes: ['.json'], recursive: false },
    { category: 'prompts', dir: path.join(user, 'prompts'), suffixes: ['.md'], recursive: false },
    { category: 'mcp', dir: path.join(user, 'mcp.json'), suffixes: [], recursive: false },
    { category: 'lmProviders', dir: path.join(user, 'chatLanguageModels.json'), suffixes: [], recursive: false },
  ];
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

function hasAnySuffix(name: string, suffixes: string[]): boolean {
  if (suffixes.length === 0) {
    return true;
  }
  const lower = name.toLowerCase();
  return suffixes.some((s) => lower.endsWith(s));
}

function walkFiles(dir: string, suffixes: string[], recursive: boolean, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing dir is fine
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.copilot') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !SKIP_DIRS.has(entry.name)) {
        walkFiles(full, suffixes, recursive, out);
      }
      continue;
    }
    if (entry.isFile() && hasAnySuffix(entry.name, suffixes)) {
      out.push(full);
    }
  }
}

function statExecutable(stats: fs.Stats): boolean {
  return (stats.mode & 0o111) !== 0;
}

/**
 * Scan all sources and build a manifest. Missing directories/files are skipped.
 * Sources whose directories resolve to the same realpath are scanned once
 * (common when ~/.agents/skills, ~/.claude/skills etc. are symlinked together).
 */
export function scanManifest(sources: SourceDir[] = defaultSources(), device?: string): Manifest {
  const categories: Record<string, { files: FileEntry[] }> = {};
  const seenRealDirs = new Set<string>();
  for (const src of sources) {
    const files: string[] = [];
    let baseDir: string;
    const isSingleFile = src.suffixes.length === 0 && !src.recursive && fs.statSync(src.dir, { throwIfNoEntry: false })?.isFile();
    if (isSingleFile) {
      files.push(src.dir);
      baseDir = path.dirname(src.dir);
    } else {
      // dedupe symlinked source dirs by realpath
      let realDir: string;
      try {
        realDir = fs.realpathSync(src.dir);
      } catch {
        continue; // missing dir
      }
      const dedupeKey = `${src.category}:${realDir}`;
      if (seenRealDirs.has(dedupeKey)) {
        continue;
      }
      seenRealDirs.add(dedupeKey);
      walkFiles(src.dir, src.suffixes, src.recursive, files);
      baseDir = src.dir;
    }
    const bucket = (categories[src.category] ??= { files: [] });
    for (const abs of files) {
      const stats = fs.statSync(abs);
      const rel = path.relative(baseDir, abs).split(path.sep).join('/');
      // prefix single-file sources so multiple sources in one category don't collide
      const key = isSingleFile ? path.basename(src.dir) : rel;
      bucket.files.push({
        path: key,
        hash: sha256(fs.readFileSync(abs)),
        size: stats.size,
        executable: statExecutable(stats),
      });
    }
  }
  // stable order
  const sorted: Record<string, { files: FileEntry[] }> = {};
  for (const cat of Object.keys(categories).sort()) {
    sorted[cat] = {
      files: categories[cat].files.sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
  }
  return {
    version: 1,
    device: device || os.hostname(),
    updatedAt: new Date().toISOString(),
    categories: sorted as Manifest['categories'],
  };
}
