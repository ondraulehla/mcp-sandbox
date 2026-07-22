import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { collectMount, parseMountSpec } from '../src/fs.js';

let dirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'mcp-sandbox-fs-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe('parseMountSpec', () => {
  test('bare path has no explicit remote', () => {
    expect(parseMountSpec('./data')).toEqual({ localPath: './data', remotePath: null });
  });

  test('local:remote splits on the first colon', () => {
    expect(parseMountSpec('./data:/srv/data')).toEqual({
      localPath: './data',
      remotePath: '/srv/data',
    });
  });

  test('relative remote path is rejected', () => {
    expect(() => parseMountSpec('./data:srv/data')).toThrow(/absolute/);
  });

  test('empty halves are rejected', () => {
    expect(() => parseMountSpec(':/srv')).toThrow(/invalid spec/);
    expect(() => parseMountSpec('./data:')).toThrow(/invalid spec/);
  });
});

describe('collectMount', () => {
  test('single file lands at /home/user/<basename> by default', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(join(dir, 'config.json'), '{"a":1}');

    const mount = await collectMount(join(dir, 'config.json'));

    expect(mount.remotePath).toBe('/home/user/config.json');
    expect(mount.files).toHaveLength(1);
    expect(mount.files[0]!.path).toBe('/home/user/config.json');
    expect(await mount.files[0]!.data.text()).toBe('{"a":1}');
  });

  test('directory tree keeps its structure under the remote path', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(join(dir, 'nested'));
    await fs.writeFile(join(dir, 'top.txt'), 'top');
    await fs.writeFile(join(dir, 'nested', 'deep.txt'), 'deep');

    const mount = await collectMount(`${dir}:/srv/proj`);

    expect(mount.remotePath).toBe('/srv/proj');
    const paths = mount.files.map((f) => f.path).sort();
    expect(paths).toEqual(['/srv/proj/nested/deep.txt', '/srv/proj/top.txt']);
    expect(mount.totalBytes).toBe(7);
  });

  test('symlinks are skipped and counted, never followed', async () => {
    const dir = await makeTmpDir();
    const outside = await makeTmpDir();
    await fs.writeFile(join(outside, 'secret.txt'), 'secret');
    await fs.writeFile(join(dir, 'real.txt'), 'real');
    await fs.symlink(outside, join(dir, 'escape'));
    await fs.symlink(join(outside, 'secret.txt'), join(dir, 'secret-link'));

    const mount = await collectMount(dir);

    expect(mount.files.map((f) => f.path)).toEqual([
      `/home/user/${dir.split('/').pop()}/real.txt`,
    ]);
    expect(mount.skippedSymlinks).toBe(2);
  });

  test('a symlink as the mount root is refused', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(join(dir, 'real.txt'), 'x');
    await fs.symlink(join(dir, 'real.txt'), join(dir, 'link.txt'));

    await expect(collectMount(join(dir, 'link.txt'))).rejects.toThrow(/symlink/);
  });

  test('missing local path fails fast', async () => {
    await expect(collectMount('/definitely/not/here')).rejects.toThrow(/does not exist/);
  });

  test('file-count limit is enforced', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(join(dir, 'a.txt'), 'a');
    await fs.writeFile(join(dir, 'b.txt'), 'b');
    await fs.writeFile(join(dir, 'c.txt'), 'c');

    await expect(
      collectMount(dir, { maxFiles: 2, maxTotalBytes: 1024 }),
    ).rejects.toThrow(/more than 2 files/);
  });

  test('total-size limit is enforced', async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(join(dir, 'big.bin'), Buffer.alloc(2048));

    await expect(
      collectMount(dir, { maxFiles: 100, maxTotalBytes: 1024 }),
    ).rejects.toThrow(/limit/);
  });

  test('empty directory produces a mount with no files', async () => {
    const dir = await makeTmpDir();

    const mount = await collectMount(`${dir}:/srv/empty`);

    expect(mount.files).toHaveLength(0);
    expect(mount.totalBytes).toBe(0);
  });
});
