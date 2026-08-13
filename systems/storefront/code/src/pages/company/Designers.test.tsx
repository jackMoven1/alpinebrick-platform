import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import Designers from './Designers'

describe('Designers page', () => {
  function renderPage() {
    return render(
      <MemoryRouter>
        <Designers />
      </MemoryRouter>,
    )
  }

  it('renders exactly one level-1 heading', () => {
    renderPage()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('states that a designer earns a share of revenue on every sale', () => {
    const { container } = renderPage()
    const text = container.textContent ?? ''
    expect(text.toLowerCase()).toContain('share of the revenue')
    expect(text.toLowerCase()).toContain('every sale')
  })

  it('shows the contact address alpinebrick@gmail.com', () => {
    renderPage()
    expect(
      screen.getByText(/alpinebrick@gmail\.com/i),
    ).toBeInTheDocument()
  })

  it('contains no placeholder markers', () => {
    renderPage()
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/lorem ipsum|TODO|TBD|placeholder/i)
  })
})
