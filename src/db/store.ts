import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { User, ApiKey, Cdk, CdkRedemption, UserQuota, UsageRecord, Role, SystemStats, AdminUserSummary } from '../types';
import { config } from '../config';

export interface IStore {
  // User operations
  createUser(data: { email: string; passwordHash: string; name?: string; role?: Role }): Promise<User>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
  getAllUsers(): Promise<User[]>;
  updateUserStatus(id: string, isActive: boolean): Promise<User>;
  updateUserPassword(id: string, newPasswordHash: string): Promise<User>;
  deleteUser(id: string): Promise<boolean>;
  getAdminUsers(): Promise<AdminUserSummary[]>;
  getSystemStats(): Promise<SystemStats>;

  // API Key operations
  createApiKey(data: { userId: string; keyHash: string; keyPrefix: string; name: string }): Promise<ApiKey>;
  getApiKeyByHash(keyHash: string): Promise<ApiKey | null>;
  getApiKeysByUserId(userId: string): Promise<ApiKey[]>;
  revokeApiKey(id: string, userId: string): Promise<boolean>;
  updateApiKeyLastUsed(id: string): Promise<void>;

  // CDK operations
  createCdk(data: { code: string; tokenQuota: bigint; tier?: string; expiresAt?: Date | null }): Promise<Cdk>;
  createCdkBatch(items: Array<{ code: string; tokenQuota: bigint; tier?: string; expiresAt?: Date | null }>): Promise<Cdk[]>;
  getCdkByCode(code: string): Promise<Cdk | null>;
  getAllCdks(): Promise<Array<Cdk & { redemption?: { userId: string; userEmail?: string; redeemedAt: Date } }>>;
  redeemCdk(code: string, userId: string): Promise<{ success: boolean; tokensAdded: bigint; error?: string }>;

  // Quota operations
  getUserQuota(userId: string): Promise<UserQuota>;
  addTokensToQuota(userId: string, tokensToAdd: bigint): Promise<UserQuota>;
  deductTokensFromQuota(userId: string, tokensUsed: number, cachedTokens: number): Promise<UserQuota>;
  reserveQuota(userId: string, tokensToReserve: number, minRequired?: number): Promise<{ success: boolean; reservationId: string; reservedTokens: number; remainingTokens: bigint }>;
  reconcileQuota(userId: string, reservationId: string, actualTokensUsed: number, cachedTokens: number, statusCode: number): Promise<UserQuota>;
  cancelReservation(reservationId: string): Promise<void>;
  close?(): void;

  // Usage operations
  recordUsage(data: {
    userId: string;
    apiKeyId?: string | null;
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
    upstreamGroup?: string;
    upstreamKeyName?: string;
  }): Promise<UsageRecord>;

  getUserUsageSummary(userId: string): Promise<{
    totalTokens: number;
    usedTokens: number;
    remainingTokens: number;
    cachedTokens: number;
    promptTokens: number;
    completionTokens: number;
    requestCount: number;
  }>;

  getUserUsageTrends(userId: string, days?: number): Promise<Array<{
    date: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    requests: number;
  }>>;

  getUserModelBreakdown(userId: string): Promise<Array<{
    model: string;
    totalTokens: number;
    cachedTokens: number;
    requests: number;
  }>>;

  getRecentUsageLogs(userId: string, limit?: number): Promise<UsageRecord[]>;
}

/**
 * High-performance store implementation with in-memory indexes and
 * robust optional JSON file-backed persistence.
 */
export class MemoryStore implements IStore {
  public static readonly MAX_GLOBAL_USAGE_RECORDS = 50000;
  public static readonly MAX_USER_USAGE_RECORDS = 1000;

  private users = new Map<string, User>();
  private usersByEmail = new Map<string, string>(); // email -> id
  private apiKeys = new Map<string, ApiKey>();
  private apiKeysByHash = new Map<string, string>(); // hash -> id
  private cdks = new Map<string, Cdk>();
  private cdksByCode = new Map<string, string>(); // code -> id
  private redemptions = new Map<string, CdkRedemption>(); // cdkId -> redemption
  private userRedemptions = new Map<string, string[]>(); // userId -> cdkIds[]
  private quotas = new Map<string, UserQuota>(); // userId -> quota
  private usageRecords: UsageRecord[] = [];
  private usageRecordsByUserId = new Map<string, UsageRecord[]>(); // userId -> records

