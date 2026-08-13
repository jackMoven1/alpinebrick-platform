import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Press from './Press'

function renderPage() {
  return render(
    <MemoryRouter>
      <Press />
    </MemoryRouter>,
  )
}

describe('Press', () => {
  it('renders exactly one level-1 heading', () => {
    renderPage()
    const h1s = document.querySelectorAll('h1')
    expect(h1s).toHaveLength(1)
  })

  it('states that there is no press coverage yet', () => {
    renderPage()
    const matches = screen.getAllByText(/no press coverage yet/i)
    expect(matches.length).toBeGreaterThanOrEqual(1)
    matches.forEach((el) => expect(el).toBeInTheDocument())
  })

  it('shows the alpinebrick@gmail.com address', () => {
    renderPage()
    expect(screen.getByText(/alpinebrick@gmail.com/i)).toBeInTheDocument()
  })

  it('contains no placeholder markers in the document body', () => {
    renderPage()
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/lorem ipsum/i)
    expect(text).not.toMatch(/todo/i)
    expect(text).not.toMatch(/\btbd\b/i)
    expect(text).not.toMatch(/placeholder/i)
  })
})
