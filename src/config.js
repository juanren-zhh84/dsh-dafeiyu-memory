import { memoryError } from './contracts.js';

export const DEFAULT_CONFIG = Object.freeze({
  shortTermDays: 7,
  longTermDays: 30,
  recycleDays: 7,
  diskSoftLimitBytes: 1024 ** 3,
  diskWarningRatio: 0.8,
  recallQuotas: Object.freeze({ shortTerm: 8, longTerm: 6, diary: 3 }),
  reviewBatchSize: 40,
  reviewTimeoutMs: 120_000,
  reviewMaxAttempts: 8,
  // Reviews use exponential retry delays capped at retryMaxMs.
  retryBaseMs: 15 * 60_000,
  retryMaxMs: 24 * 60 * 60_000,
});

export function resolveConfig(overrides = {}) {
  const invalid = (name) => {
    throw memoryError('MEMORY_INVALID_CONFIG', `Invalid memory configuration: ${name}`);
  };
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) invalid('config');
  if (overrides.recallQuotas !== undefined && (
    !overrides.recallQuotas || typeof overrides.recallQuotas !== 'object' || Array.isArray(overrides.recallQuotas)
  )) invalid('recallQuotas');
  const config = {
    ...DEFAULT_CONFIG,
    ...overrides,
    recallQuotas: { ...DEFAULT_CONFIG.recallQuotas, ...overrides.recallQuotas },
  };
  for (const name of [
    'shortTermDays', 'longTermDays', 'recycleDays', 'diskSoftLimitBytes',
    'reviewBatchSize', 'reviewTimeoutMs', 'reviewMaxAttempts',
    'retryBaseMs', 'retryMaxMs',
  ]) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) invalid(name);
  }
  for (const [name, minimum] of [['shortTermDays', 7], ['longTermDays', 30], ['recycleDays', 7]]) {
    if (config[name] < minimum) invalid(name);
  }
  if (config.diskSoftLimitBytes < 256 * 1024 ** 2) invalid('diskSoftLimitBytes');
  if (config.diskWarningRatio !== 0.8) invalid('diskWarningRatio');
  for (const name of ['shortTerm', 'longTerm', 'diary']) {
    if (!Number.isSafeInteger(config.recallQuotas[name]) || config.recallQuotas[name] <= 0) {
      invalid(`recallQuotas.${name}`);
    }
  }
  if (config.retryMaxMs < config.retryBaseMs) invalid('retryMaxMs');
  Object.freeze(config.recallQuotas);
  return Object.freeze(config);
}
