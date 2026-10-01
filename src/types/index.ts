export type Role = 'USER' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKey {
  id: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  userId: string;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface Cdk {
  id: string;
  code: string;
  tokenQuota: bigint;
  tier: string;
  isRedeemed: boolean;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface CdkRedemption {
  id: string;
  cdkId: string;
  userId: string;
  tokensAdded: bigint;
  redeemedAt: Date;
}

export interface UserQuota {
  id: string;
  userId: string;
  totalTokens: bigint;
  usedTokens: bigint;
  cachedTokens: bigint;
  remainingTokens: bigint;
  updatedAt: Date;
}

export interface UsageRecord {
  id: string;
  userId: string;
  apiKeyId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  deductedTokens?: number;
  rateMultiplier?: number;
  requestDurationMs: number;
  statusCode: number;
  isStream: boolean;
  createdAt: Date;
  upstreamGroup?: string;
  upstreamKeyName?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  apiKeyId?: string;
}

// Token usage response for dashboard
export interface FormattedTokenUsage {
  totalTokens: number;
  totalTokensFormatted: string; // e.g., "2.45M"
  usedTokens: number;
  usedTokensFormatted: string;
  remainingTokens: number;
  remainingTokensFormatted: string;
  cachedTokens: number;
  cachedTokensFormatted: string;
  promptTokens: number;
  promptTokensFormatted: string;
  completionTokens: number;
  completionTokensFormatted: string;
  percentUsed: number;
  cacheHitRatio: number; // percentage of prompt tokens that were cached
}

// Error Sanitizer response format
export interface SanitizedGatewayError {
  error: {
    message: string;
    type: string;
    code: string;
    param?: string | null;
    status: number;
    suggestion?: string;
  };
}

// OpenAI Chat Completion Types (abbreviated / standard)
export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | unknown;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface QuotaReservation {
  success: boolean;
  reservationId: string;
  reservedTokens: number;
  remainingTokens: bigint;
}

export interface TokenUsageDetails {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatCompletionMessage;
    finish_reason: string | null;
  }>;
  usage?: TokenUsageDetails;
}

export interface SystemStats {
  totalUsers: number;
  activeUsers: number;
  totalApiKeys: number;
  activeApiKeys: number;
  totalTokensRedeemed: number;
  totalTokensUsed: number;
  totalTokensRemaining: number;
  totalRequests: number;
  totalCdks: number;
  redeemedCdks: number;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  quota: {
    totalTokens: number;
    usedTokens: number;
    remainingTokens: number;
    cachedTokens: number;
  };
  apiKeysCount: number;
  requestCount: number;
}

