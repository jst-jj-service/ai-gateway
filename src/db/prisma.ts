import { PrismaClient } from '@prisma/client';
import { defaultStore, IStore } from './store';

let prisma: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient | null {
  if (prisma) return prisma;
  try {
    prisma = new PrismaClient();
    return prisma;
  } catch (err) {
    console.warn('Prisma client could not be initialized, falling back to memory store.');
    return null;
  }
}

export function getStore(): IStore {
  return defaultStore;
}
