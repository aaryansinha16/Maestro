import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Overview } from './pages/Overview'
import { ProjectDetail } from './pages/ProjectDetail'
import { Sessions } from './pages/Sessions'
import { SessionDetail } from './pages/SessionDetail'
import { PRs } from './pages/PRs'
import { Settings } from './pages/Settings'
import { Costs } from './pages/Costs'
import { Schedule } from './pages/Schedule'
import { Queue } from './pages/Queue'

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="projects/:slug" element={<ProjectDetail />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="sessions/:id" element={<SessionDetail />} />
        <Route path="prs" element={<PRs />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="queue" element={<Queue />} />
        <Route path="costs" element={<Costs />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
