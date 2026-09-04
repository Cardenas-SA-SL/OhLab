import { useId } from 'react'

/** OhLab's flask mark, sharing the geometry and gradient direction of scripts/make-icon.mjs. */
export function OhLabMark({ size = 32, className }: { size?: number; className?: string }): React.JSX.Element {
  const gradient = useId().replace(/:/g, '')
  return (
    <svg className={className} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7a4bd0" /><stop offset="1" stopColor="#22c1c3" /></linearGradient></defs>
      <path d="M24 8V20L11 43Q7 50 15 53L32 57L49 53Q57 50 53 43L40 20V8" stroke={`url(#${gradient})`} strokeWidth="4.5" />
      <path d="M15 40Q32 34 49 40L54 48Q54 52 48 54L32 57L16 54Q10 52 10 48Z" fill={`url(#${gradient})`} opacity=".88" />
      <path d="M24 18H40" stroke="#d9ffff" strokeOpacity=".75" strokeWidth="3" />
      <circle cx="24" cy="8" r="3.8" fill="#7a4bd0" /><circle cx="40" cy="8" r="3.8" fill="#22c1c3" /><circle cx="32" cy="57" r="3.8" fill="#fff" />
    </svg>
  )
}