  // CDK Redemption concurrency locks to prevent double-spend
  private activeRedemptionLocks = new Set<string>(); // cdkCode -> in-progress
  private activeUserRedemptionLocks = new Set<string>(); // userId -> in-progress

  // Quota reservation state
  private activeReservations = new Map<string, { userId: string; reservedAmount: number; timestamp: number }>();
  private reservationSweeperTimer: NodeJS.Timeout | null = null;

  private persistPath: string | null = null;
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor(persistPath: string | null = null) {
    if (persistPath) {
      this.persistPath = path.isAbsolute(persistPath)
        ? persistPath
        : path.resolve(process.cwd(), persistPath);
      this.loadFromFile();
    }

    // Sweeper to safely clean and refund orphaned reservations (e.g. client dropped without reaching reconcile)
    this.reservationSweeperTimer = setInterval(() => this.sweepExpiredReservations(), 60000);
    if (this.reservationSweeperTimer.unref) {
      this.reservationSweeperTimer.unref();
    }
  }

  private sweepExpiredReservations() {
    const now = Date.now();
    const expiryMs = 120000; // 2 minutes
    let refunded = false;
    for (const [resId, res] of this.activeReservations.entries()) {
      if (now - res.timestamp > expiryMs) {
        this.activeReservations.delete(resId);
        const quota = this.quotas.get(res.userId);
        if (quota) {
          quota.remainingTokens += BigInt(res.reservedAmount);
          quota.updatedAt = new Date();
          refunded = true;
          console.warn(`[MemoryStore] Refunded orphaned reservation ${resId} (${res.reservedAmount} tokens) for user ${res.userId}`);
        }
      }
    }
    if (refunded) {
      this.scheduleSave();
    }
  }

  private parseStoreJson(raw: string): any {
    return JSON.parse(raw, (_key, value) => {
      if (value && typeof value === 'object') {
        if (value.__bigint !== undefined) {
          return BigInt(value.__bigint);
        }
        if (value.__date !== undefined) {
          return new Date(value.__date);
        }
      }
      return value;
    });
  }

  private populateState(data: any) {
    if (Array.isArray(data.users)) {
      for (const u of data.users) {
        this.users.set(u.id, u);
        this.usersByEmail.set(u.email, u.id);
      }
    }

    if (Array.isArray(data.apiKeys)) {
      for (const k of data.apiKeys) {
        this.apiKeys.set(k.id, k);
        this.apiKeysByHash.set(k.keyHash, k.id);
      }
    }

    if (Array.isArray(data.cdks)) {
      for (const c of data.cdks) {
        this.cdks.set(c.id, c);
        this.cdksByCode.set(c.code, c.id);
      }
    }

    if (Array.isArray(data.redemptions)) {
      for (const r of data.redemptions) {
        this.redemptions.set(r.cdkId, r);
        const list = this.userRedemptions.get(r.userId) || [];
        list.push(r.cdkId);
        this.userRedemptions.set(r.userId, list);
      }
    }

    if (Array.isArray(data.quotas)) {
      for (const q of data.quotas) {
        this.quotas.set(q.userId, q);
      }
    }

    if (Array.isArray(data.usageRecords)) {
      this.usageRecords = data.usageRecords.slice(-MemoryStore.MAX_GLOBAL_USAGE_RECORDS);
      for (const r of this.usageRecords) {
        const list = this.usageRecordsByUserId.get(r.userId) || [];
        list.push(r);
        this.usageRecordsByUserId.set(r.userId, list);
      }
      for (const [userId, list] of this.usageRecordsByUserId.entries()) {
        if (list.length > MemoryStore.MAX_USER_USAGE_RECORDS) {
          this.usageRecordsByUserId.set(userId, list.slice(-MemoryStore.MAX_USER_USAGE_RECORDS));
        }
      }
    }
  }

