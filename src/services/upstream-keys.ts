export interface UpstreamKey {
  name: string;
  apiKey: string;
  group: string;
  rate: number;
  stability: 'economy' | 'standard' | 'high_stability';
  models: string[];
}

export const DEFAULT_UPSTREAM_KEYS: UpstreamKey[] = [
  {
    name: 'GPT007',
    apiKey: 'sk-d0db48ab1df2eff985afb32c3c7f12e86b1c12ffa653fbf187944830053b0ce6',
    group: 'GPT Starter | 0.16x',
    rate: 0.1625,
    stability: 'economy',
    models: [
      'gpt-4o-mini',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-6-astra',
      'astra',
      'gpt-5.6-sol',
      'sol',
      'gpt-5.6-terra',
      'terra',
      'gpt-5.6-luna',
      'gpt-6-luna',
      'luna',
      'gpt-6-sol',
      'gpt-6.1-sol',
      'gpt-6',
      'codex-auto-review',
      'gpt-5.3-codex-spark'
    ]
  },
  {
    name: 'GPT016',
    apiKey: 'sk-ee6a1c068497fd6127f1e53c6c80a3fe711513dcbb54c8db6e2cdf1f851f5653',
    group: 'GPT Plus | 0.325x',
    rate: 0.325,
    stability: 'standard',
    models: [
      'gpt-4o',
      'chatgpt-4o-latest',
      'gpt-5.6',
      'gpt-5.2',
      'gpt-5.2-chat-latest',
      'gpt-5.4-2026-03-05',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-6-astra',
      'astra',
      'gpt-5.6-sol',
      'sol',
      'gpt-5.6-terra',
      'terra',
      'gpt-5.6-luna',
      'gpt-6-luna',
      'luna',
      'gpt-6',
      'gpt-6-sol',
      'gpt-6.1-sol',
      'codex-auto-review',
      'gpt-5.3-codex-spark'
    ]
  },
  {
    name: 'GPT020',
    apiKey: 'sk-4b241e4bcef324c48cee39d8f4643d1451456217b401b0d088fefc6011cfb931',
    group: 'GPT Pro | 0.45x',
    rate: 0.45,
    stability: 'high_stability',
    models: [
      'sol',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'terra',
      'gpt-5.6-luna',
      'gpt-6-luna',
      'luna',
      'gpt-6-sol',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'astra',
      'gpt-6',
      'o1-mini',
      'o1-preview',
      'gpt-5.2',
      'gpt-5.4',
      'gpt-5.5',
      'gpt-4o',
      'codex-auto-review'
    ]
  },
  {
    name: 'GPT030',
    apiKey: 'sk-910394158ac1cb03ee4899c8fa8d4055e4a6b651b9e9edeb0a6599accc17f29f',
    group: 'GPT Flagship Pro | 0.45x',
    rate: 0.45,
    stability: 'high_stability',
    models: [
      'astra',
      'gpt-6-astra',
      'gpt-6',
      'gpt-6-luna',
      'luna',
      'gpt-6-sol',
      'gpt-6.1-sol',
      'gpt-5.6-sol',
      'sol',
      'gpt-5.6-terra',
      'terra',
      'gpt-5.6-luna',
      'gpt-5.6',
      'gpt-5.5',
      'o1',
      'o1-2024-12-17',
      'o3-mini',
      'gpt-4o-realtime-preview',
      'codex-auto-review'
    ]
  },
  {
    name: 'Claude0.13',
    apiKey: 'sk-531091eb31daa8d83752916b32e4cd0bf01158a037f9d5cbd4a0c684c101c406',
    group: 'Claude Standard | 0.24x',
    rate: 0.24,
    stability: 'economy',
    models: [
      'fable',
      'claude-fable',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-fable-5.1',
      'claude-opus-5',
      'claude-opus',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-sonnet',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-5-haiku-20241022',
      'claude-3-5-haiku'
    ]
  },
  {
    name: 'Claude1.6x',
    apiKey: 'sk-a19db913a562633ee3684d1413600b21be8f9cb3035de6a749d79f4829d24465',
    group: 'Claude Max | 3.00x',
    rate: 3.00,
    stability: 'high_stability',
    models: [
      'claude-3-7-sonnet-20250219',
      'claude-3-7-sonnet',
      'claude-3.7-sonnet',
      'claude-3-5-sonnet-20241022',
      'claude-3.5-sonnet',
      'claude-3-5-sonnet-20240620',
      'claude-3-5-haiku-20241022',
      'claude-3.5-haiku',
      'claude-opus-5',
      'claude-opus',
      'claude-opus-latest',
      'claude-sonnet-5',
      'claude-sonnet',
      'claude-fable-5',
      'claude-fable',
      'fable',
      'claude-sonnet-5-5',
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-max'
    ]
  }
];

export const MODEL_ALIASES: Record<string, string> = {
  'astra': 'gpt-6-astra',
  'sol': 'gpt-5.6-sol',
  'terra': 'gpt-5.6-terra',
  'fable': 'claude-fable-5',
  'claude-fable': 'claude-fable-5',
  'luna': 'gpt-5.6-luna',
  'claude-3.7-sonnet': 'claude-3-7-sonnet-20250219',
  'claude-3-7-sonnet': 'claude-3-7-sonnet-20250219',
  'claude-3-7-sonnet-latest': 'claude-3-7-sonnet-20250219',
  'claude-3.5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
  'claude-3.5-haiku': 'claude-3-5-haiku-20241022',
  'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
  'claude-3-5-haiku-latest': 'claude-3-5-haiku-20241022',
  'claude-3-opus': 'claude-3-opus-20240229',
  'claude-3.0-opus': 'claude-3-opus-20240229',
  'claude-3.5-opus': 'claude-opus-5',
  'claude-opus': 'claude-opus-5',
  'claude-opus-latest': 'claude-opus-5',
  'claude-sonnet': 'claude-sonnet-5',
  'claude-haiku': 'claude-haiku-4-5',
  'chatgpt-4o': 'chatgpt-4o-latest',
  'o1': 'o1-2024-12-17'
};

