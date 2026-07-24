import { BaseProxy, RunConfig } from '../proxy-base';
import { ServerProxy, ServerConfig } from '../types';
import { verboseLog, errorLog } from '../logger';
import { resolveEvmPermit2Asset } from '../networks/networks';
import {
  forwardConfigEnv,
  forwardRoleCredentials,
  injectNetworkEnv,
} from '../env';

export interface ProtectedResponse {
  message: string;
  timestamp: string;
}

export interface HealthResponse {
  status: string;
}

export interface CloseResponse {
  message: string;
}

export interface ServerResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

export class GenericServerProxy extends BaseProxy implements ServerProxy {
  private port: number = 4021;
  private healthEndpoint: string = '/health';
  private closeEndpoint: string = '/close';

  constructor(directory: string) {
    // Use different ready logs for different server types
    const readyLog = directory.includes('next') ? 'Ready' : 'Server listening';
    super(directory, readyLog);
    this.loadEndpoints();
  }

  private loadEndpoints(): void {
    try {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const configPath = join(this.directory, 'test.config.json');

      if (existsSync(configPath)) {
        const configContent = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);

        // Load health endpoint
        const healthEndpoint = config.endpoints?.find((endpoint: any) => endpoint.health);
        if (healthEndpoint) {
          this.healthEndpoint = healthEndpoint.path;
        }

        // Load close endpoint
        const closeEndpoint = config.endpoints?.find((endpoint: any) => endpoint.close);
        if (closeEndpoint) {
          this.closeEndpoint = closeEndpoint.path;
        }
      }
    } catch {
      // Fallback to defaults if config loading fails
      errorLog(`Failed to load endpoints from config for ${this.directory}, using defaults`);
    }
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
      // ignore
    }
    return null;
  }

  async start(config: ServerConfig): Promise<void> {
    this.port = config.port;

    // Check if this is a v1 (legacy) server based on directory name
    const isV1Server = this.directory.includes('legacy/');

    verboseLog(`  📂 Server directory: ${this.directory}, isV1: ${isV1Server}`);

    if (isV1Server) {
      verboseLog(
        `  🔄 Translating networks for v1 server: ${config.networks.evm.caip2} → legacy EVM/SVM values`,
      );
    }

    const baseEnv: Record<string, string> = {
      PORT: config.port.toString(),
      ...forwardRoleCredentials('server', config.enabledFamilies),
      ...injectNetworkEnv(config.networks, { legacyV1: isV1Server }),
      EVM_PERMIT2_ASSET: resolveEvmPermit2Asset(config.networks),
      FACILITATOR_URL: config.facilitatorUrl || '',
      MOCK_FACILITATOR_URL: config.mockFacilitatorUrl || '',
    };

    const runConfig: RunConfig = {
      port: config.port,
      // Optional family-specific vars (HEDERA_ASSET, SERVER_NEAR_ASSET, etc.) are
      // forwarded from the root process via forwardConfigEnv + test.config.json.
      env: forwardConfigEnv(this.loadConfig(), baseEnv),
    };

    await this.startProcess(runConfig);
  }

  async protected(): Promise<ServerResult<ProtectedResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}/protected`);

      if (!response.ok) {
        return {
          success: false,
          error: `Protected endpoint failed: ${response.status} ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as ProtectedResponse,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async health(): Promise<ServerResult<HealthResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}${this.healthEndpoint}`);

      if (!response.ok) {
        return {
          success: false,
          error: `Health check failed: ${response.status} ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as HealthResponse,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<ServerResult<CloseResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}${this.closeEndpoint}`, {
        method: 'POST',
      });

      if (!response.ok) {
        return {
          success: false,
          error: `Close failed: ${response.status} ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as CloseResponse,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      try {
        // Try graceful shutdown via POST /close
        const closeResult = await this.close();
        if (closeResult.success) {
          // Wait a bit for graceful shutdown
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          verboseLog('Graceful shutdown failed, using force kill');
        }
      } catch {
        verboseLog('Graceful shutdown failed, using force kill');
      }
    }

    await this.stopProcess();
  }

  getHealthUrl(): string {
    return `http://localhost:${this.port}${this.healthEndpoint}`;
  }

  getProtectedPath(): string {
    return `/protected`;
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }
}
