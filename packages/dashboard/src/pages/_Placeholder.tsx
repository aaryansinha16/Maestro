// Shared placeholder layout for pages that land in later phases. Lets the
// dashboard look polished even before its real content is wired up.

interface Props {
  eyebrow: string
  title: string
  body: string
  reference: string
}

export function Placeholder({ eyebrow, title, body, reference }: Props) {
  return (
    <section className="mx-auto max-w-3xl">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-[0.2em] text-amber-500">{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-semibold text-white">{title}</h2>
      </header>
      <div className="panel px-6 py-10 text-center">
        <p className="mx-auto max-w-md text-sm text-navy-300">{body}</p>
        <p className="mt-4 font-mono text-xs text-navy-400">{reference}</p>
      </div>
    </section>
  )
}
