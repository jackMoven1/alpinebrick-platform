/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#7B5CFA', soft: '#EDE9FE', dark: '#5B3FE0' },
        accent: { DEFAULT: '#F25FB0', soft: '#FCE7F3' },
        ink: '#111114',
        canvas: '#ECEAF3',
      },
      borderRadius: { card: '1.25rem', pill: '999px' },
      boxShadow: { card: '0 8px 24px -12px rgba(17,17,20,0.12)' },
    },
  },
  plugins: [],
}
