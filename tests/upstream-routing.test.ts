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

  // Test 3: Cheapest key selection for gpt-4o-mini (GPT007 @ 0.07x)
  const miniKey = selectKeyForModel('gpt-4o-mini');
  assert.ok(miniKey);
  assert.strictEqual(miniKey?.name, 'GPT007');
  assert.strictEqual(miniKey?.rate, 0.07);

  // Test 4: Cheapest key selection for gpt-4o (GPT016 @ 0.16x)
  const gpt4oKey = selectKeyForModel('gpt-4o');
  assert.ok(gpt4oKey);
  assert.strictEqual(gpt4oKey?.name, 'GPT016');
  assert.strictEqual(gpt4oKey?.rate, 0.16);

  // Test 5: Cheapest key for Claude 3.5 Sonnet (Claude0.13 @ 0.13x beats Claude1.6x @ 1.60x)
  const sonnetKey = selectKeyForModel('claude-3-5-sonnet-20241022');
  assert.ok(sonnetKey);
  assert.strictEqual(sonnetKey?.name, 'Claude0.13');
  assert.strictEqual(sonnetKey?.rate, 0.13);

  // Test 6: Alias normalization routing (claude-3.5-sonnet -> Claude0.13 @ 0.13x)
  const sonnetAliasKey = selectKeyForModel('claude-3.5-sonnet');
  assert.ok(sonnetAliasKey);
  assert.strictEqual(sonnetAliasKey?.name, 'Claude0.13');
  assert.strictEqual(sonnetAliasKey?.rate, 0.13);

  // Test 7: Chatgpt-4o latest routing (GPT016 @ 0.16x)
  const chatGptKey = selectKeyForModel('chatgpt-4o');
  assert.ok(chatGptKey);
  assert.strictEqual(chatGptKey?.name, 'GPT016');
  assert.strictEqual(chatGptKey?.rate, 0.16);

  // Test 8: Sol reasoning routing (GPT020 @ 0.20x)
  const solKey = selectKeyForModel('sol');
  assert.ok(solKey);
  assert.strictEqual(solKey?.name, 'GPT020');
  assert.strictEqual(solKey?.rate, 0.20);

  // Test 9: Astra flagship routing (GPT030 @ 0.30x)
  const astraKey = selectKeyForModel('astra');
  assert.ok(astraKey);
  assert.strictEqual(astraKey?.name, 'GPT030');
  assert.strictEqual(astraKey?.rate, 0.30);

  // Test 10: Flagship realtime routing (GPT030 @ 0.30x)
  const realtimeKey = selectKeyForModel('gpt-4o-realtime-preview');
  assert.ok(realtimeKey);
  assert.strictEqual(realtimeKey?.name, 'GPT030');
  assert.strictEqual(realtimeKey?.rate, 0.30);

  // Test 10: Fallback API key for completely custom/unknown model
  const fallbackKey = selectKeyForModel('my-custom-model-x', [], 'sk-custom-fallback-key');
  assert.ok(fallbackKey);
  assert.strictEqual(fallbackKey?.apiKey, 'sk-custom-fallback-key');

  // Test 11: Date snapshot model routing (gpt-4o-2024-08-06 -> GPT016 @ 0.16x)
  const gpt4oDatedKey = selectKeyForModel('gpt-4o-2024-08-06');
  assert.ok(gpt4oDatedKey);
  assert.strictEqual(gpt4oDatedKey?.name, 'GPT016');
  assert.strictEqual(gpt4oDatedKey?.rate, 0.16);

  // Test 12: o1-mini snapshot routing (o1-mini-2024-09-12 -> GPT020 @ 0.20x)
  const o1MiniDatedKey = selectKeyForModel('o1-mini-2024-09-12');
  assert.ok(o1MiniDatedKey);
  assert.strictEqual(o1MiniDatedKey?.name, 'GPT020');
  assert.strictEqual(o1MiniDatedKey?.rate, 0.20);

  // Test 13: o1-preview snapshot routing (o1-preview-2024-09-12 -> GPT020 @ 0.20x)
  const o1PreviewDatedKey = selectKeyForModel('o1-preview-2024-09-12');
  assert.ok(o1PreviewDatedKey);
  assert.strictEqual(o1PreviewDatedKey?.name, 'GPT020');
  assert.strictEqual(o1PreviewDatedKey?.rate, 0.20);

  // Test 14: o3-mini routing (GPT030 @ 0.30x)
  const o3MiniKey = selectKeyForModel('o3-mini');
  assert.ok(o3MiniKey);
  assert.strictEqual(o3MiniKey?.name, 'GPT030');
  assert.strictEqual(o3MiniKey?.rate, 0.30);

  // Test 15: Unrecognized model without fallback returns null
  const unrecKey = selectKeyForModel('completely-unknown-custom-model-abc');
  assert.strictEqual(unrecKey, null);

  console.log('✓ Multi-Key Intelligent Model Routing tests passed successfully!');
}
