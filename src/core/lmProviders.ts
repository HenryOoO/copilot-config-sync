import * as fs from 'fs';
import * as path from 'path';
import { ApiType } from './discovery';
import { ModelCapabilities } from './modelCatalog';

/** One model entry as written into `chatLanguageModels.json`. */
export interface LmModelEntry {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  vision: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  apiType?: ApiType;
  thinking?: boolean;
  supportsReasoningEffort?: string[];
}

/** One provider group in `chatLanguageModels.json`. */
export interface LmProviderGroup {
  name: string;
  vendor: string;
  apiKey?: string;
  apiType?: ApiType;
  models?: LmModelEntry[];
  [key: string]: unknown;
}

export const CUSTOM_ENDPOINT_VENDOR = 'customendpoint';
export const ADD_GROUP_COMMAND = 'lm.addLanguageModelsProviderGroup';

/** Read the provider groups, tolerating a missing or malformed file. */
export function readProviderGroups(file: string): LmProviderGroup[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as LmProviderGroup[]) : [];
  } catch {
    return [];
  }
}

/** Write the provider groups back, creating the parent directory if needed. */
export function writeProviderGroups(file: string, groups: LmProviderGroup[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(groups, null, 4), 'utf8');
}

/** Build a model entry from resolved capabilities. */
export function toModelEntry(
  id: string,
  caps: ModelCapabilities,
  url: string,
  apiType?: ApiType
): LmModelEntry {
  const entry: LmModelEntry = {
    id,
    name: caps.name || id,
    url,
    toolCalling: caps.toolCalling ?? true,
    vision: caps.vision ?? false,
    contextWindow: caps.contextWindow ?? 128_000,
    maxOutputTokens: caps.maxOutputTokens ?? 16_000,
  };
  if (apiType) {
    entry.apiType = apiType;
  }
  if (caps.thinking) {
    entry.thinking = true;
  }
  if (caps.supportsReasoningEffort?.length) {
    entry.supportsReasoningEffort = caps.supportsReasoningEffort;
  }
  return entry;
}

export interface MergeResult {
  group: LmProviderGroup;
  added: string[];
  /** Ids already present, left untouched so hand edits survive. */
  kept: string[];
}

/**
 * Merge discovered models into an existing group. Existing entries are never
 * overwritten — the user may have hand-tuned their capabilities.
 */
export function mergeModels(
  existing: LmProviderGroup | undefined,
  name: string,
  url: string,
  entries: LmModelEntry[],
  apiType?: ApiType
): MergeResult {
  const group: LmProviderGroup = existing
    ? { ...existing, models: [...(existing.models ?? [])] }
    : { name, vendor: CUSTOM_ENDPOINT_VENDOR, models: [] };
  if (!existing && apiType) {
    group.apiType = apiType;
  }
  const present = new Set((group.models ?? []).map((m) => m.id));
  const added: string[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    if (present.has(entry.id)) {
      kept.push(entry.id);
      continue;
    }
    group.models!.push(entry);
    present.add(entry.id);
    added.push(entry.id);
  }
  group.models!.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { group, added, kept };
}

/** Ids present in the group but no longer offered by the endpoint. */
export function staleModelIds(group: LmProviderGroup | undefined, discovered: string[]): string[] {
  if (!group?.models) {
    return [];
  }
  const live = new Set(discovered);
  return group.models.map((m) => m.id).filter((id) => !live.has(id));
}

export interface ApplyOptions {
  file: string;
  groupName: string;
  url: string;
  apiKey: string;
  apiType?: ApiType;
  entries: LmModelEntry[];
  /** Injected for tests. */
  executeCommand?: (command: string, ...args: unknown[]) => Thenable<unknown>;
}

export interface ApplyResult {
  added: string[];
  kept: string[];
  /** true when the key lives in secret storage rather than the file. */
  keyStoredSecurely: boolean;
  /**
   * true when no key could be stored, so the group was written without one.
   * The user must paste the key through VS Code's own UI.
   */
  keyOmitted: boolean;
}

/** A `${input:...}` value means the real key is already in secret storage. */
export function isSecretReference(value: unknown): boolean {
  return typeof value === 'string' && /^\$\{input:[^}]+\}$/.test(value);
}

/**
 * Write discovered models into `chatLanguageModels.json`.
 *
 * VS Code exposes no command that can *update* an existing provider group —
 * both `lm.addLanguageModelsProviderGroup` and `lm.migrateLanguageModelsProviderGroup`
 * throw when the group already exists. So:
 *
 *  - New group: use `lm.addLanguageModelsProviderGroup`, which stores the API
 *    key in secret storage and leaves only a `${input:...}` reference in the file.
 *  - Existing group: edit the file directly and preserve the existing `apiKey`
 *    (already a secret reference), so the key never has to be re-entered.
 *
 * A plaintext key is NEVER written to the file. VS Code treats any `apiKey`
 * value as a secret reference and runs `decodeSecretKey` on it, which mangles
 * a raw key into a bogus lookup name and resolves to `undefined` — the model
 * would silently fail. When no key can be stored, the group is written without
 * one and the caller must ask the user to paste it via VS Code's own UI.
 */
export async function applyDiscoveredModels(opts: ApplyOptions): Promise<ApplyResult> {
  const groups = readProviderGroups(opts.file);
  const existing = groups.find((g) => g.vendor === CUSTOM_ENDPOINT_VENDOR && g.name === opts.groupName);
  const { group, added, kept } = mergeModels(existing, opts.groupName, opts.url, opts.entries, opts.apiType);

  if (!existing && opts.executeCommand) {
    try {
      await opts.executeCommand(ADD_GROUP_COMMAND, {
        name: group.name,
        vendor: CUSTOM_ENDPOINT_VENDOR,
        apiKey: opts.apiKey,
        ...(opts.apiType ? { apiType: opts.apiType } : {}),
        models: group.models,
      });
      return { added, kept, keyStoredSecurely: true, keyOmitted: false };
    } catch {
      // command missing or rejected: fall through to the file write
    }
  }

  // Preserve an existing secret reference; never invent a plaintext one.
  const preservedKey = existing?.apiKey;
  const keyStoredSecurely = isSecretReference(preservedKey);
  if (preservedKey !== undefined) {
    group.apiKey = preservedKey;
  } else {
    delete group.apiKey;
  }

  const next = existing ? groups.map((g) => (g === existing ? group : g)) : [...groups, group];
  writeProviderGroups(opts.file, next);
  return { added, kept, keyStoredSecurely, keyOmitted: !keyStoredSecurely };
}
