import { Exa } from "exa-js";
import { serializeMcpClientMetadata } from "../utils/mcpClientMetadata.js";
import { classifyExaFailure, type KeyPool, type PoolLease } from "../utils/keyPool.js";

export type ExaClientConfig = {
  exaApiKey?: string;
  keyPool?: KeyPool;
  userProvidedApiKey?: boolean;
  oauthAccessToken?: string;
  exaSource?: string;
  mcpSessionId?: string;
  mcpClient?: unknown;
};

export interface WithPoolOptions {
  pinId?: string;
  allowUnpinnedFallback?: boolean;
  timeoutMs?: number;
}

function encodeIntegrationSource(source: string): string {
  return Array.from(new TextEncoder().encode(source), (byte) =>
    byte <= 127
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");
}

// Build Exa reporting headers, appending x-exa-source if present
export function integrationHeaders(tool: string, config?: ExaClientConfig) {
  const source = config?.exaSource;
  const mcpSessionId = config?.mcpSessionId;
  const mcpClient = serializeMcpClientMetadata(config?.mcpClient);
  const oauthAccessToken = config?.oauthAccessToken;
  const headers: Record<string, string> = {
    "x-exa-integration":
      typeof source === "string" ? `${tool}:${encodeIntegrationSource(source)}` : tool,
  };

  if (typeof oauthAccessToken === "string" && oauthAccessToken.length > 0) {
    headers["Authorization"] = `Bearer ${oauthAccessToken}`;
  }

  if (typeof mcpSessionId === "string" && mcpSessionId.length > 0) {
    headers["x-exa-mcp-session-id"] = mcpSessionId;
  }

  if (mcpClient) {
    headers["x-exa-mcp-client"] = mcpClient;
  }

  return headers;
}

export function createExaClient(config?: ExaClientConfig, tool?: string) {
  const exa = createBaseExaClient(config);
  if (tool) {
    applyClientHeaders(exa, integrationHeaders(tool, config));
  }
  return exa;
}

/**
 * Execute `fn` against a `KeyPool` lease when configured (falling back to single-key or OAuth
 * pass-through otherwise), rotating across available keys on Exa credential/rate/credit errors.
 */
export async function runWithPoolLease<T>(
  config: ExaClientConfig | undefined,
  fn: (lease?: PoolLease) => Promise<T>,
  options?: WithPoolOptions,
): Promise<T> {
  const oauthAccessToken = config?.oauthAccessToken;
  if (typeof oauthAccessToken === "string" && oauthAccessToken.length > 0) {
    return fn(undefined);
  }

  const pool = config?.keyPool;
  if (!pool || (!pool.hasKeys && !pool.keysFile)) {
    return fn(undefined);
  }

  if (options?.pinId) {
    const resolution = pool.resolvePin(options.pinId);
    if (resolution.status === "missing_key") {
      throw new Error(
        `Pinned Exa API key (${resolution.fingerprint}) for ${options.pinId} is disabled or no longer in the pool.`,
      );
    }
    if (resolution.status === "found") {
      try {
        return await fn(resolution.lease);
      } catch (error) {
        const failure = classifyExaFailure(error);
        if (failure) {
          pool.reportFailure(resolution.lease.fingerprint, failure);
        }
        throw error;
      }
    }
    if (!options.allowUnpinnedFallback) {
      throw new Error(`No pinned Exa API key found for ${options.pinId}.`);
    }
  }

  const tried = new Set<string>();
  const deadline = options?.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;

  while (true) {
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error("Exa key pool failover timed out before completing the request.");
    }

    const lease = pool.acquire(tried);
    if (!lease) {
      throw pool.buildUnavailableError(tried.size);
    }

    tried.add(lease.fingerprint);
    try {
      return await fn(lease);
    } catch (error) {
      const failure = classifyExaFailure(error);
      if (!failure) {
        throw error;
      }
      pool.reportFailure(lease.fingerprint, failure);
    }
  }
}

export async function withExaClient<T>(
  config: ExaClientConfig | undefined,
  tool: string | undefined,
  fn: (exa: Exa, lease?: PoolLease) => Promise<T>,
  options?: WithPoolOptions,
): Promise<T> {
  return runWithPoolLease(
    config,
    (lease) => {
      const exa = lease
        ? createExaClient({ ...config, exaApiKey: lease.key }, tool)
        : createExaClient(config, tool);
      return fn(exa, lease);
    },
    options,
  );
}

/**
 * Construct an exa-js client for `apiKey`. `EXA_API_BASE_URL` overrides the
 * Exa API origin the tools call (the integration suite points it at a local
 * double); unset, exa-js keeps its default of https://api.exa.ai.
 */
function newExaClient(apiKey: string): Exa {
  let baseUrl = process.env.EXA_API_BASE_URL;
  return baseUrl ? new Exa(apiKey, baseUrl) : new Exa(apiKey);
}

function createBaseExaClient(config?: ExaClientConfig) {
  const oauthAccessToken = config?.oauthAccessToken;
  if (typeof oauthAccessToken === "string" && oauthAccessToken.length > 0) {
    const exa = newExaClient("oauth");
    (exa as unknown as { headers: Headers }).headers.delete("x-api-key");
    return exa;
  }
  const exaApiKey = config?.exaApiKey;
  return newExaClient(
    typeof exaApiKey === "string" && exaApiKey.length > 0
      ? exaApiKey
      : process.env.EXA_API_KEY || "",
  );
}

function applyClientHeaders(exa: Exa, headers: Record<string, string>) {
  const client = exa as unknown as { headers: Headers | Record<string, string> };
  const headerBag = client.headers as Headers;
  if (typeof headerBag.set === "function") {
    Object.entries(headers).forEach(([key, value]) => headerBag.set(key, value));
    return;
  }

  client.headers = {
    ...client.headers,
    ...headers,
  };
}

// Configuration for API
export const API_CONFIG = {
  ENDPOINTS: {
    SEARCH: "/search",
    RESEARCH: "/research/v1",
  },
  TOOL_TIMEOUTS: {
    SEARCH_MS: 60_000,
    FETCH_MS: 60_000,
    ADVANCED_SEARCH_MS: 300_000,
  },
  DEFAULT_NUM_RESULTS: 10,
  DEFAULT_MAX_CHARACTERS: 3000,
} as const;
