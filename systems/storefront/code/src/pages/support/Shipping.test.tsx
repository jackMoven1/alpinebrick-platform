import type { ReactElement } from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Shipping from './Shipping'

describe('Shipping Page', () => {
  const renderWithRouter = (ui: ReactElement) => {
    return render(<MemoryRouter>{ui}</MemoryRouter>)
  }

  test('renders exactly one level-1 heading', () => {
    renderWithRouter(<Shipping />)
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
  })

  test('tells customer costs are shown at checkout', () => {
    renderWithRouter(<Shipping />)
    const checkoutText = screen.getByText(/costs are calculated and displayed at checkout/i)
    expect(checkoutText).toBeInTheDocument()
  })

  test('has a link to /support/track-order', () => {
    renderWithRouter(<Shipping />)
    const trackOrderLink = screen.getByRole('link', { name: /order tracking page/i })
    expect(trackOrderLink).toHaveAttribute('href', '/support/track-order')
  })

  test('contains no placeholder markers', () => {
    renderWithRouter(<Shipping />)
    const placeholderPatterns = [
      /lorem ipsum/i,
      /todo/i,
      /tbd/i,
      /placeholder/i
    ]
    
    const bodyText = document.body.textContent
    placeholderPatterns.forEach(pattern => {
      expect(bodyText).not.toMatch(pattern)
    })
  })
})