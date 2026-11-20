import { describe, expect, it } from 'vitest'
import {
  AcquisitionPolicy, CreateAcquisitionProviderRequest, ProviderOffer, UpdateAcquisitionPolicy, UpdateAcquisitionProviderRequest,
} from './acquisition.js'

describe('acquisition patches', () => {
  it('never fill in keys the caller left out', () => {
    expect(UpdateAcquisitionProviderRequest.parse({ enabled: false })).toEqual({ enabled: false })
    expect(UpdateAcquisitionProviderRequest.parse({})).toEqual({})
    expect(UpdateAcquisitionPolicy.parse({ timeoutSeconds: 60 })).toEqual({ timeoutSeconds: 60 })
  })

  it('can change everything a provider or the policy stores', () => {
    expect(Object.keys(UpdateAcquisitionProviderRequest.shape).sort()).toEqual(Object.keys(CreateAcquisitionProviderRequest.shape).sort())
    expect(Object.keys(UpdateAcquisitionPolicy.shape).sort()).toEqual(Object.keys(AcquisitionPolicy.shape).sort())
  })

  it('reads a priced offer, which the server then ignores', () => {
    expect(ProviderOffer.parse({ offerId: 'a', format: 'flac', lossless: true, price: { amount: '1.00', currency: 'EUR' } }).price).toEqual({ amount: '1.00', currency: 'EUR' })
  })
})
