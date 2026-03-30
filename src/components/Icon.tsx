interface IconProps {
  id: string
  className?: string
  size?: number | string
}

/**
 * A reusable Icon component that references symbols in public/icons.svg
 * 
 * Usage:
 * <Icon id="rect" size={20} className="my-custom-icon" />
 */
export function Icon({ id, className, size = 18 }: IconProps) {
  return (
    <svg
      className={`icon-sprite ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      // currentColor allows the icon to inherit color from its parent text/button
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <use href={`/icons.svg#${id}`} />
    </svg>
  )
}
