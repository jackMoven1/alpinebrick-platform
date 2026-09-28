import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import ShippingSettings from './ShippingSettings.jsx'
import settings from '../data/__fixtures__/shipping-settings.json'

vi.mock('../data/api.js', () => ({ default: { getShippingSettings: vi.fn(), updateShippingSettings: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

const deferred = () => {
  let resolve
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

const renderPage = () => {
  vi.mocked(api.getShippingSettings).mockResolvedValue(settings)
  return render(<ToastProvider><ShippingSettings /></ToastProvider>)
}

describe('ShippingSettings', () => {
  it('loads core’s values in dollars', async () => {
    renderPage()
    expect(await screen.findByLabelText('Flat rate per order ($)')).toHaveValue('9.95')
    expect(screen.getByLabelText('Free shipping at or above ($)')).toHaveValue('150.00')
    expect(screen.getByRole('checkbox', { name: 'Offer free shipping' })).toBeChecked()
  })

  it('saves cents, converting once', async () => {
    vi.mocked(api.updateShippingSettings).mockResolvedValue({ ...settings, flatRateCents: 1295 })
    renderPage()
    const flat = await screen.findByLabelText('Flat rate per order ($)')
    await userEvent.clear(flat)
    await userEvent.type(flat, '12.95')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.updateShippingSettings).toHaveBeenCalledWith({ flatRateCents: 1295, freeThresholdCents: 15000 })
    expect(await screen.findByText('Shipping settings saved')).toBeInTheDocument()
  })

  it('turns free shipping off as null and blocks a non-price', async () => {
    vi.mocked(api.updateShippingSettings).mockResolvedValue({ ...settings, freeThresholdCents: null })
    renderPage()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Offer free shipping' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.updateShippingSettings).toHaveBeenCalledWith({ flatRateCents: 995, freeThresholdCents: null })
    const flat = screen.getByLabelText('Flat rate per order ($)')
    await userEvent.clear(flat)
    await userEvent.type(flat, 'abc')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('two Save clicks in one tick send one request', async () => {
    const d = deferred()
    vi.mocked(api.updateShippingSettings).mockReturnValue(d.promise)
    renderPage()
    await screen.findByLabelText('Flat rate per order ($)')
    const save = screen.getByRole('button', { name: 'Save' })
    act(() => { fireEvent.click(save); fireEvent.click(save) })
    expect(api.updateShippingSettings).toHaveBeenCalledTimes(1)
    await act(async () => { d.resolve(settings) })
  })
})
