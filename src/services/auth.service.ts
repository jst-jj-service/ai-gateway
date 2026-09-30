import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { IStore } from '../db/store';
import { User, ApiKey, AuthenticatedUser } from '../types';

export class AuthService {
  constructor(private store: IStore) {}

  public static hashApiKey(plainKey: string): string {
    return crypto.createHash('sha256').update(plainKey).digest('hex');
  }

  public static generateApiKeyString(): string {
    const raw = crypto.randomBytes(24).toString('hex');
    return `sk-gw-${raw}`;
  }

  public async register(data: { email: string; password: string; name?: string }): Promise<User> {
    const existing = await this.store.getUserByEmail(data.email);
    if (existing) {
      throw new Error('Email address is already registered');
    }

    if (!data.password || data.password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(data.password, salt);

    return this.store.createUser({
      email: data.email,
      passwordHash,
      name: data.name,
      role: 'USER'
    });
  }

  public async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.store.getUserByEmail(email);
    if (!user || !user.isActive) return null;

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) return null;

    return user;
  }

  public async createApiKey(userId: string, name = 'Default Key'): Promise<{ apiKey: ApiKey; rawKey: string }> {
    const rawKey = AuthService.generateApiKeyString();
    const keyHash = AuthService.hashApiKey(rawKey);
    const keyPrefix = `${rawKey.slice(0, 10)}...${rawKey.slice(-4)}`;

    const apiKey = await this.store.createApiKey({
      userId,
      keyHash,
      keyPrefix,
      name
    });

    return { apiKey, rawKey };
  }

  public async authenticateApiKey(rawKey: string): Promise<AuthenticatedUser | null> {
    if (!rawKey.startsWith('sk-gw-')) {
      return null;
    }

    const keyHash = AuthService.hashApiKey(rawKey);
    const apiKey = await this.store.getApiKeyByHash(keyHash);
    if (!apiKey) return null;

    const user = await this.store.getUserById(apiKey.userId);
    if (!user || !user.isActive) return null;

    // Update last used timestamp async
    this.store.updateApiKeyLastUsed(apiKey.id).catch(() => {});

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      apiKeyId: apiKey.id
    };
  }

  public async validateSessionUser(userId: string): Promise<User | null> {
    const user = await this.store.getUserById(userId);
    if (!user || !user.isActive) return null;
    return user;
  }

  public async seedInitialAdmin(email: string, pass: string): Promise<User> {
    let admin = await this.store.getUserByEmail(email);
    if (!admin) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(pass, salt);
      admin = await this.store.createUser({
        email,
        passwordHash,
        name: 'System Admin',
        role: 'ADMIN'
      });
      console.log(`[AuthService] Seeded initial administrator: ${email}`);
    } else {
      // Sync admin password hash and ensure role is ADMIN upon restart
      const salt = await bcrypt.genSalt(10);
      admin.passwordHash = await bcrypt.hash(pass, salt);
      admin.role = 'ADMIN';
      admin.isActive = true;
    }
    return admin;
  }

  public async changePassword(userId: string, currentPass: string, newPass: string): Promise<{ success: boolean; error?: string }> {
    const user = await this.store.getUserById(userId);
    if (!user) return { success: false, error: 'User not found' };

    const isValid = await bcrypt.compare(currentPass, user.passwordHash);
    if (!isValid) return { success: false, error: 'Incorrect current password' };

    if (!newPass || newPass.length < 6) {
      return { success: false, error: 'New password must be at least 6 characters' };
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPass, salt);
    await this.store.updateUserPassword(userId, passwordHash);
    return { success: true };
  }
}

