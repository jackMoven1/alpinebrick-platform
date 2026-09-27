import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import Root from './Root'

function renderShell(initialEntries = ['/']) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Root,
        children: [{ index: true, element: <h1>Home</h1> }],
      },
    ],
    { initialEntries },
  )
  return render(<RouterProvider router={router} />)
}

describe('Root shell', () => {
  it('renders navigation, main and footer landmarks', () => {
    renderShell()
    expect(screen.getByRole('navigation')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
  })

  it('renders the routed child inside main', () => {
    renderShell()
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument()
  })

  it('offers a skip link targeting the main landmark', () => {
    renderShell()
    const skip = screen.getByRole('link', { name: /skip to main content/i })
    expect(skip).toHaveAttribute('href', '#main')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main')
  })

  it('labels the cart button for screen readers and opens the cart drawer', async () => {
    renderShell()
    await userEvent.click(screen.getByRole('button', { name: /cart, empty/i }))
    expect(screen.getByRole('dialog', { name: 'Cart' })).toBeInTheDocument()
    expect(screen.getByText(/Your cart is empty/)).toBeInTheDocument()
  })

  it('links the legal and policy pages from the footer', () => {
    renderShell()
    const footer = screen.getByRole('contentinfo')
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal/terms')
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/legal/privacy')
    expect(within(footer).getByRole('link', { name: 'Refunds' })).toHaveAttribute('href', '/support/returns')
    expect(within(footer).getByRole('link', { name: 'Shipping' })).toHaveAttribute('href', '/support/shipping')
  })

  it('links the brand mark home and the primary nav to real routes', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /alpine brick/i })).toHaveAttribute('href', '/')
    expect(screen.getAllByRole('link', { name: 'Collections' })[0]).toHaveAttribute(
      'href',
      '/collections',
    )
  })

  // The reference footer carried "Gift Cards" and a duplicate "Art Series"
  // pointing nowhere, plus href="#" legal links.
  it('has no dead links in the footer', () => {
    renderShell()
    const dead = screen
      .getAllByRole('link')
      .filter(a => {
        const href = a.getAttribute('href')
        return href === '#' || href === '' || href === null
      })
    expect(dead).toEqual([])
    expect(screen.queryByRole('link', { name: /gift cards/i })).not.toBeInTheDocument()
  })

  it('states the LEGO Group non-affiliation', () => {
    renderShell()
    expect(screen.getByText(/not affiliated with the lego group/i)).toBeInTheDocument()
  })
})
