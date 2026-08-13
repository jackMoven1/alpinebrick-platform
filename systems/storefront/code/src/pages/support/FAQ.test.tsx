import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import FAQ from './FAQ'

describe('FAQ page', () => {
  const renderFAQ = () =>
    render(
      <MemoryRouter>
        <FAQ />
      </MemoryRouter>,
    )

  it('renders exactly one level-1 heading', () => {
    renderFAQ()
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
  })

  it('renders at least 8 question buttons', () => {
    renderFAQ()
    const questionButtons = screen.getAllByRole('button')
    const expandableButtons = questionButtons.filter(btn =>
      btn.hasAttribute('aria-expanded'),
    )
    expect(expandableButtons.length).toBeGreaterThanOrEqual(8)
  })

  it('starts every question button with aria-expanded set to false', () => {
    renderFAQ()
    const expandableButtons = screen
      .getAllByRole('button')
      .filter(btn => btn.hasAttribute('aria-expanded'))
    for (const btn of expandableButtons) {
      expect(btn).toHaveAttribute('aria-expanded', 'false')
    }
  })

  it('sets aria-expanded to true on the first question when clicked', async () => {
    const user = userEvent.setup()
    renderFAQ()
    const expandableButtons = screen
      .getAllByRole('button')
      .filter(btn => btn.hasAttribute('aria-expanded'))
    const firstButton = expandableButtons[0]
    await user.click(firstButton)
    expect(firstButton).toHaveAttribute('aria-expanded', 'true')
  })

  it('contains no placeholder markers in the document body', () => {
    renderFAQ()
    expect(document.body.textContent).not.toMatch(
      /lorem ipsum|TODO|TBD|placeholder/i,
    )
  })
})
