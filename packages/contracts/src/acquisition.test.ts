import { describe, expect, it } from 'vitest'
import {
  AcquireQuery, AcquisitionJob, AcquisitionPolicy, AcquisitionUsage, CreateAcquisitionProviderRequest, ProviderOffer, UpdateAcquisitionPolicy,
  UpdateAcquisitionProviderRequest,
} from './acquisition.js'

describe('acquisition patches', () => {
  it('never fill in keys the caller left out', () => {
    expect(UpdateAcquisitionProviderRequest.parse({ enabled: false })).toEqual({ enabled: false })
    expect(UpdateAcquisitionProviderRequest.parse({})).toEqual({})
    expect(UpdateAcquisitionPolicy.parse({ timeoutSeconds: 60 })).toEqual({ timeoutSeconds: 60 })
  })

  it('can change everything a provider or the policy stores', () => {
    // Coverage comes from the provider's capabilities on create; a patch can only override it.
    expect(Object.keys(UpdateAcquisitionProviderRequest.shape).sort()).toEqual([...Object.keys(CreateAcquisitionProviderRequest.shape), 'coverage'].sort())
    expect(Object.keys(UpdateAcquisitionPolicy.shape).sort()).toEqual(Object.keys(AcquisitionPolicy.shape).sort())
  })

  it('reads a priced offer, which the server then ignores', () => {
    expect(ProviderOffer.parse({ offerId: 'a', format: 'flac', lossless: true, price: { amount: '1.00', currency: 'EUR' } }).price).toEqual({ amount: '1.00', currency: 'EUR' })
  })
})

describe('the streaming model fields', () => {
  const job = {
    id: '00000000-0000-4000-8000-000000000001', providerId: '00000000-0000-4000-8000-000000000002', providerName: 'p',
    requestedBy: null, trackId: null, albumId: null, title: 't', status: 'completed', error: null, importId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', completedAt: null,
  }

  it('reads jobs with and without an origin', () => {
    expect(AcquisitionJob.parse(job).origin).toBeUndefined()
    expect(AcquisitionJob.parse({ ...job, origin: 'prefetch' }).origin).toBe('prefetch')
    expect(() => AcquisitionJob.parse({ ...job, origin: 'elsewhere' })).toThrow()
  })

  it('lets clients name only library and download as an acquire origin', () => {
    expect(AcquireQuery.parse({})).toEqual({})
    expect(AcquireQuery.parse({ origin: 'download' })).toEqual({ origin: 'download' })
    expect(() => AcquireQuery.parse({ origin: 'play' })).toThrow()
  })

  it('patches coverage only when asked', () => {
    expect(UpdateAcquisitionProviderRequest.parse({ coverage: 'assume_available' })).toEqual({ coverage: 'assume_available' })
    expect(() => UpdateAcquisitionProviderRequest.parse({ coverage: 'sometimes' })).toThrow()
  })

  it('reads cache usage', () => {
    const usage = { cachedFiles: 13, cachedBytes: 120_000_000, pinnedBytes: 40_000_000, limitBytes: 0 }
    expect(AcquisitionUsage.parse(usage)).toEqual(usage)
    expect(() => AcquisitionUsage.parse({ ...usage, cachedBytes: -1 })).toThrow()
  })
})
