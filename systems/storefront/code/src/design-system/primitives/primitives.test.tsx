import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button'
import { Eyebrow } from './Eyebrow'
import { Input } from './Input'
import { Accordion } from './Accordion'
import { Tabs } from './Tabs'

describe('primitives', () => {
  it('Button renders a role=button element whose accessible name is its label', () => {
    render(<Button>Save changes</Button>)
    const button = screen.getByRole('button', { name: /save changes/i })
    expect(button).toBeInTheDocument()
  })

  it('Button className contains focus-visible:ring', () => {
    render(<Button>Go</Button>)
    const button = screen.getByRole('button')
    expect(button.className).toContain('focus-visible:ring')
  })

  it('Eyebrow className contains "uppercase" and a "tracking-" class', () => {
    render(<Eyebrow>Section label</Eyebrow>)
    const el = screen.getByText(/section label/i)
    expect(el.className).toContain('uppercase')
    expect(el.className).toMatch(/tracking-/)
  })

  it('Eyebrow className does NOT match text-[10px] or text-[11px]', () => {
    render(<Eyebrow>Tiny</Eyebrow>)
    const el = screen.getByText(/tiny/i)
    expect(el.className).not.toMatch(/text-\[10px\]/)
    expect(el.className).not.toMatch(/text-\[11px\]/)
  })

  it('Input binds its label so getByLabelText finds the control', () => {
    render(<Input id="email" label="Email address" />)
    const input = screen.getByLabelText(/email address/i)
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute('id', 'email')
  })

  it('Input with an error sets aria-invalid, renders the message, and aria-describedby contains the derived error id', () => {
    render(<Input id="email" label="Email" error="Email is required" />)
    const input = screen.getByLabelText(/email/i) as HTMLInputElement
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.getAttribute('aria-describedby')).toContain('email-error')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveAttribute('id', 'email-error')
    expect(alert).toHaveTextContent('Email is required')
  })

  it('Accordion renders each question as a button with aria-expanded false initially', () => {
    render(
      <Accordion
        items={[
          { id: 'a', question: 'What is this?', answer: 'A store' },
          { id: 'b', question: 'Where are you?', answer: 'Here' },
        ]}
      />,
    )
    const b1 = screen.getByRole('button', { name: /what is this/i })
    const b2 = screen.getByRole('button', { name: /where are you/i })
    expect(b1).toHaveAttribute('aria-expanded', 'false')
    expect(b2).toHaveAttribute('aria-expanded', 'false')
  })

  it('clicking an Accordion trigger sets aria-expanded true and reveals the answer text', async () => {
    const user = userEvent.setup()
    render(
      <Accordion
        items={[{ id: 'a', question: 'What is this?', answer: 'A storefront' }]}
      />,
    )
    const trigger = screen.getByRole('button', { name: /what is this/i })
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('A storefront')).toBeVisible()
  })

  it('Tabs marks the first tab aria-selected true and the second false, and shows the first tab content', () => {
    render(
      <Tabs
        tabs={[
          { id: 'one', label: 'First', content: 'First body' },
          { id: 'two', label: 'Second', content: 'Second body' },
        ]}
      />,
    )
    const tablist = screen.getByRole('tablist')
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
    const panels = screen.getAllByRole('tabpanel')
    const visible = panels.filter((p) => !p.hasAttribute('hidden'))
    expect(visible).toHaveLength(1)
    expect(visible[0]).toHaveTextContent('First body')
  })

  it('clicking the second tab switches the visible tabpanel content', async () => {
    const user = userEvent.setup()
    render(
      <Tabs
        tabs={[
          { id: 'one', label: 'First', content: 'First body' },
          { id: 'two', label: 'Second', content: 'Second body' },
        ]}
      />,
    )
    const tabs = screen.getAllByRole('tab')
    await user.click(tabs[1])
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false')
    const panels = screen.getAllByRole('tabpanel')
    const visible = panels.filter((p) => !p.hasAttribute('hidden'))
    expect(visible).toHaveLength(1)
    expect(visible[0]).toHaveTextContent('Second body')
  })
})
