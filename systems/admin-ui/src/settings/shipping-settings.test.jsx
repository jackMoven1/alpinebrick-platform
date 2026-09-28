import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../ui/toast.jsx'
import ShippingSettings from './ShippingSettings.jsx'
import settings from '../data/__fixtures__/shipping-settings.json'

vi.mock('../data/api.js', () => ({ default: { getShippingSettings: vi.fn(), updateShippingSettings: vi.fn() } }))
import api from '../data/api.js'
afterEach(() => vi.clearAllMocks())

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
})
