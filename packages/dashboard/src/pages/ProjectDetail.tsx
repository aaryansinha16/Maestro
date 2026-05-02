import { useParams } from 'react-router-dom'
import { Placeholder } from './_Placeholder'

export function ProjectDetail() {
  const { slug } = useParams<{ slug: string }>()
  return (
    <Placeholder
      eyebrow="Projects"
      title={slug ? `Project: ${slug}` : 'Project'}
      body="Per-project view: state, journal, sessions, autonomy. Lands in Phase 1.5."
      reference="PRODUCT_VISION.md → Phase 3 (foundations land in Phase 1.5)"
    />
  )
}
