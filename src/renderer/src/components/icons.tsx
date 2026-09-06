// Drawn icon system (16px stroke, currentColor). No emoji or text glyphs
// as icons — floor rule. Keep paths few and a consistent 1.6px stroke.
interface IconProps {
  size?: number
  className?: string
}

function base(size: number, className: string | undefined, children: React.ReactNode): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function IconBrain({ size = 16, className }: IconProps): React.JSX.Element {
  return base(
    size,
    className,
    <>
      <rect x={3} y={3} width={10} height={10} rx={2.5} />
      <circle cx={8} cy={8} r={2} />
      <path d="M8 3v3M8 10v3M3 8h3M10 8h3" />
    </>,
  )
}

export function IconGear({ size = 16, className }: IconProps): React.JSX.Element {
  return base(
    size,
    className,
    <>
      <circle cx={8} cy={8} r={5.2} />
      <circle cx={8} cy={8} r={1.8} />
      <path d="M8 2.8v1.6M8 11.6v1.6M2.8 8h1.6M11.6 8h1.6" />
    </>,
  )
}

export function IconX({ size = 16, className }: IconProps): React.JSX.Element {
  return base(size, className, <path d="M4 4l8 8M12 4l-8 8" />)
}

export function IconCheck({ size = 16, className }: IconProps): React.JSX.Element {
  return base(size, className, <path d="M3 8.5l3.2 3.2L13 5" />)
}

export function IconPlus({ size = 16, className }: IconProps): React.JSX.Element {
  return base(size, className, <path d="M8 3v10M3 8h10" />)
}

export function IconChevL({ size = 16, className }: IconProps): React.JSX.Element {
  return base(size, className, <path d="M10 3L5 8l5 5" />)
}

export function IconChevR({ size = 16, className }: IconProps): React.JSX.Element {
  return base(size, className, <path d="M6 3l5 5-5 5" />)
}

export function IconChevD({ size = 16, className }: IconProps): React.JSX.Element {
  return base(size, className, <path d="M3 6l5 5 5-5" />)
}

export function IconFolder({ size = 16, className }: IconProps): React.JSX.Element {
  return base(
    size,
    className,
    <path d="M2 4.5c0-.8.7-1.5 1.5-1.5h3l1.2 1.5h4.8c.8 0 1.5.7 1.5 1.5v5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5v-6.5z" />,
  )
}

export function IconExpand({ size = 16, className }: IconProps): React.JSX.Element {
  return base(
    size,
    className,
    <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />,
  )
}
