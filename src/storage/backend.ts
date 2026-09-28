import { Bundle } from '../core/types';

/** Abstraction over the remote store so backends are swappable. */
export interface StorageBackend {
  /** Read the full bundle; undefined if nothing stored yet. */
  read(): Promise<Bundle | undefined>;
  /** Write the full bundle (replaces previous content). */
  write(bundle: Bundle): Promise<void>;
  /** Remove the remote bundle entirely. */
  delete(): Promise<void>;
  /** True if a bundle exists remotely. */
  exists(): Promise<boolean>;
}
