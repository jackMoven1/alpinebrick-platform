export default function Card({ className = '', children }) {
  return <div className={`rounded-card bg-white shadow-card p-5 ${className}`}>{children}</div>
}