  private loadFromFile() {
    if (!this.persistPath) {
      return;
    }

    const backupPath = `${this.persistPath}.bak`;

    // Try reading primary persist file
    if (fs.existsSync(this.persistPath)) {
      try {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        const data = this.parseStoreJson(raw);
        this.populateState(data);
        return;
      } catch (err) {
        console.warn(`[MemoryStore] Failed to load data from primary file ${this.persistPath}. Attempting backup recovery...`, err);
      }
    }

    // Try recovering from backup file if primary is corrupted or missing
    if (fs.existsSync(backupPath)) {
      try {
        const rawBackup = fs.readFileSync(backupPath, 'utf-8');
        const data = this.parseStoreJson(rawBackup);
        this.populateState(data);
        console.log(`[MemoryStore] Successfully recovered store data from backup file ${backupPath}`);
        // Restore primary from backup
        fs.copyFileSync(backupPath, this.persistPath);
      } catch (backupErr) {
        console.error(`[MemoryStore] Backup recovery from ${backupPath} also failed:`, backupErr);
      }
    }
  }

  public saveToFile() {
    if (!this.persistPath) return;

    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const payload = {
        users: Array.from(this.users.values()),
        apiKeys: Array.from(this.apiKeys.values()),
        cdks: Array.from(this.cdks.values()),
        redemptions: Array.from(this.redemptions.values()),
        quotas: Array.from(this.quotas.values()),
        usageRecords: this.usageRecords.slice(-MemoryStore.MAX_GLOBAL_USAGE_RECORDS)
      };

      const serialized = JSON.stringify(payload, (_key, value) => {
        if (typeof value === 'bigint') {
          return { __bigint: value.toString() };
        }
        if (value instanceof Date) {
          return { __date: value.toISOString() };
        }
        return value;
      }, 2);

      // Safe atomic write pattern:
      // 1. Write to temporary file with unique nonce
      const tempPath = `${this.persistPath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      const backupPath = `${this.persistPath}.bak`;

      fs.writeFileSync(tempPath, serialized, 'utf-8');

      // 2. Keep backup copy of the existing database before replacing (only if non-empty and valid)
      if (fs.existsSync(this.persistPath)) {
        try {
          const stat = fs.statSync(this.persistPath);
          if (stat.size > 10) {
            fs.copyFileSync(this.persistPath, backupPath);
          }
        } catch {
          // ignore backup copy error
        }
      }

      // 3. Atomically rename temp file to primary file
      try {
        fs.renameSync(tempPath, this.persistPath);
      } catch {
        // Fallback for Windows cross-file lock: copy then remove temp
        fs.copyFileSync(tempPath, this.persistPath);
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.error(`[MemoryStore] Failed to save store to ${this.persistPath}:`, err);
    }
  }

  private scheduleSave() {
    if (!this.persistPath) return;
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveToFile();
    }, 100);
    if (this.saveDebounceTimer.unref) {
      this.saveDebounceTimer.unref();
    }
  }

  public close() {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    if (this.reservationSweeperTimer) {
      clearInterval(this.reservationSweeperTimer);
      this.reservationSweeperTimer = null;
    }

    // Cancel & refund any active in-flight reservations on clean shutdown
    for (const [resId, res] of this.activeReservations.entries()) {
      this.activeReservations.delete(resId);
      const quota = this.quotas.get(res.userId);
      if (quota) {
        quota.remainingTokens += BigInt(res.reservedAmount);
        quota.updatedAt = new Date();
      }
    }

    this.saveToFile();
  }

  // User
  async createUser(data: { email: string; passwordHash: string; name?: string; role?: Role }): Promise<User> {
    const existingId = this.usersByEmail.get(data.email.toLowerCase());
    if (existingId) {
      throw new Error(`User with email ${data.email} already exists`);
    }

    const id = 'usr_' + crypto.randomBytes(12).toString('hex');
    const user: User = {
      id,
      email: data.email.toLowerCase(),
      passwordHash: data.passwordHash,
      name: data.name || null,
      role: data.role || 'USER',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.users.set(id, user);
    this.usersByEmail.set(user.email, id);

    // Initialize default quota (0 tokens until redeemed)
    this.quotas.set(id, {
      id: 'qta_' + crypto.randomBytes(12).toString('hex'),
      userId: id,
      totalTokens: 0n,
      usedTokens: 0n,
      cachedTokens: 0n,
      remainingTokens: 0n,
      updatedAt: new Date()
    });

    this.scheduleSave();
    return user;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const id = this.usersByEmail.get(email.toLowerCase());
    if (!id) return null;
    return this.users.get(id) || null;
  }

  async getUserById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async getAllUsers(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  async updateUserStatus(id: string, isActive: boolean): Promise<User> {
    const user = this.users.get(id);
    if (!user) {
      throw new Error(`User with ID ${id} not found`);
    }
    user.isActive = isActive;
    user.updatedAt = new Date();
    this.scheduleSave();
    return user;
  }

  async updateUserPassword(id: string, newPasswordHash: string): Promise<User> {
    const user = this.users.get(id);
    if (!user) {
      throw new Error(`User with ID ${id} not found`);
    }
    user.passwordHash = newPasswordHash;
    user.updatedAt = new Date();
    this.scheduleSave();
    return user;
  }

  async deleteUser(id: string): Promise<boolean> {
    const user = this.users.get(id);
    if (!user) return false;

    // Remove user
    this.users.delete(id);
    this.usersByEmail.delete(user.email.toLowerCase());

    // Remove API keys
    for (const [keyId, apiKey] of Array.from(this.apiKeys.entries())) {
      if (apiKey.userId === id) {
        this.apiKeys.delete(keyId);
        this.apiKeysByHash.delete(apiKey.keyHash);
      }
    }

    // Remove Quota
    this.quotas.delete(id);

    // Remove User redemptions
    this.userRedemptions.delete(id);

    // Clean active reservations
    for (const [resId, res] of Array.from(this.activeReservations.entries())) {
      if (res.userId === id) {
        this.activeReservations.delete(resId);
      }
    }

    // Remove usage records for user
    this.usageRecordsByUserId.delete(id);
    this.usageRecords = this.usageRecords.filter(r => r.userId !== id);

    this.scheduleSave();
    return true;
  }

  async getAdminUsers(): Promise<AdminUserSummary[]> {
    const results: AdminUserSummary[] = [];
    for (const user of this.users.values()) {
      const quota = this.quotas.get(user.id) || {
        id: '',
        userId: user.id,
        totalTokens: 0n,
        usedTokens: 0n,
        remainingTokens: 0n,
        cachedTokens: 0n,
        updatedAt: new Date()
      };
      const userKeys = Array.from(this.apiKeys.values()).filter(k => k.userId === user.id && k.isActive);
      const userLogs = this.usageRecordsByUserId.get(user.id) || [];

      results.push({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        quota: {
          totalTokens: Number(quota.totalTokens),
          usedTokens: Number(quota.usedTokens),
          remainingTokens: Number(quota.remainingTokens),
          cachedTokens: Number(quota.cachedTokens)
        },
        apiKeysCount: userKeys.length,
        requestCount: userLogs.length
      });
    }
    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async getSystemStats(): Promise<SystemStats> {
    const totalUsers = this.users.size;
    let activeUsers = 0;
    for (const u of this.users.values()) {
      if (u.isActive) activeUsers++;
    }

    const allKeys = Array.from(this.apiKeys.values());
    const totalApiKeys = allKeys.length;
    const activeApiKeys = allKeys.filter(k => k.isActive).length;

    let totalTokensRedeemed = 0;
    let totalTokensUsed = 0;
    let totalTokensRemaining = 0;

    for (const q of this.quotas.values()) {
      totalTokensRedeemed += Number(q.totalTokens);
      totalTokensUsed += Number(q.usedTokens);
      totalTokensRemaining += Number(q.remainingTokens);
    }

    const allCdks = Array.from(this.cdks.values());
    const totalCdks = allCdks.length;
    const redeemedCdks = allCdks.filter(c => c.isRedeemed).length;

    return {
      totalUsers,
      activeUsers,
      totalApiKeys,
      activeApiKeys,
      totalTokensRedeemed,
      totalTokensUsed,
      totalTokensRemaining,
      totalRequests: this.usageRecords.length,
      totalCdks,
      redeemedCdks
    };
  }

  // API Key
  async createApiKey(data: { userId: string; keyHash: string; keyPrefix: string; name: string }): Promise<ApiKey> {
    const id = 'key_' + crypto.randomBytes(12).toString('hex');
    const apiKey: ApiKey = {
      id,
      keyHash: data.keyHash,
      keyPrefix: data.keyPrefix,
      name: data.name,
      userId: data.userId,
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date()
    };

    this.apiKeys.set(id, apiKey);
    this.apiKeysByHash.set(data.keyHash, id);
    this.scheduleSave();
    return apiKey;
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const id = this.apiKeysByHash.get(keyHash);
    if (!id) return null;
    const key = this.apiKeys.get(id);
    if (!key || !key.isActive) return null;
    return key;
  }

  async getApiKeysByUserId(userId: string): Promise<ApiKey[]> {
    return Array.from(this.apiKeys.values()).filter(k => k.userId === userId && k.isActive);
  }

  async revokeApiKey(id: string, userId: string): Promise<boolean> {
    const key = this.apiKeys.get(id);
    if (!key || key.userId !== userId) return false;
    key.isActive = false;
    this.scheduleSave();
    return true;
  }

  async updateApiKeyLastUsed(id: string): Promise<void> {
    const key = this.apiKeys.get(id);
    if (key) {
      key.lastUsedAt = new Date();
      this.scheduleSave();
    }
  }

  // CDK
  async createCdk(data: { code: string; tokenQuota: bigint; tier?: string; expiresAt?: Date | null }): Promise<Cdk> {
    if (this.cdksByCode.has(data.code)) {
      throw new Error(`CDK code ${data.code} already exists`);
    }
    const id = 'cdk_' + crypto.randomBytes(12).toString('hex');
    const cdk: Cdk = {
      id,
      code: data.code,
      tokenQuota: data.tokenQuota,
      tier: data.tier || 'standard',
      isRedeemed: false,
      expiresAt: data.expiresAt || null,
      createdAt: new Date()
    };
    this.cdks.set(id, cdk);
    this.cdksByCode.set(data.code, id);
    this.scheduleSave();
    return cdk;
  }

  async createCdkBatch(items: Array<{ code: string; tokenQuota: bigint; tier?: string; expiresAt?: Date | null }>): Promise<Cdk[]> {
    const created: Cdk[] = [];
    for (const item of items) {
      created.push(await this.createCdk(item));
    }
    return created;
  }

  async getCdkByCode(code: string): Promise<Cdk | null> {
    const id = this.cdksByCode.get(code.trim().toUpperCase());
    if (!id) return null;
    return this.cdks.get(id) || null;
  }

  async getAllCdks(): Promise<Array<Cdk & { redemption?: { userId: string; userEmail?: string; redeemedAt: Date } }>> {
    const result: Array<Cdk & { redemption?: { userId: string; userEmail?: string; redeemedAt: Date } }> = [];
    for (const cdk of this.cdks.values()) {
      const red = this.redemptions.get(cdk.id);
      let redemptionInfo: { userId: string; userEmail?: string; redeemedAt: Date } | undefined;
      if (red) {
        const u = this.users.get(red.userId);
        redemptionInfo = {
          userId: red.userId,
          userEmail: u ? u.email : undefined,
          redeemedAt: red.redeemedAt
        };
      }
      result.push({
        ...cdk,
        redemption: redemptionInfo
      });
    }
    return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async redeemCdk(code: string, userId: string): Promise<{ success: boolean; tokensAdded: bigint; error?: string }> {
    const normalizedCode = code.trim().toUpperCase();

    // Prevent concurrent double-spend race condition across asynchronous tasks
    if (this.activeRedemptionLocks.has(normalizedCode)) {
      return { success: false, tokensAdded: 0n, error: 'CDK redemption is already in progress. Please try again.' };
    }
    if (this.activeUserRedemptionLocks.has(userId)) {
      return { success: false, tokensAdded: 0n, error: 'A redemption for this account is already in progress. Please wait a moment.' };
    }

    this.activeRedemptionLocks.add(normalizedCode);
    this.activeUserRedemptionLocks.add(userId);

    try {
      const cdkId = this.cdksByCode.get(normalizedCode);
      if (!cdkId) {
        return { success: false, tokensAdded: 0n, error: 'Invalid CDK activation code. Please check and try again.' };
      }

      const cdk = this.cdks.get(cdkId);
      if (!cdk) {
        return { success: false, tokensAdded: 0n, error: 'CDK not found.' };
      }

      if (cdk.isRedeemed) {
        return { success: false, tokensAdded: 0n, error: 'This CDK has already been redeemed.' };
      }

      if (cdk.expiresAt && cdk.expiresAt.getTime() < Date.now()) {
        return { success: false, tokensAdded: 0n, error: 'This CDK has expired.' };
      }

      if (!this.users.has(userId)) {
        return { success: false, tokensAdded: 0n, error: 'User account not found.' };
      }

      // Mark CDK as redeemed immediately and synchronously
      cdk.isRedeemed = true;

      // Create redemption record
      const redemption: CdkRedemption = {
        id: 'red_' + crypto.randomBytes(12).toString('hex'),
        cdkId: cdk.id,
        userId,
        tokensAdded: cdk.tokenQuota,
        redeemedAt: new Date()
      };
      this.redemptions.set(cdk.id, redemption);

      const userReds = this.userRedemptions.get(userId) || [];
      userReds.push(cdk.id);
      this.userRedemptions.set(userId, userReds);

      // Update user quota
      await this.addTokensToQuota(userId, cdk.tokenQuota);

      this.scheduleSave();
      return {
        success: true,
        tokensAdded: cdk.tokenQuota
      };
    } finally {
      this.activeRedemptionLocks.delete(normalizedCode);
      this.activeUserRedemptionLocks.delete(userId);
    }
  }

  // Quotas
  async getUserQuota(userId: string): Promise<UserQuota> {
    let quota = this.quotas.get(userId);
    if (!quota) {
      quota = {
        id: 'qta_' + crypto.randomBytes(12).toString('hex'),
        userId,
        totalTokens: 0n,
        usedTokens: 0n,
        cachedTokens: 0n,
        remainingTokens: 0n,
        updatedAt: new Date()
      };
      if (this.users.has(userId)) {
        this.quotas.set(userId, quota);
        this.scheduleSave();
      }
    }
    return quota;
  }

  async addTokensToQuota(userId: string, tokensToAdd: bigint): Promise<UserQuota> {
    const quota = await this.getUserQuota(userId);
    if (tokensToAdd <= 0n) return quota;
    quota.totalTokens += tokensToAdd;
    quota.remainingTokens += tokensToAdd;
    quota.updatedAt = new Date();
    this.scheduleSave();
    return quota;
  }

  async deductTokensFromQuota(userId: string, tokensUsed: number, cachedTokens: number): Promise<UserQuota> {
    const quota = await this.getUserQuota(userId);
    const safeTokensUsed = Number.isFinite(tokensUsed) && tokensUsed > 0 ? Math.round(tokensUsed) : 0;
    const safeCachedTokens = Number.isFinite(cachedTokens) && cachedTokens > 0 ? Math.round(cachedTokens) : 0;
    const bigTokensUsed = BigInt(safeTokensUsed);
    const bigCachedTokens = BigInt(safeCachedTokens);

    quota.usedTokens += bigTokensUsed;
    quota.cachedTokens += bigCachedTokens;
    quota.remainingTokens = quota.remainingTokens >= bigTokensUsed ? (quota.remainingTokens - bigTokensUsed) : 0n;
    quota.updatedAt = new Date();
    this.scheduleSave();
    return quota;
  }

  /**
   * Optimistically reserves token quota before calling upstream.
   * Prevents race conditions where concurrent requests burn upstream tokens for free.
   */
  async reserveQuota(userId: string, tokensToReserve: number, minRequired = 1): Promise<{
    success: boolean;
    reservationId: string;
    reservedTokens: number;
    remainingTokens: bigint;
  }> {
    const quota = await this.getUserQuota(userId);
    const safeMin = Number.isFinite(minRequired) && minRequired >= 1 ? Math.floor(minRequired) : 1;
    const bigMin = BigInt(safeMin);

    if (quota.remainingTokens < bigMin) {
      return {
        success: false,
        reservationId: '',
        reservedTokens: 0,
        remainingTokens: quota.remainingTokens
      };
    }

    const safeReserve = Number.isFinite(tokensToReserve) && tokensToReserve >= safeMin ? Math.floor(tokensToReserve) : safeMin;
    const bigReserve = BigInt(safeReserve);
    const toReserve = quota.remainingTokens < bigReserve ? quota.remainingTokens : bigReserve;

    quota.remainingTokens -= toReserve;
    quota.updatedAt = new Date();

    const reservationId = 'res_' + crypto.randomBytes(12).toString('hex');
    this.activeReservations.set(reservationId, {
      userId,
      reservedAmount: Number(toReserve),
      timestamp: Date.now()
    });

    this.scheduleSave();

    return {
      success: true,
      reservationId,
      reservedTokens: Number(toReserve),
      remainingTokens: quota.remainingTokens
    };
  }

  /**
   * Reconciles actual token usage against the optimistic reservation after upstream completes.
   * Accurately refunds unused reservation or charges consumed tokens, never allowing negative quota.
   */
  async reconcileQuota(
    userId: string,
    reservationId: string,
    actualTokensUsed: number,
    cachedTokens: number,
    statusCode: number
  ): Promise<UserQuota> {
    const pending = this.activeReservations.get(reservationId);
    // If reservation doesn't exist (already reconciled or cancelled), do not double-deduct
    if (!pending) {
      return this.getUserQuota(userId);
    }
    const reservedAmount = pending.reservedAmount;
    this.activeReservations.delete(reservationId);

    const quota = await this.getUserQuota(userId);
    const safeActual = Number.isFinite(actualTokensUsed) && actualTokensUsed > 0 ? Math.round(actualTokensUsed) : 0;
    const safeCached = Number.isFinite(cachedTokens) && cachedTokens > 0 ? Math.round(cachedTokens) : 0;
    const bigActual = BigInt(safeActual);
    const bigReserved = BigInt(reservedAmount);

    if (bigActual === 0n) {
      // Request failed or aborted before consuming any tokens: full refund of reservation
      quota.remainingTokens += bigReserved;
    } else {
      // Reconcile actual consumption
      const diff = bigActual - bigReserved;
      if (diff > 0n) {
        // Consumed more than reserved: deduct additional tokens, clamp to 0
        if (quota.remainingTokens >= diff) {
          quota.remainingTokens -= diff;
        } else {
          quota.remainingTokens = 0n; // Never allow negative quota
        }
      } else if (diff < 0n) {
        // Consumed less than reserved: refund the unused portion
        quota.remainingTokens += (-diff);
      }

      quota.usedTokens += bigActual;
      quota.cachedTokens += BigInt(safeCached);
    }

    quota.updatedAt = new Date();
    this.scheduleSave();
    return quota;
  }

  /**
   * Cancels a reservation and restores reserved tokens.
   */
  async cancelReservation(reservationId: string): Promise<void> {
    const pending = this.activeReservations.get(reservationId);
    if (!pending) return;
    this.activeReservations.delete(reservationId);

    const quota = await this.getUserQuota(pending.userId);
    quota.remainingTokens += BigInt(pending.reservedAmount);
    quota.updatedAt = new Date();
    this.scheduleSave();
  }

  // Usage
  async recordUsage(data: {
    userId: string;
    apiKeyId?: string | null;
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
    upstreamGroup?: string;
    upstreamKeyName?: string;
  }): Promise<UsageRecord> {
    const record: UsageRecord = {
      id: 'usg_' + crypto.randomBytes(12).toString('hex'),
      userId: data.userId,
      apiKeyId: data.apiKeyId || null,
      model: data.model,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      cachedTokens: data.cachedTokens,
      totalTokens: data.totalTokens,
      deductedTokens: data.deductedTokens !== undefined ? data.deductedTokens : data.totalTokens,
      rateMultiplier: data.rateMultiplier,
      requestDurationMs: data.requestDurationMs,
      statusCode: data.statusCode,
      isStream: data.isStream,
      createdAt: new Date(),
      upstreamGroup: data.upstreamGroup,
      upstreamKeyName: data.upstreamKeyName
    };

    // Cap in-memory usage arrays to avoid unbounded memory leaks and DoS
    this.usageRecords.push(record);
    if (this.usageRecords.length > MemoryStore.MAX_GLOBAL_USAGE_RECORDS) {
      this.usageRecords.splice(0, this.usageRecords.length - MemoryStore.MAX_GLOBAL_USAGE_RECORDS);
    }

    const userRecords = this.usageRecordsByUserId.get(data.userId) || [];
    userRecords.push(record);
    if (userRecords.length > MemoryStore.MAX_USER_USAGE_RECORDS) {
      userRecords.splice(0, userRecords.length - MemoryStore.MAX_USER_USAGE_RECORDS);
    }
    this.usageRecordsByUserId.set(data.userId, userRecords);

    this.scheduleSave();
    return record;
  }

  async getUserUsageSummary(userId: string): Promise<{
    totalTokens: number;
    usedTokens: number;
    remainingTokens: number;
    cachedTokens: number;
    promptTokens: number;
    completionTokens: number;
    requestCount: number;
  }> {
    const quota = await this.getUserQuota(userId);
    const userRecords = (this.usageRecordsByUserId.get(userId) || []).filter(r => r.statusCode === 200);

    let promptTokens = 0;
    let completionTokens = 0;

    for (const r of userRecords) {
      promptTokens += r.promptTokens;
      completionTokens += r.completionTokens;
    }

    return {
      totalTokens: Number(quota.totalTokens),
      usedTokens: Number(quota.usedTokens),
      remainingTokens: Number(quota.remainingTokens),
      cachedTokens: Number(quota.cachedTokens),
      promptTokens,
      completionTokens,
      requestCount: userRecords.length
    };
  }

  async getUserUsageTrends(userId: string, days = 14): Promise<Array<{
    date: string;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    requests: number;
  }>> {
    const now = new Date();
    const map = new Map<string, {
      date: string;
      totalTokens: number;
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      requests: number;
    }>();

    // Initialize all days in interval
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().split('T')[0];
      map.set(dateStr, {
        date: dateStr,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        requests: 0
      });
    }

    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const userRecords = (this.usageRecordsByUserId.get(userId) || []).filter(r => r.createdAt >= cutoff);

    for (const r of userRecords) {
      const dateStr = r.createdAt.toISOString().split('T')[0];
      const entry = map.get(dateStr);
      if (entry) {
        entry.totalTokens += r.totalTokens;
        entry.promptTokens += r.promptTokens;
        entry.completionTokens += r.completionTokens;
        entry.cachedTokens += r.cachedTokens;
        entry.requests += 1;
      }
    }

    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  async getUserModelBreakdown(userId: string): Promise<Array<{
    model: string;
    totalTokens: number;
    cachedTokens: number;
    requests: number;
  }>> {
    const userRecords = this.usageRecordsByUserId.get(userId) || [];
    const map = new Map<string, { model: string; totalTokens: number; cachedTokens: number; requests: number }>();

    for (const r of userRecords) {
      const entry = map.get(r.model) || { model: r.model, totalTokens: 0, cachedTokens: 0, requests: 0 };
      entry.totalTokens += r.totalTokens;
      entry.cachedTokens += r.cachedTokens;
      entry.requests += 1;
      map.set(r.model, entry);
    }

    return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  }

  async getRecentUsageLogs(userId: string, limit = 20): Promise<UsageRecord[]> {
    const userRecords = this.usageRecordsByUserId.get(userId) || [];
    return userRecords
      .slice(-limit)
      .reverse();
  }

  // Clean / reset for tests
  clearAll() {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    this.users.clear();
    this.usersByEmail.clear();
    this.apiKeys.clear();
    this.apiKeysByHash.clear();
    this.cdks.clear();
    this.cdksByCode.clear();
    this.redemptions.clear();
    this.userRedemptions.clear();
    this.quotas.clear();
    this.usageRecords = [];
    this.usageRecordsByUserId.clear();

    if (this.persistPath && fs.existsSync(this.persistPath)) {
      try {
        fs.unlinkSync(this.persistPath);
      } catch {
        // ignore
      }
    }
  }
}

// Global default singleton instance configured with persistent storage path
export const defaultStore = new MemoryStore(config.DATA_STORE_PATH);
