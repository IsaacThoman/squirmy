import { ApiError } from '@squirmy/client-core'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

describe('TV pairing page', () => {
  it('keeps the pairing link through browser sign-in and offers the app link', async () => {
    const { services, api } = fakeServices({ user: null })
    renderWithApp(<AppRoutes />, '/pair?code=ABCD-2345', services)
    expect(await screen.findByRole('link', { name: 'Open in Squirmy for iOS' })).toHaveAttribute('href', expect.stringContaining('squirmy://pair?code=ABCD2345&server='))
    expect(api.auth.lookupTvPairing).not.toHaveBeenCalled()
    const browser = screen.getByRole('link', { name: 'Sign in in browser' })
    expect(browser).toHaveAttribute('href', '/login?next=%2Fpair%3Fcode%3DABCD-2345')
    await userEvent.click(browser)
    await userEvent.type(await screen.findByLabelText('Username'), 'alex')
    await userEvent.type(screen.getByLabelText('Password'), 'right password')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { name: 'Sign in Living Room Apple TV?' })).toBeInTheDocument()
  })

  it('shows the code and address and sends approval only when confirmed', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/pair', services)
    await userEvent.type(await screen.findByLabelText('TV code'), 'abcd-2345')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: 'Sign in Living Room Apple TV?' })).toBeInTheDocument()
    expect(screen.getByText('192.168.1.20')).toBeInTheDocument()
    expect(screen.getByText('ABCD-2345')).toBeInTheDocument()
    expect(screen.getByText(/will be signed in as/)).toBeInTheDocument()
    expect(api.auth.lookupTvPairing).toHaveBeenCalledWith({ code: 'ABCD2345' })
    expect(api.auth.approveTvPairing).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Approve TV' }))
    expect(await screen.findByRole('heading', { name: 'TV approved' })).toBeInTheDocument()
    expect(api.auth.approveTvPairing).toHaveBeenCalledWith({ code: 'ABCD2345', id: expect.any(String) })
  })

  it('shows an expired-code error and lets the user enter another code', async () => {
    const { services, api } = fakeServices()
    api.auth.lookupTvPairing.mockRejectedValueOnce(new ApiError(404, 'pairing_unavailable', 'This TV code has expired or was already used.'))
    renderWithApp(<AppRoutes />, '/pair?code=ABCD-2345', services)
    expect(await screen.findByRole('alert')).toHaveTextContent('This TV code has expired or was already used.')
    expect(screen.queryByRole('button', { name: 'Approve TV' })).toBeNull()
    await userEvent.click(screen.getByRole('link', { name: 'Enter another code' }))
    expect(await screen.findByLabelText('TV code')).toBeInTheDocument()
  })
})
