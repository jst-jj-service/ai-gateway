export interface UpstreamKey {
  name: string;
  apiKey: string;
  group: string;
  rate: number;
  models: string[];
}

export const DEFAULT_UPSTREAM_KEYS: UpstreamKey[] = [
  {
    name: 'GPT007',
    apiKey: 'sk-d0db48ab1df2eff985afb32c3c7f12e86b1c12ffa653fbf187944830053b0ce6',
    group: 'GPT Starter | 0.07x',
    rate: 0.07,
    models: [
      'gpt-4o-mini'
    ]
  },
  {
    name: 'GPT016',
    apiKey: 'sk-ee6a1c068497fd6127f1e53c6c80a3fe711513dcbb54c8db6e2cdf1f851f5653',
    group: 'GPT Plus | 0.16x',
    rate: 0.16,
    models: [
      'gpt-4o',
      'chatgpt-4o-latest'
    ]
  },
  {
    name: 'GPT020',
    apiKey: 'sk-4b241e4bcef324c48cee39d8f4643d1451456217b401b0d088fefc6011cfb931',
    group: 'GPT Pro | 0.20x',
    rate: 0.20,
    models: [
      'sol',
      'gpt-5.6-sol',
      'o1-mini',
      'o1-preview'
    ]
  },
  {
    name: 'GPT030',
    apiKey: 'sk-910394158ac1cb03ee4899c8fa8d4055e4a6b651b9e9edeb0a6599accc17f29f',
    group: 'GPT Pro Flagship | 0.30x',
    rate: 0.30,
    models: [
      'astra',
      'gpt-6-astra',
      'o1',
      'o1-2024-12-17',
      'o3-mini',
      'gpt-4o-realtime-preview'
    ]
  },
  {
    name: 'Claude0.13',
    apiKey: 'sk-531091eb31daa8d83752916b32e4cd0bf01158a037f9d5cbd4a0c684c101c406',
    group: 'Opus 5 | 0.13x',
    rate: 0.13,
    models: [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-opus-5'
    ]
  },
  {
    name: 'Claude1.6x',
    apiKey: 'sk-a19db913a562633ee3684d1413600b21be8f9cb3035de6a749d79f4829d24465',
    group: 'Claude Max | 1.6x',
    rate: 1.60,
    models: [
      'claude-3-5-sonnet-20241022',
      'claude-opus-5'
    ]
  }
];

export const MODEL_ALIASES: Record<string, string> = {
  'claude-3.5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3.5-haiku': 'claude-3-5-haiku-20241022',
  'claude-3-opus': 'claude-3-opus-20240229',
  'claude-3.0-opus': 'claude-3-opus-20240229',
  'claude-3.5-opus': 'claude-opus-5',
  'claude-opus': 'claude-opus-5',
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
 * Normalizes model names by resolving aliases and trimming whitespace.
 */
export function normalizeModelAlias(rawModel: string): string {
  if (!rawModel || typeof rawModel !== 'string') return '';
  const cleaned = rawModel.trim().toLowerCase();
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
  const raw = model.trim().toLowerCase();
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
 * Selects the optimal (lowest rate) upstream key for a given model.
 * If no configured key matches, falls back to fallbackApiKey if provided, or null.
 */
export function selectKeyForModel(
  model: string,
  keys: UpstreamKey[] = DEFAULT_UPSTREAM_KEYS,
  fallbackApiKey?: string
): UpstreamKey | null {
  if (!keys || keys.length === 0) {
    if (fallbackApiKey) {
      return {
        name: 'DefaultFallback',
        apiKey: fallbackApiKey,
        group: 'Default',
        rate: 1.0,
        models: ['*']
      };
    }
    return null;
  }

  // Find all matching keys
  const matchingKeys = keys.filter(key => keySupportsModel(key, model));

  if (matchingKeys.length > 0) {
    // Sort by rate ascending (lowest rate first)
    matchingKeys.sort((a, b) => a.rate - b.rate);
    return matchingKeys[0];
  }

  // If no exact/pattern match, check for any wildcard '*' key
  const wildcardKey = keys.find(key => key.models.includes('*'));
  if (wildcardKey) return wildcardKey;

  // If fallback API key is provided, use it
  if (fallbackApiKey) {
    return {
      name: 'DefaultFallback',
      apiKey: fallbackApiKey,
      group: 'Default',
      rate: 1.0,
      models: ['*']
    };
  }

  // If model is completely unrecognized and no fallback key, return null
  return null;
}
