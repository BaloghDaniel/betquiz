import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * Phone-first shell: a centred column that stays comfortable on a desktop
 * browser too, with padding that clears the iOS home indicator and notch.
 */
export default function Screen({
  children,
  header,
  footer,
  home = false,
}: {
  children: ReactNode
  header?: ReactNode
  footer?: ReactNode
  /** Show a small "back to start" link. Pure client-side nav -- it does not
   *  call leave_room, so the player stays in the room server-side and can
   *  pick up exactly where they left off via "Rejoin" on the start page. */
  home?: boolean
}) {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-full justify-center">
      <div className="flex w-full max-w-md flex-col px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
        {home && (
          <button
            onClick={() => navigate('/')}
            className="mb-1 self-start text-sm text-white/40 underline underline-offset-4 active:text-white/70"
          >
            ← Home
          </button>
        )}
        {header}
        <div className="flex flex-1 flex-col justify-center gap-4 py-4">{children}</div>
        {footer}
      </div>
    </div>
  )
}
