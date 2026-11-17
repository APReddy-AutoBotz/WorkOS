export const loginRateLimitOptions = ({maxAttempts = 8, maxIpAttempts = 64,
  maxEntries = 10000, windowMs = 15 * 60 * 1000} = {}) => {
  for (const value of [maxAttempts, maxIpAttempts, maxEntries, windowMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Login rate limits must be positive safe integers.');
  }
  if (windowMs > 86400000) throw new Error('Login rate window must not exceed one day.');
  return {maxAttempts, maxIpAttempts, maxEntries, windowMs};
};
