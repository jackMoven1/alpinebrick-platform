import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
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

  it('labels the cart control for screen readers and reports it empty', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /cart, empty/i })).toBeInTheDocument()
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
