import { render, screen } from '@testing-library/react'
import App from './App'

test('renders site heading', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: /Alpine Brick Exchange/i })).toBeInTheDocument()
})
