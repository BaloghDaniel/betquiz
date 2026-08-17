import type { ReactNode } from 'react'

/**
 * Phone-first shell: a centred column that stays comfortable on a desktop
 * browser too, with padding that clears the iOS home indicator and notch.
 */
export default function Screen({
  children,
  header,
  footer,
}: {
  children: ReactNode
  header?: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="flex min-h-full justify-center">
      <div className="flex w-full max-w-md flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
        {header}
        <div className="flex flex-1 flex-col justify-center gap-4 py-4">{children}</div>
        {footer}
      </div>
    </div>
  )
}
