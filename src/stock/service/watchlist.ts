/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file watchlist.ts
 * @description Watchlist service backed by SQLite database.
 */

import { getDb } from '../../db/index.js';
import { watchlists } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';

export async function addToWatchlist(telegramUserId: number, symbol: string): Promise<boolean> {
  const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
  const db = getDb();
  try {
    const existing = db.select().from(watchlists).where(
      and(eq(watchlists.telegramUserId, telegramUserId), eq(watchlists.symbol, cleanSym))
    ).get();
    if (existing) return true;

    db.insert(watchlists).values({
      telegramUserId,
      symbol: cleanSym,
      createdAt: new Date().toISOString(),
    }).run();
    return true;
  } catch (err) {
    logger.error(`Failed to add ${cleanSym} to watchlist for user ${telegramUserId}: ${err}`);
    return false;
  }
}

export async function removeFromWatchlist(telegramUserId: number, symbol: string): Promise<boolean> {
  const cleanSym = symbol.toUpperCase().replace(/^\$/, '').trim();
  const db = getDb();
  try {
    db.delete(watchlists).where(
      and(eq(watchlists.telegramUserId, telegramUserId), eq(watchlists.symbol, cleanSym))
    ).run();
    return true;
  } catch (err) {
    logger.error(`Failed to remove ${cleanSym} from watchlist for user ${telegramUserId}: ${err}`);
    return false;
  }
}

export async function getUserWatchlist(telegramUserId: number): Promise<string[]> {
  const db = getDb();
  try {
    const rows = db.select().from(watchlists).where(eq(watchlists.telegramUserId, telegramUserId)).all();
    return rows.map(r => r.symbol);
  } catch (err) {
    logger.error(`Failed to get watchlist for user ${telegramUserId}: ${err}`);
    return [];
  }
}
