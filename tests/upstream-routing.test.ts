import assert from 'assert';
import {
  DEFAULT_UPSTREAM_KEYS,
  normalizeModelAlias,
  selectKeyForModel,
  matchesModelPattern,
  keySupportsModel
} from '../src/services/upstream-keys';

export async function runUpstreamRoutingTests() {
  console.log('▶ Testing Multi-Key Intelligent Model Routing...');

  // Test 1: Model Alias Normalization
  assert.strictEqual(normalizeModelAlias('claude-3.5-sonnet'), 'claude-3-5-sonnet-20241022');
  assert.strictEqual(normalizeModelAlias('claude-3.5-haiku'), 'claude-3-5-haiku-20241022');
  assert.strictEqual(normalizeModelAlias('claude-3-opus'), 'claude-3-opus-20240229');
  assert.strictEqual(normalizeModelAlias('chatgpt-4o'), 'chatgpt-4o-latest');
  assert.strictEqual(normalizeModelAlias('o1'), 'o1-2024-12-17');
  assert.strictEqual(normalizeModelAlias('  gpt-4o  '), 'gpt-4o');

  // Test 2: Wildcard Pattern Matching
  assert.strictEqual(matchesModelPattern('claude-*', 'claude-3-5-sonnet-20241022'), true);
  assert.strictEqual(matchesModelPattern('claude-*', 'gpt-4o'), false);
  assert.strictEqual(matchesModelPattern('text-embedding-3-*', 'text-embedding-3-small'), true);
  assert.strictEqual(matchesModelPattern('text-embedding-3-*', 'text-embedding-3-large'), true);

  // Test 3: Cheapest key selection for gpt-4o-mini (GPT007 @ 0.1625x)
  const miniKey = selectKeyForModel('gpt-4o-mini');
  assert.ok(miniKey);
  assert.strictEqual(miniKey?.name, 'GPT007');
  assert.strictEqual(miniKey?.rate, 0.1625);

  // Test 4: Cheapest key selection for gpt-4o (GPT016 @ 0.325x)
  const gpt4oKey = selectKeyForModel('gpt-4o');
  assert.ok(gpt4oKey);
  assert.strictEqual(gpt4oKey?.name, 'GPT016');
  assert.strictEqual(gpt4oKey?.rate, 0.325);

  // Test 5: Key for Claude Opus 5 (Claude0.13 @ 0.24x)
  const opusKey = selectKeyForModel('claude-opus-5');
  assert.ok(opusKey);
  assert.strictEqual(opusKey?.name, 'Claude0.13');
  assert.strictEqual(opusKey?.rate, 0.24);

  // Test 6: Key for Claude 3.7 Sonnet (Claude1.6x @ 3.00x)
  const sonnetKey = selectKeyForModel('claude-3-7-sonnet-20250219');
  assert.ok(sonnetKey);
  assert.strictEqual(sonnetKey?.name, 'Claude1.6x');
  assert.strictEqual(sonnetKey?.rate, 3.00);

  // Test 7: Alias normalization routing (claude-3.7-sonnet -> Claude1.6x @ 3.00x)
  const sonnetAliasKey = selectKeyForModel('claude-3.7-sonnet');
  assert.ok(sonnetAliasKey);
  assert.strictEqual(sonnetAliasKey?.name, 'Claude1.6x');
  assert.strictEqual(sonnetAliasKey?.rate, 3.00);

  // Test 8: Fable alias routing (fable -> Claude0.13 @ 0.24x)
  const fableKey = selectKeyForModel('fable');
  assert.ok(fableKey);
  assert.strictEqual(fableKey?.name, 'Claude0.13');
  assert.strictEqual(fableKey?.rate, 0.24);

  // Test 9: Chatgpt-4o latest routing (GPT016 @ 0.325x)
  const chatGptKey = selectKeyForModel('chatgpt-4o');
  assert.ok(chatGptKey);
  assert.strictEqual(chatGptKey?.name, 'GPT016');
  assert.strictEqual(chatGptKey?.rate, 0.325);

  // Test 10: Sol reasoning routing (GPT020 @ 0.45x)
  const solKey = selectKeyForModel('sol');
  assert.ok(solKey);
  assert.strictEqual(solKey?.name, 'GPT020');
  assert.strictEqual(solKey?.rate, 0.45);

  // Test 11: Astra flagship routing (GPT030 @ 0.45x)
  const astraKey = selectKeyForModel('astra');
  assert.ok(astraKey);
  assert.strictEqual(astraKey?.name, 'GPT030');
  assert.strictEqual(astraKey?.rate, 0.45);

  // Test 12: Flagship realtime routing (GPT030 @ 0.45x)
  const realtimeKey = selectKeyForModel('gpt-4o-realtime-preview');
  assert.ok(realtimeKey);
  assert.strictEqual(realtimeKey?.name, 'GPT030');
  assert.strictEqual(realtimeKey?.rate, 0.45);

  // Test 13: Fallback API key for completely custom/unknown model
  const fallbackKey = selectKeyForModel('my-custom-model-x', [], 'sk-custom-fallback-key');
  assert.ok(fallbackKey);
  assert.strictEqual(fallbackKey?.apiKey, 'sk-custom-fallback-key');

  // Test 14: Date snapshot model routing (gpt-4o-2024-08-06 -> GPT016 @ 0.325x)
  const gpt4oDatedKey = selectKeyForModel('gpt-4o-2024-08-06');
  assert.ok(gpt4oDatedKey);
  assert.strictEqual(gpt4oDatedKey?.name, 'GPT016');
  assert.strictEqual(gpt4oDatedKey?.rate, 0.325);

  // Test 15: o1-mini snapshot routing (o1-mini-2024-09-12 -> GPT020 @ 0.45x)
  const o1MiniDatedKey = selectKeyForModel('o1-mini-2024-09-12');
  assert.ok(o1MiniDatedKey);
  assert.strictEqual(o1MiniDatedKey?.name, 'GPT020');
  assert.strictEqual(o1MiniDatedKey?.rate, 0.45);

  // Test 16: o3-mini routing (GPT030 @ 0.45x)
  const o3MiniKey = selectKeyForModel('o3-mini');
  assert.ok(o3MiniKey);
  assert.strictEqual(o3MiniKey?.name, 'GPT030');
  assert.strictEqual(o3MiniKey?.rate, 0.45);

  // Test 17: Unrecognized model without fallback returns null
  const unrecKey = selectKeyForModel('completely-unknown-custom-model-abc');
  assert.strictEqual(unrecKey, null);
  assert.strictEqual(unrecKey, null);

  console.log('✓ Multi-Key Intelligent Model Routing tests passed successfully!');
}
