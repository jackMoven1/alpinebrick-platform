import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Support from './Support'

const SUPPORT_HREFS = [
  '/support/faq',
  '/support/shipping',
  '/support/returns',
  '/support/track-order',
  '/support/contact',
]

describe('Support page', () => {
  const renderSupport = () =>
    render(
      <MemoryRouter>
        <Support />
      </MemoryRouter>,
    )

  it('renders exactly one heading of level 1', () => {
    renderSupport()
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
  })

  it('has a link to /support/faq', () => {
    renderSupport()
    const link = screen.getByRole('link', { name: /FAQ/i })
    expect(link).toHaveAttribute('href', '/support/faq')
  })

  it('has a link to /support/track-order', () => {
    renderSupport()
    const link = screen.getByRole('link', { name: /Track Order/i })
    expect(link).toHaveAttribute('href', '/support/track-order')
  })

  it('includes all five support links', () => {
    renderSupport()
    const links = screen.getAllByRole('link')
    const hrefs = links.map(l => l.getAttribute('href'))
    for (const href of SUPPORT_HREFS) {
      expect(hrefs).toContain(href)
    }
  })

  it('contains no placeholder markers in document body', () => {
    renderSupport()
    expect(document.body.textContent).not.toMatch(/lorem ipsum|TODO|TBD|placeholder/i)
  })

  it('mentions the contact email address', () => {
    renderSupport()
    expect(screen.getByText(/alpinebrick@gmail\.com/)).toBeInTheDocument()
  })
})
