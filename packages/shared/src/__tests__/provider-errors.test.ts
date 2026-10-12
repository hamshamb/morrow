import { describe, expect, it } from 'vitest'
import { isRateLimitOrQuotaError } from '../provider'

describe('isRateLimitOrQuotaError', () => {
  it('recognises throttling and quota/credit errors from the main providers', () => {
    for (const raw of [
      'HTTP 429: Too Many Requests',
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded ... limit: 0"}}',
      'You exceeded your current quota, please check your plan and billing details. insufficient_quota',
      'rate_limit_error: Number of request tokens has exceeded your per-minute rate limit',
      'Your credit balance is too low to access the Anthropic API.',
    ]) {
      expect(isRateLimitOrQuotaError(raw), raw).toBe(true)
    }
  })

  it('does not treat auth, missing-model or network errors as quota', () => {
    for (const raw of ['HTTP 401: invalid x-api-key', 'model_not_found', 'ECONNREFUSED', '', null, undefined]) {
      expect(isRateLimitOrQuotaError(raw), String(raw)).toBe(false)
    }
  })
})
