const TONES = {
  draft: 'bg-gray-100 text-gray-600',
  published: 'bg-brand-soft text-brand-dark',
  archived: 'bg-gray-200 text-gray-500',
  neutral: 'bg-gray-100 text-gray-700',
}
export default function Pill({ tone = 'neutral', children }) {
  return <span className={`inline-block rounded-pill px-2.5 py-0.5 text-xs font-semibold ${TONES[tone] || TONES.neutral}`}>{children}</span>
}
