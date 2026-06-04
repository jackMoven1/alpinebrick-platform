import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Pill from './Pill.jsx'
import StatCard from './StatCard.jsx'

describe('ui primitives', () => {
  it('Pill renders children', () => {
    render(<Pill tone="published">Published</Pill>)
    expect(screen.getByText('Published')).toBeInTheDocument()
  })
  it('StatCard shows label and value', () => {
    render(<StatCard label="Total products" value={12} />)
    expect(screen.getByText('Total products')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })
})
