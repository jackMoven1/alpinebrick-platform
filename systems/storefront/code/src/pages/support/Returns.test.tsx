import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Returns from './Returns'

describe('Returns page', () => {
  const renderReturns = () =>
    render(
      <MemoryRouter>
        <Returns />
      </MemoryRouter>,
    )

  it('renders exactly one level-1 heading', () => {
    renderReturns()
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
  })

  it('shows the returns contact email address', () => {
    renderReturns()
    expect(screen.getAllByText(/alpinebrick@gmail\.com/).length).toBeGreaterThan(0)
  })

  it('tells the customer to make contact before sending anything back', () => {
    renderReturns()
    expect(
      screen.getByText(/Do not send anything back before you hear from us/i),
    ).toBeInTheDocument()
  })

  it('contains no placeholder markers in document body', () => {
    renderReturns()
    expect(document.body.textContent).not.toMatch(
      /lorem ipsum|TODO|TBD|placeholder/i,
    )
  })
})
