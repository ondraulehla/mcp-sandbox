import { promises as fs } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { posix } from 'node:path';

/**
 * Local → sandbox file copying for `--fs`. Everything here runs on the local
 * side before the sandbox exists, so it is fully testable offline.
 *
 * Semantics are copy-in only: the server gets its own copy and nothing it
 * writes ever comes back to the local machine.
 */

export interface MountFile {
  /** Absolute POSIX path inside the sandbox. */
  path: string;
  data: Blob;
}

export interface Mount {
  localPath: string;
  /** Directory (or file path) the content lands at inside the sandbox. */
  remotePath: string;
  files: MountFile[];
  totalBytes: number;
  /** Symlinks are never followed; they are counted and reported instead. */
  skippedSymlinks: number;
}

export interface MountLimits {
  maxFiles: number;
  maxTotalBytes: number;
}

export const DEFAULT_MOUNT_LIMITS: MountLimits = {
  maxFiles: 2000,
  maxTotalBytes: 50 * 1024 * 1024,
};

const DEFAULT_REMOTE_BASE = '/home/user';

/** Parse `local[:remote]`. The remote part must be an absolute POSIX path. */
export function parseMountSpec(spec: string): { localPath: string; remotePath: string | null } {
  const idx = spec.indexOf(':');
  if (idx === -1) return { localPath: spec, remotePath: null };
  const localPath = spec.slice(0, idx);
  const remotePath = spec.slice(idx + 1);
  if (localPath === '' || remotePath === '') {
    throw new Error(`--fs: invalid spec "${spec}" — expected <local>[:<absolute sandbox path>]`);
  }
  if (!remotePath.startsWith('/')) {
    throw new Error(`--fs: sandbox path in "${spec}" must be absolute (start with /)`);
  }
  return { localPath, remotePath };
}

/**
 * Resolve a `--fs` spec into the concrete list of files to upload,
 * enforcing count/size limits so a stray `--fs ~` fails fast and clearly.
 */
export async function collectMount(
  spec: string,
  limits: MountLimits = DEFAULT_MOUNT_LIMITS,
): Promise<Mount> {
  const { localPath, remotePath } = parseMountSpec(spec);
  const absLocal = resolve(localPath);

  let stat;
  try {
    stat = await fs.lstat(absLocal);
  } catch {
    throw new Error(`--fs: local path does not exist: ${localPath}`);
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`--fs: refusing to follow symlink: ${localPath}`);
  }

  if (stat.isFile()) {
    if (stat.size > limits.maxTotalBytes) {
      throw new Error(
        `--fs: ${localPath} is ${formatBytes(stat.size)}, over the ${formatBytes(limits.maxTotalBytes)} limit`,
      );
    }
    const remote = remotePath ?? posix.join(DEFAULT_REMOTE_BASE, basename(absLocal));
    const data = new Blob([await fs.readFile(absLocal)]);
    return {
      localPath,
      remotePath: remote,
      files: [{ path: remote, data }],
      totalBytes: stat.size,
      skippedSymlinks: 0,
    };
  }

  if (!stat.isDirectory()) {
    throw new Error(`--fs: ${localPath} is neither a regular file nor a directory`);
  }

  const remoteDir = remotePath ?? posix.join(DEFAULT_REMOTE_BASE, basename(absLocal));
  const files: MountFile[] = [];
  let totalBytes = 0;
  let skippedSymlinks = 0;

  const walk = async (dir: string, remote: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const local = join(dir, entry.name);
      const target = posix.join(remote, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(local, target);
        continue;
      }
      if (!entry.isFile()) continue; // sockets, FIFOs, devices

      const info = await fs.stat(local);
      totalBytes += info.size;
      if (files.length + 1 > limits.maxFiles) {
        throw new Error(
          `--fs: ${localPath} has more than ${limits.maxFiles} files — copy a narrower directory`,
        );
      }
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(
          `--fs: ${localPath} exceeds the ${formatBytes(limits.maxTotalBytes)} limit — copy a narrower directory`,
        );
      }
      files.push({ path: target, data: new Blob([await fs.readFile(local)]) });
    }
  };

  await walk(absLocal, remoteDir);
  return { localPath, remotePath: remoteDir, files, totalBytes, skippedSymlinks };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
