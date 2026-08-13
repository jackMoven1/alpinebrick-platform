import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Community from './Community'

describe('Community page', () => {
  const renderCommunity = () =>
    render(
      <MemoryRouter>
        <Community />
      </MemoryRouter>,
    )

  it('renders exactly one heading of level 1', () => {
    renderCommunity()
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
  })

  it('mentions events', () => {
    renderCommunity()
    expect(document.body.textContent).toMatch(/event/i)
  })

  it('shows the alpinebrick@gmail.com address', () => {
    renderCommunity()
    expect(screen.getByText(/alpinebrick@gmail\.com/)).toBeInTheDocument()
  })

  it('renders no link to an external http(s) destination', () => {
    renderCommunity()
    const anchors = document.querySelectorAll('a')
    expect(anchors.length).toBeGreaterThan(0)
    for (const anchor of Array.from(anchors)) {
      const href = anchor.getAttribute('href') ?? ''
      expect(href.startsWith('http')).toBe(false)
    }
  })

  it('contains no placeholder markers', () => {
    renderCommunity()
    expect(document.body.textContent).not.toMatch(/lorem ipsum|TODO|TBD|placeholder/i)
  })

  it('announces no specific event dates, cities, prices, or attendee counts', () => {
    renderCommunity()
    expect(document.body.textContent).not.toMatch(/\b(20\d{2})\b/)
    expect(document.body.textContent).not.toMatch(/\$\d|\bticket\b|\battendee/i)
    expect(document.body.textContent).not.toMatch(/in (London|Paris|New York|Berlin|Tokyo|Sydney)/i)
  })
})
