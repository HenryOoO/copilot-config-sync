export type CategoryId =
  | 'skills'
  | 'instructions'
  | 'agents'
  | 'hooks'
  | 'prompts'
  | 'mcp'
  | 'lmProviders';

/** A single tracked file in a category. Paths are relative to the category root. */
export interface FileEntry {
  /** Relative path within the category (e.g. `ponytail/SKILL.md`). */
  path: string;
  /** sha256 hex of the raw file bytes. */
  hash: string;
  size: number;
  /** true if the file has any execute bit set. */
  executable: boolean;
}

/** Manifest for one category: the files it currently tracks. */
export interface CategoryManifest {
  files: FileEntry[];
}

/** Full local manifest. */
export interface Manifest {
  version: 1;
  device: string;
  updatedAt: string;
  categories: Record<CategoryId, CategoryManifest>;
}

/** A file's content in a bundle. */
export interface BundleFile {
  path: string;
  /** gzip + base64 of raw bytes. */
  content: string;
  hash: string;
  executable: boolean;
}

/** One category's payload in the remote bundle. */
export interface CategoryPayload {
  files: BundleFile[];
}

/** The remote bundle stored in the gist. */
export interface Bundle {
  version: 1;
  device: string;
  updatedAt: string;
  /** salt (hex) used for key derivation; present when any field is encrypted. */
  kdfSalt?: string;
  categories: Partial<Record<CategoryId, CategoryPayload>>;
}

/** Three-way comparison result for one file. */
export type FileConflictAction = 'local' | 'remote' | 'skip';

export interface ConflictFile {
  category: CategoryId;
  path: string;
  localHash?: string;
  remoteHash?: string;
  baseHash?: string;
}

export interface ConflictSet {
  /** Files where both sides changed relative to base. */
  conflicts: ConflictFile[];
  /** Files only local changed (safe to push). */
  localOnly: ConflictFile[];
  /** Files only remote changed (safe to pull). */
  remoteOnly: ConflictFile[];
  /** Files deleted locally but present in remote/base. */
  localDeleted: ConflictFile[];
  /** Files deleted remotely but present locally/base. */
  remoteDeleted: ConflictFile[];
}
