import { RETRY_CONFIG } from '../config/constants';
import { Logger } from './logger';

// Retry function with exponential backoff
export async function retryAsync<T>(
  operation: () => Promise<T>,
  maxRetries: number = RETRY_CONFIG.MAX_RETRIES,
  baseDelay: number = RETRY_CONFIG.RETRY_DELAY_MS,
  exponentialBackoff: boolean = RETRY_CONFIG.EXPONENTIAL_BACKOFF
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      if (attempt > 0) {
        Logger.info(`Operation succeeded on attempt ${attempt + 1}`);
      }
      return result;
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        Logger.error(`Operation failed after ${maxRetries + 1} attempts`, error);
        throw error;
      }

      const delay = exponentialBackoff ? baseDelay * Math.pow(2, attempt) : baseDelay;

      Logger.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms`, error);
      await sleep(delay);
    }
  }

  throw lastError;
}

// Sleep utility
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Convert timestamp to readable format
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

// Generate unique ID
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 5);
  return `${prefix}${prefix ? '_' : ''}${timestamp}_${random}`;
}
