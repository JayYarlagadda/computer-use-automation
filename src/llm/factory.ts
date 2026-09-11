/**
 * Chooses a provider from configuration.
 *
 * Kept apart from the providers themselves so that nothing which needs a model
 * also needs to know how the process is configured. The loop takes an
 * `LlmProvider`; only the CLI calls this.
 */

import { createOpenAiCompatibleProvider } from './openaiCompatible.js';
import type { LlmProvider } from './types.js';

export type ProviderId = 'groq' | 'openai';

interface ProviderProfile {
  label: string;
  keyVar: string;
  baseUrlVar: string;
  defaultBaseUrl?: string;
  defaultModel: string;
}

const PROFILES: Record<ProviderId, ProviderProfile> = {
  groq: {
    label: 'Groq',
    keyVar: 'GROQ_API_KEY',
    baseUrlVar: 'GROQ_BASE_URL',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
  },
  openai: {
    label: 'OpenAI',
    keyVar: 'OPENAI_API_KEY',
    baseUrlVar: 'OPENAI_BASE_URL',
    defaultModel: 'gpt-4.1-mini',
  },
};

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  hasKey: boolean;
  keyVar: string;
}

type Env = Record<string, string | undefined>;

export function readProviderConfig(env: Env = process.env): ProviderConfig {
  const id = (env.LLM_PROVIDER ?? 'groq').toLowerCase();
  const provider: ProviderId = id in PROFILES ? (id as ProviderId) : 'groq';
  const profile = PROFILES[provider];

  return {
    provider,
    model: env.LLM_MODEL?.trim() || profile.defaultModel,
    hasKey: Boolean(env[profile.keyVar]?.trim()),
    keyVar: profile.keyVar,
  };
}

/**
 * Whether a real discovery run is possible. Callers use this to degrade with a
 * clear message rather than a stack trace: everything except discovery works
 * without a key, and a reviewer with no key should be told that, once.
 */
export function hasLlmCredentials(env: Env = process.env): boolean {
  return readProviderConfig(env).hasKey;
}

export function createProviderFromEnv(env: Env = process.env): LlmProvider {
  const id = (env.LLM_PROVIDER ?? 'groq').toLowerCase();
  if (!(id in PROFILES)) {
    throw new Error(
      `Unknown LLM_PROVIDER "${id}". Supported: ${Object.keys(PROFILES).join(', ')}.`,
    );
  }

  const profile = PROFILES[id as ProviderId];
  const apiKey = env[profile.keyVar]?.trim();
  if (!apiKey) {
    throw new Error(
      `${profile.label} needs ${profile.keyVar}. Run "npm run set-key" to add it to .env, ` +
        'then "npm run env -- --ping" to confirm it works.',
    );
  }

  const effort = env.LLM_REASONING_EFFORT?.trim().toLowerCase();

  return createOpenAiCompatibleProvider({
    name: profile.label,
    apiKey,
    model: env.LLM_MODEL?.trim() || profile.defaultModel,
    baseUrl: env[profile.baseUrlVar]?.trim() || profile.defaultBaseUrl,
    reasoningEffort:
      effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined,
  });
}
