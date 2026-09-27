import { describe, it, expect } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, MemoryRouter, Routes, Route, useNavigate } from 'react-router'
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

// ------------------------------------------------------------ cart drawer
//
// Declarative MemoryRouter: navigating a createMemoryRouter/RouterProvider in
// jsdom throws a cross-realm AbortSignal error (see CartPanel.test.tsx).

function GoBack() {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate(-1)}>Go back</button>
}

function renderShellDeclarative(initialEntries = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/" element={<Root />}>
          <Route index element={<h1>Home</h1>} />
          <Route path="about" element={<><h1>About page</h1><GoBack /></>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

/**
 * user-event here does not route through RTL's act() (the pre-existing
 * warnings noted in src/test/setup.ts), so these tests wrap each interaction
 * themselves to stay warning-free.
 */
const user = {
  click: (el: Element) => act(async () => { await userEvent.click(el) }),
  keyboard: (keys: string) => act(async () => { await userEvent.keyboard(keys) }),
  tab: (opts?: { shift?: boolean }) => act(async () => { await userEvent.tab(opts) }),
}

const cartButton = () => screen.getByRole('button', { name: /cart, empty/i })

describe('Cart drawer', () => {
  // The nav's backdrop-filter makes it the containing block for position:fixed
  // descendants, which squeezed the drawer into the 64px header.
  it('renders outside the nav, attached to document.body', async () => {
    renderShellDeclarative()
    await user.click(cartButton())
    const dialog = screen.getByRole('dialog', { name: 'Cart' })
    expect(screen.getByRole('navigation').contains(dialog)).toBe(false)
    expect(dialog.closest('nav')).toBeNull()
    expect(document.body.contains(dialog)).toBe(true)
  })

  it('moves focus to Close on open and restores it to the cart button on close', async () => {
    renderShellDeclarative()
    await user.click(cartButton())
    expect(screen.getByRole('button', { name: 'Close cart' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Close cart' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(cartButton()).toHaveFocus()
  })

  it('closes on Escape and restores focus', async () => {
    renderShellDeclarative()
    await user.click(cartButton())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(cartButton()).toHaveFocus()
  })

  it('keeps Tab and Shift+Tab inside the drawer', async () => {
    renderShellDeclarative()
    await user.click(cartButton())
    const dialog = screen.getByRole('dialog', { name: 'Cart' })
    const close = within(dialog).getByRole('button', { name: 'Close cart' })
    const last = within(dialog).getByRole('link', { name: 'View full cart' })
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(last).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    // Walk forward through every stop: focus never leaves the dialog.
    for (let n = 0; n < 5; n++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('closes when the route changes', async () => {
    renderShellDeclarative()
    await user.click(cartButton())
    // A nav link outside the drawer (the drawer's own links close it anyway).
    await user.click(within(screen.getByRole('navigation')).getAllByRole('link', { name: 'About' })[0])
    expect(await screen.findByRole('heading', { name: 'About page' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on browser back', async () => {
    renderShellDeclarative(['/', '/about'])
    await user.click(cartButton())
    expect(screen.getByRole('dialog', { name: 'Cart' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Go back' }))
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
