import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import { isNodeEnoent, readJsonFile, writeJsonAtomic } from "../storage-utils";
import type { FileChannelStorageOptions } from "../types";
import type { ChannelStorage, Channel } from "./storage";

export type { FileChannelStorageOptions };

/**
 * Node.js file-backed {@link ChannelStorage} for the batched server scheme.
 */
export class FileChannelStorage implements ChannelStorage {
  private readonly root: string;

  /**
   * Creates file-backed server channel storage under the given root directory.
   *
   * @param options - Configuration including the storage root directory.
   */
  constructor(options: FileChannelStorageOptions) {
    this.root = options.directory;
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
   * Persists a channel record.
   *
   * @param channelId - The channel identifier.
   * @param channel - Channel record to write.
   */
  async set(channelId: string, channel: Channel): Promise<void> {
    await writeJsonAtomic(this.filePath(channelId), channel);
  }

  /**
   * Removes the persisted channel record file for a channel, if it exists.
   *
   * @param channelId - The channel identifier.
   */
  async delete(channelId: string): Promise<void> {
    try {
      await unlink(this.filePath(channelId));
    } catch (err: unknown) {
      if (isNodeEnoent(err)) return;
      throw err;
    }
  }

  /**
   * Lists all stored channel records by reading the server directory.
   *
   * @returns Channel records sorted by channelId; empty array if the directory is missing.
   */
  async list(): Promise<Channel[]> {
    const dir = join(this.root, "server");
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
   * Atomically updates a channel record only if the current `chargedCumulativeAmount` matches
   * `expectedCharged`. Uses an exclusive lockfile (`O_CREAT | O_EXCL`) so that exactly
   * one caller can hold the lock — others get `EEXIST` immediately. No TOCTOU window.
   *
   * @param channelId - The channel identifier.
   * @param expectedCharged - Expected current `chargedCumulativeAmount`.
   * @param channel - The new channel record to store if the check passes.
   * @returns `true` if the swap succeeded, `false` if the lock was held or the value changed.
   */
  async compareAndSet(
    channelId: string,
    expectedCharged: string,
    channel: Channel,
  ): Promise<boolean> {
    const lockPath = this.filePath(channelId) + ".lock";
    await mkdir(dirname(lockPath), { recursive: true });
    let lockHandle;
    try {
      lockHandle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }

    try {
      const path = this.filePath(channelId);
      try {
        const raw = await readFile(path, "utf8");
        const current = JSON.parse(raw) as Channel;
        if (current.chargedCumulativeAmount !== expectedCharged) {
          return false;
        }
      } catch (err: unknown) {
        if (!isNodeEnoent(err)) throw err;
      }
      await writeJsonAtomic(path, channel);
      return true;
    } finally {
      await lockHandle.close();
      await unlink(lockPath).catch(() => {});
    }
  }

  /**
   * Absolute path to the JSON file for a channel.
   *
   * @param channelId - The channel identifier.
   * @returns Filesystem path under `{root}/server/...`.
   */
  private filePath(channelId: string): string {
    return join(this.root, "server", `${channelId.toLowerCase()}.json`);
  }
}