/**
 * Strips date / snapshot suffixes such as -2024-08-06 or -0125 from model names.
 */
export function stripDateSuffix(model: string): string {
  if (!model || typeof model !== 'string') return '';
  return model.replace(/(-\d{4}-\d{2}-\d{2}|-\d{4})$/, '');
}

/**
 * Parses model name and optional pool preference (e.g. "astra:stable", "sol:economy", "gpt-4o:plus").
 */
export function parseModelAndPoolPreference(rawModel: string): { cleanModel: string; preferredPool?: string } {
  if (!rawModel) return { cleanModel: '' };
  const trimmed = rawModel.trim();
  const parts = trimmed.split(':');
  if (parts.length === 2) {
    const base = parts[0].trim();
    const tag = parts[1].trim().toLowerCase();
    if (['stable', 'flagship', 'pro', 'plus', 'economy', 'starter', 'max', 'standard'].includes(tag)) {
      return { cleanModel: base, preferredPool: tag };
    }
  }
  return { cleanModel: trimmed };
}

/**
 * Normalizes model names by resolving aliases and trimming whitespace.
 */
export function normalizeModelAlias(rawModel: string): string {
  if (!rawModel || typeof rawModel !== 'string') return '';
  const { cleanModel } = parseModelAndPoolPreference(rawModel);
  const cleaned = cleanModel.trim().toLowerCase();
  return MODEL_ALIASES[cleaned] || cleaned;
}

/**
 * Checks whether a given model string matches an upstream key pattern.
 */
export function matchesModelPattern(pattern: string, model: string): boolean {
  const p = pattern.toLowerCase().trim();
  const m = model.toLowerCase().trim();
  if (p === m) return true;
  if (p.endsWith('*')) {
    const prefix = p.slice(0, -1);
    return m.startsWith(prefix);
  }
  return false;
}

/**
 * Checks if an upstream key supports the requested model (considering raw, normalized, and date-stripped base names).
 */
export function keySupportsModel(key: UpstreamKey, model: string): boolean {
  if (!model) return false;
  const { cleanModel } = parseModelAndPoolPreference(model);
  const raw = cleanModel.trim().toLowerCase();
  const normalized = normalizeModelAlias(raw);
  const baseModel = stripDateSuffix(raw);
  const normalizedBase = normalizeModelAlias(baseModel);

  const candidates = [raw, normalized, baseModel, normalizedBase];

  for (const pattern of key.models) {
    for (const candidate of candidates) {
      if (matchesModelPattern(pattern, candidate)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns candidate keys for a model ordered by priority / rate with optional stability preference.
 * Enables seamless automatic failover if lower-tier channels are temporarily offline.
 */
export function getOrderedKeysForModel(
  model: string,
  keys: UpstreamKey[] = DEFAULT_UPSTREAM_KEYS,
  preferredPool?: string,
  fallbackApiKey?: string
): UpstreamKey[] {
  if (!keys || keys.length === 0) {
    if (fallbackApiKey) {
      return [{
        name: 'DefaultFallback',
        apiKey: fallbackApiKey,
        group: 'Default',
        rate: 1.0,
        stability: 'standard',
        models: ['*']
      }];
    }
    return [];
  }

  const { cleanModel, preferredPool: modelPreferredPool } = parseModelAndPoolPreference(model);
  const pool = (preferredPool || modelPreferredPool || '').toLowerCase();

  const matchingKeys = keys.filter(key => keySupportsModel(key, cleanModel));

  if (pool) {
    matchingKeys.sort((a, b) => {
      const aIsStable = (pool === 'stable' || pool === 'flagship') ? (a.stability === 'high_stability') : (a.name.toLowerCase().includes(pool) || a.group.toLowerCase().includes(pool));
      const bIsStable = (pool === 'stable' || pool === 'flagship') ? (b.stability === 'high_stability') : (b.name.toLowerCase().includes(pool) || b.group.toLowerCase().includes(pool));
      if (aIsStable && !bIsStable) return -1;
      if (!aIsStable && bIsStable) return 1;
      return a.rate - b.rate;
    });
  } else {
    // Default: Sort by rate ascending (lowest rate first, with automatic failover to stable)
    matchingKeys.sort((a, b) => a.rate - b.rate);
  }

  if (matchingKeys.length === 0) {
    const wildcardKey = keys.find(key => key.models.includes('*'));
    if (wildcardKey) return [wildcardKey];
    if (fallbackApiKey) {
      return [{
        name: 'DefaultFallback',
        apiKey: fallbackApiKey,
        group: 'Default',
        rate: 1.0,
        stability: 'standard',
        models: ['*']
      }];
    }
  }

  return matchingKeys;
}

/**
 * Selects the optimal upstream key for a given model.
 */
export function selectKeyForModel(
  model: string,
  keys: UpstreamKey[] = DEFAULT_UPSTREAM_KEYS,
  fallbackApiKey?: string,
  preferredPool?: string
): UpstreamKey | null {
  const list = getOrderedKeysForModel(model, keys, preferredPool, fallbackApiKey);
  return list.length > 0 ? list[0] : null;
}
