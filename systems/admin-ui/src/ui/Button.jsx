export default function Button({ variant = 'primary', className = '', ...props }) {
  const base = 'inline-flex items-center gap-2 rounded-pill px-4 py-2 text-sm font-semibold transition disabled:opacity-50'
  const variants = {
    primary: 'bg-ink text-white hover:bg-black',
    brand: 'bg-brand text-white hover:bg-brand-dark',
    ghost: 'bg-white text-ink shadow-card hover:bg-gray-50',
    danger: 'bg-accent text-white hover:opacity-90',
  }
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />
}
