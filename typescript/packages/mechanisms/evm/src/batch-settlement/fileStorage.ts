import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import { isNodeEnoent, readJsonFile, resolveWithinDir, writeJsonAtomic } from "./storage-utils";
import { normalizeChannelId } from "./utils";
import type { FileChannelStorageOptions } from "./types";
import type { ChannelStorage, Channel, ChannelUpdateResult } from "./storage";

export type { FileChannelStorageOptions };

const DEFAULT_SCOPE = "server";

/**
 * Node.js file-backed {@link ChannelStorage} shared by the server and facilitator
 * voucher stores; `scope` keeps the two roles' records in separate sub-directories.
 */
export class FileChannelStorage implements ChannelStorage {
  private readonly root: string;
  private readonly scope: string;

  /**
   * Creates file-backed channel storage under the given root directory.
   *
   * @param options - Configuration including the storage root directory and scope.
   */
  constructor(options: FileChannelStorageOptions) {
    this.root = options.directory;
    this.scope = options.scope ?? DEFAULT_SCOPE;
  }

  /**
   * Loads a persisted channel record, if present.
   *
   * @param channelId - The channel identifier (path segment is lowercased).
   * @returns Parsed channel record or `undefined` when the file is missing.
   */
  async get(channelId: string): Promise<Channel | undefined> {
    return readJsonFile<Channel>(this.filePath(channelId));
  }

  /**
   * Lists all stored channel records by reading the scope directory.
   *
   * @returns Channel records sorted by channelId; empty array if the directory is missing.
   */
  async list(): Promise<Channel[]> {
    const dir = join(this.root, this.scope);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err: unknown) {
      if (isNodeEnoent(err)) return [];
      throw err;
    }

    const channels: Channel[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const raw = await readFile(path, "utf8");
        channels.push(JSON.parse(raw) as Channel);
      } catch (err: unknown) {
        // Skip files that disappeared between readdir and readFile (e.g. concurrent delete).
        // Rethrow other failures (corrupt JSON, permission denied) so callers see them.
        if (isNodeEnoent(err)) continue;
        throw err;
      }
    }
    return channels.sort((a, b) => a.channelId.localeCompare(b.channelId));
  }

  /**
   * Atomically inspects and mutates a channel record under a cross-process file lock.
   *
   * @param channelId - The channel identifier.
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored channel and whether storage updated, stayed unchanged, or deleted.
   */
  async updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
  ): Promise<ChannelUpdateResult> {
    const lockPath = this.filePath(channelId) + ".lock";
    await mkdir(dirname(lockPath), { recursive: true });
    const lockHandle = await this.acquireLock(lockPath);

    try {
      const path = this.filePath(channelId);
      let current: Channel | undefined;
      try {
        const raw = await readFile(path, "utf8");
        current = JSON.parse(raw) as Channel;
      } catch (err: unknown) {
        if (!isNodeEnoent(err)) throw err;
      }

      const next = update(current);
      if (next === current) {
        return { channel: current, status: "unchanged" };
      }

      if (!next) {
        try {
          await unlink(path);
        } catch (err: unknown) {
          if (!isNodeEnoent(err)) throw err;
        }
        return { channel: undefined, status: current ? "deleted" : "unchanged" };
      }

      await writeJsonAtomic(path, next);
      return { channel: next, status: "updated" };
    } finally {
      await lockHandle.close();
      await unlink(lockPath).catch(() => {});
    }
  }

  /**
   * Absolute path to the JSON file for a channel.
   *
   * @param channelId - The channel identifier.
   * @returns Filesystem path under `{root}/{scope}/...`.
   * @throws When `channelId` is not a canonical `bytes32` string or escapes the storage root.
   */
  private filePath(channelId: string): string {
    const id = normalizeChannelId(channelId);
    return resolveWithinDir(join(this.root, this.scope), `${id}.json`);
  }

  /**
   * Creates an exclusive lock file, polling until no other process holds it.
   *
   * @param lockPath - Absolute path for the lock file (created with `O_EXCL`).
   * @returns Writable file handle for the lock file; caller must close it to release.
   */
  private async acquireLock(lockPath: string) {
    while (true) {
      try {
        return await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
}
