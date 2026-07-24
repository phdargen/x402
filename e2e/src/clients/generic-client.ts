import { BaseProxy, RunConfig } from '../proxy-base';
import { ClientConfig, ClientProxy } from '../types';
import {
  forwardConfigEnv,
  forwardRoleCredentials,
  injectNetworkEnv,
  tvmProviderEnv,
} from '../env';

export interface ClientCallResult {
  success: boolean;
  data?: any;
  status_code?: number;
  payment_response?: any;
  error?: string;
  exitCode?: number;
}

export class GenericClientProxy extends BaseProxy implements ClientProxy {
  constructor(directory: string) {
    // For clients, we don't wait for a ready log since they're one-shot processes
    super(directory, '');
  }

  async call(config: ClientConfig): Promise<ClientCallResult> {
    try {
      const isV1Client = this.directory.includes('legacy/');

      const baseEnv: Record<string, string> = {
        ...forwardRoleCredentials('client'),
        ...injectNetworkEnv(config.networks, { legacyV1: isV1Client }),
        ...tvmProviderEnv(config.networks),
        RESOURCE_SERVER_URL: config.serverUrl,
        ENDPOINT_PATH: config.endpointPath,
        ...(config.batchSettlement
          ? {
              CHANNEL_SALT: config.batchSettlement.channelSalt,
              BATCH_SETTLEMENT_PHASE: config.batchSettlement.phase,
              ...(config.batchSettlement.voucherSignerPrivateKey
                ? { CLIENT_EVM_VOUCHER_SIGNER_PRIVATE_KEY: config.batchSettlement.voucherSignerPrivateKey }
                : {}),
            }
          : {}),
      };

      const runConfig: RunConfig = {
        env: forwardConfigEnv(this.loadConfig(), baseEnv),
      };

      // For clients, we run the process and wait for it to complete
      const result = await this.runOneShotProcess(runConfig);

      // Convert ProcessResult to ClientCallResult
      if (result.success && result.data) {
        return {
          success: true,
          data: result.data.data,
          status_code: result.data.status_code,
          payment_response: result.data.payment_response,
          exitCode: result.exitCode,
        };
      }

      return {
        success: false,
        error: result.error,
        exitCode: result.exitCode,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if the client process is currently running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Force stop the client process if it's running
   */
  async forceStop(): Promise<void> {
    await this.stopProcess();
  }

  private loadConfig(): any {
    try {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const configPath = join(this.directory, 'test.config.json');

      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
      }
    } catch {
      // Fall back to the explicitly provided env set when config loading fails.
    }
    return null;
  }
}
