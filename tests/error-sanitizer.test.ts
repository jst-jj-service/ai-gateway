import assert from 'assert';
import { ErrorSanitizerService } from '../src/services/error-sanitizer.service';
import { SseStreamParser } from '../src/utils/sse-parser';

export async function runErrorSanitizerTests() {
  console.log('▶ Testing Error Sanitizer Service & Stream Interception...');

  // Test 1: Upstream 500/502/503 masked cleanly
  const res500 = ErrorSanitizerService.sanitize(500, 'Upstream internal crash: database connection failed at 10.0.0.5');
  assert.strictEqual(res500.statusCode, 502);
  assert.strictEqual(res500.payload.error.code, 'upstream_service_unavailable');
  assert.strictEqual(res500.payload.error.message.includes('database'), false, 'Leaked database error in message');
  assert.strictEqual(res500.payload.error.message.includes('10.0.0.5'), false, 'Leaked internal IP in message');
  assert.ok(res500.payload.error.suggestion, 'Should provide actionable suggestion');

  // Test 2: Upstream 401/403 hides upstream secret failure
  const res401 = ErrorSanitizerService.sanitize(401, 'Invalid API Key sk-proj-super-secret-master-upstream-key');
  assert.strictEqual(res401.statusCode, 502);
  assert.strictEqual(res401.payload.error.code, 'upstream_auth_failure');
  assert.strictEqual(res401.payload.error.message.includes('sk-proj'), false, 'Leaked upstream API key');

  // Test 3: Upstream 429 Rate Limit
  const res429 = ErrorSanitizerService.sanitize(429, 'Rate limit exceeded on upstream tier');
  assert.strictEqual(res429.statusCode, 429);
  assert.strictEqual(res429.payload.error.code, 'upstream_rate_limited');
  assert.ok(res429.payload.error.suggestion?.includes('wait'), 'Should suggest waiting');

  // Test 4: Network connection refused / fetch failed
  const netErr = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:8080');
  const resNet = ErrorSanitizerService.sanitize(netErr);
  assert.strictEqual(resNet.statusCode, 502);
  assert.strictEqual(resNet.payload.error.code, 'gateway_upstream_unreachable');
  assert.strictEqual(resNet.payload.error.message.includes('127.0.0.1'), false, 'Leaked IP address');

  // Test 5: Timeout Error
  const timeoutErr = new Error('Request timed out: AbortSignal triggered');
  const resTimeout = ErrorSanitizerService.sanitize(timeoutErr);
  assert.strictEqual(resTimeout.statusCode, 504);
  assert.strictEqual(resTimeout.payload.error.code, 'request_timeout');
  assert.ok(resTimeout.payload.error.suggestion?.includes('shorter prompt'), 'Suggest shorter prompt on timeout');

  // Test 6: Quota Exhausted Error
  const quotaErr = ErrorSanitizerService.quotaExhaustedError('https://my-shop.com');
  assert.strictEqual(quotaErr.statusCode, 402);
  assert.strictEqual(quotaErr.payload.error.code, 'insufficient_quota');
  assert.ok(quotaErr.payload.error.suggestion?.includes('https://my-shop.com'), 'Should link to shop');

  // Test 7: Sensitive Text Masking (scrubSensitiveText)
  const rawLeak = 'Error connecting to https://upstream-secret-ai.internal/v1 using sk-1234567890abcdef123456 and Bearer sk-admin-secret-token';
  const scrubbed = ErrorSanitizerService.scrubSensitiveText(rawLeak);
  assert.strictEqual(scrubbed.includes('sk-1234567890abcdef'), false, 'Failed to mask API key');
  assert.strictEqual(scrubbed.includes('sk-admin-secret'), false, 'Failed to mask Bearer token');
  assert.strictEqual(scrubbed.includes('upstream-secret-ai.internal'), false, 'Failed to mask internal URL');

  // Test 8: In-band SSE Stream Error Sanitization
  const parser = new SseStreamParser();
  const rawErrorChunk = 'data: {"error":{"message":"Rate limit exceeded for account 888 at https://upstream-ai.com","code":"upstream_limit"}}\n\n';
  const { forwardChunk } = parser.feed(rawErrorChunk);

  assert.strictEqual(parser.hasError, true, 'Parser should detect error inside SSE chunk');
  assert.strictEqual(forwardChunk.includes('upstream-ai.com'), false, 'Leaked upstream URL in SSE stream');
  assert.strictEqual(forwardChunk.includes('account 888'), false, 'Leaked account details in SSE stream');
  assert.strictEqual(forwardChunk.includes('upstream_stream_error'), true, 'Should convert to safe stream error type');

  // Test 9: CRLF SSE handling
  const parserCrlf = new SseStreamParser();
  const crlfChunk = 'data: {"choices":[{"delta":{"content":"Hello world"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const crlfResult = parserCrlf.feed(crlfChunk);
  assert.strictEqual(parserCrlf.isDone, true, 'Should successfully process [DONE] with CRLF line endings');
  assert.strictEqual(crlfResult.forwardChunk.includes('\r'), false, 'Should normalize away carriage returns');

  // Test 10: Zero-leak scrubbing of hzapi.vip, database URIs, local paths, and prompt contents
  const leakText = `Fatal: failed to connect to https://api.hzapi.vip/v1/chat/completions with DATABASE_URL postgresql://gateway:gateway_pass@127.0.0.1:5432/ai_gateway and path C:\\Users\\user\\Documents\\AIGateway\\packages\\api\\dev.db while processing prompt "messages": [{"role":"user","content":"super secret user query"}]`;
  const scrubbedLeak = ErrorSanitizerService.scrubSensitiveText(leakText);

  assert.strictEqual(scrubbedLeak.includes('hzapi.vip'), false, 'Masked hzapi.vip');
  assert.strictEqual(scrubbedLeak.includes('gateway_pass'), false, 'Masked database password');
  assert.strictEqual(scrubbedLeak.includes('127.0.0.1'), false, 'Masked IP address');
  assert.strictEqual(scrubbedLeak.includes('super secret user query'), false, 'Masked user prompt content');
  assert.strictEqual(scrubbedLeak.includes('C:\\Users\\user\\Documents'), false, 'Masked file path');

  // Test 11: Scrubbing of JWT tokens, CDK codes, forward slash paths, and localhost
  const jwtSample = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzcl8xMjM0NTYiLCJyb2xlIjoiQURNSU4ifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const textWithSecrets = `Auth failed with session token ${jwtSample} for CDK-2345-6789-ABCD at C:/Users/user/Documents/AIGateway/packages/api on http://localhost:3001`;
  const scrubbedSecrets = ErrorSanitizerService.scrubSensitiveText(textWithSecrets);

  assert.strictEqual(scrubbedSecrets.includes(jwtSample), false, 'Masked JWT session token');
  assert.strictEqual(scrubbedSecrets.includes('[jwt_redacted]'), true);
  assert.strictEqual(scrubbedSecrets.includes('CDK-2345-6789-ABCD'), false, 'Masked CDK key');
  assert.strictEqual(scrubbedSecrets.includes('CDK-****-****-****'), true);
  assert.strictEqual(scrubbedSecrets.includes('C:/Users/user'), false, 'Masked forward slash path');
  assert.strictEqual(scrubbedSecrets.includes('localhost:3001'), false, 'Masked localhost');

  // Test 12: Responses API SSE Stream Token Extraction
  const responsesParser = new SseStreamParser();
  const responsesChunk1 = 'data: {"type":"response.text.delta","delta":"The quick brown fox jumps over the lazy dog."}\n\n';
  const responsesChunk2 = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":10,"total_tokens":22}}}\n\n';
  responsesParser.feed(responsesChunk1);
  assert.ok(responsesParser.estimatedCompletionTokens > 0, 'Should count completion tokens from Responses API delta text');

  responsesParser.feed(responsesChunk2);
  assert.strictEqual(responsesParser.lastUsage?.prompt_tokens, 12, 'Parsed input_tokens from response.usage');
  assert.strictEqual(responsesParser.lastUsage?.completion_tokens, 10, 'Parsed output_tokens from response.usage');
  assert.strictEqual(responsesParser.lastUsage?.total_tokens, 22, 'Parsed total_tokens from response.usage');

  console.log('✓ Error Sanitizer, Zero-Leak & SSE Stream Interception tests passed successfully!');
}
