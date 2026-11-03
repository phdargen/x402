import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureKind, TokenKey } from "./stats";

export type FailureRecord = {
  ts: string;
  channelIndex: number;
  channelId?: string;
  token: TokenKey;
  receiverIndex: number;
  kind: FailureKind;
  httpStatus?: number;
  reason: string;
  localBalance: string;
  charged: string;
  maxClaimableSent?: string;
  channelState?: Record<string, unknown>;
};

/**
 * Persists one bounded, signature-free record per failed paid operation.
 */
export class StressFailureRecorder {
  readonly path: string;

  /**
   * Creates a timestamped failure log in the report directory.
   *
   * @param reportDir - Directory for stress artifacts.
   */
  constructor(reportDir: string) {
    mkdirSync(reportDir, { recursive: true });
    this.path = join(reportDir, `stress-failures-${Date.now()}.ndjson`);
    writeFileSync(this.path, "");
  }

  /**
   * Appends one failure record.
   *
   * @param record - Signature-free failure details.
   */
  write(record: FailureRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}
