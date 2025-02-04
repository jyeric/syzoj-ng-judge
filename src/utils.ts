import fs from "fs";
import crypto from "crypto";
import { join, normalize } from "path";

import axios from "axios";
import AgentKeepAlive from "agentkeepalive";

import * as fsNative from "./fsNative";
import config from "./config";

export interface MappedPath {
  outside: string;
  inside: string;
}

// A useful wrapper for path.join()

export function safelyJoinPath(basePath: MappedPath, ...paths: string[]): MappedPath;
export function safelyJoinPath(basePath: string, ...paths: string[]): string;

/**
 * Safely join paths. Ensure the joined path won't escape the base path.
 */
export function safelyJoinPath(basePath: MappedPath | string, ...paths: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-shadow
  function doSafelyJoin(basePath: string, paths: string[]) {
    // path.normalize ensures the `../`s is on the left side of the result path
    const childPath = normalize(join(...paths));
    if (childPath.startsWith(".."))
      throw new Error(
        `Invalid path join: ${JSON.stringify(
          {
            basePath,
            paths
          },
          null,
          2
        )}`
      );

    return join(basePath, childPath);
  }

  if (typeof basePath === "string") return doSafelyJoin(basePath, paths);
  return {
    inside: doSafelyJoin(basePath.inside, paths),
    outside: doSafelyJoin(basePath.outside, paths)
  };
}

export async function ensureDirectoryEmpty(path: string): Promise<void> {
  await fsNative.ensureDir(path);
  await fsNative.emptyDir(path);
}

export function ensureDirectoryEmptySync(path: string) {
  fsNative.ensureDirSync(path);
  fsNative.emptyDirSync(path);
}

/**
 * Read a file's first at most `lengthLimit` bytes, ignoring the remaining bytes.
 */
export async function readFileLimited(filePath: string, lengthLimit: number): Promise<string> {
  let file: fs.promises.FileHandle;
  try {
    try {
      file = await fs.promises.open(filePath, "r");
    } catch (e) {
      if (e.code === "ENOENT") return "";
      throw e;
    }
    const actualSize = (await file.stat()).size;
    const buf = Buffer.allocUnsafe(Math.min(actualSize, lengthLimit));
    const { bytesRead } = await file.read(buf, 0, buf.length, 0);
    const ret = buf.toString("utf8", 0, bytesRead);
    return ret;
  } catch (e) {
    return "";
  } finally {
    if (file) await file.close();
  }
}

export function hashData(data: string): Promise<string> {
  const hash = crypto.createHash("sha256");

  const promise = new Promise<string>((resolve, reject) => {
    hash.on("error", reject);
    hash.on("finish", () => resolve(hash.digest("hex")));
  });

  hash.end(data);

  return promise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Key = keyof any;
export type OverridableRecord<K extends Key, V> = Record<K, V | ((oldValue: V) => V)>;

export function merge<K extends Key, V>(
  baseRecord: OverridableRecord<K, V>,
  overrideRecord: OverridableRecord<K, V>
): OverridableRecord<K, V>;

export function merge<K extends Key, V>(
  baseRecord: Record<string, V>,
  overrideRecord: OverridableRecord<K, V>
): Record<string, V>;

export function merge<K extends Key, V>(baseRecord: OverridableRecord<K, V>, overrideRecord: OverridableRecord<K, V>) {
  if (!overrideRecord) return baseRecord;

  const result: OverridableRecord<K, V> = { ...baseRecord };
  Reflect.ownKeys(overrideRecord).forEach(key => {
    const valueOrReducer = overrideRecord[key];
    if (typeof valueOrReducer === "function") {
      const oldValueOrReducer = result[key];
      if (typeof oldValueOrReducer === "function")
        result[key] = (olderValue: V) => valueOrReducer(oldValueOrReducer(olderValue));
      else result[key] = valueOrReducer;
    } else result[key] = valueOrReducer;
  });
  return result;
}

// TODO: check download speed
export const download = (() => {
  const agentOptions: AgentKeepAlive.HttpOptions & AgentKeepAlive.HttpsOptions = {
    timeout: 60 * 60 * 1000
  };

  const httpAgent = new AgentKeepAlive(agentOptions);
  const httpsAgent = new AgentKeepAlive.HttpsAgent(agentOptions);

  return async (url: string, destination: string, description: string) => {
    for (let retry = config.downloadRetry - 1; retry >= 0; retry--) {
      const fileStream: fs.WriteStream = fs.createWriteStream(destination);
      const abortController = new AbortController();

      try {
        const response = await axios({
          url,
          responseType: "stream",
          signal: abortController.signal,
          httpAgent,
          httpsAgent
        });

        const timeoutTimer = setTimeout(() => {
          abortController.abort();
        }, config.downloadTimeout);

        response.data.pipe(fileStream);

        await new Promise<void>((resolve, reject) => {
          const finish = (callback: () => void) => {
            clearTimeout(timeoutTimer);
            callback();
          };

          fileStream.on("finish", () => finish(resolve));
          fileStream.on("error", () => finish(reject));
        });

        // Download success!
        break;
      } catch (e) {
        if (retry !== 0) continue;

        if (abortController.signal.aborted) {
          throw new Error(
            `Failed to download ${description}: timed-out after ${config.downloadTimeout}ms for ${config.downloadRetry} times`
          );
        }

        // Failed
        throw new Error(`Failed to download ${description}: ${e}`);
      } finally {
        fileStream.close();
      }
    }
  };
})();
