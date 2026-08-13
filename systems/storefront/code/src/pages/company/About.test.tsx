import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import About from './About'

describe('About page', () => {
  const renderAbout = () =>
    render(
      <MemoryRouter>
        <About />
      </MemoryRouter>,
    )

  it('renders exactly one heading of level 1', () => {
    renderAbout()
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
  })

  it('mentions the year 2021', () => {
    renderAbout()
    expect(screen.getAllByText(/2021/).length).toBeGreaterThan(0)
  })

  it('states it is not affiliated with the LEGO Group', () => {
    renderAbout()
    expect(screen.getByText(/not affiliated with the lego group/i)).toBeInTheDocument()
  })

  it('contains no placeholder markers', () => {
    renderAbout()
    expect(document.body.textContent).not.toMatch(/lorem ipsum|TODO|TBD|placeholder/i)
  })
})
