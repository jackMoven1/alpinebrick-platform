export function AlpineBrickLogo({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect width="36" height="36" rx="3" fill="#111111" />
      <circle cx="12" cy="12" r="5.5" fill="#FFD100" />
      <circle cx="24" cy="12" r="5.5" fill="#FFD100" />
      <circle cx="12" cy="24" r="5.5" fill="#FFD100" />
      <circle cx="24" cy="24" r="5.5" fill="#FFD100" />
      <circle cx="12" cy="12" r="2.8" fill="#111111" fillOpacity="0.45" />
      <circle cx="24" cy="12" r="2.8" fill="#111111" fillOpacity="0.45" />
      <circle cx="12" cy="24" r="2.8" fill="#111111" fillOpacity="0.45" />
      <circle cx="24" cy="24" r="2.8" fill="#111111" fillOpacity="0.45" />
    </svg>
  )
}
