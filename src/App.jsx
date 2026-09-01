import { Routes, Route } from 'react-router-dom'
import MyGamesPage from './pages/MyGamesPage.jsx'
import GameEditorPage from './pages/GameEditorPage.jsx'
import HostLivePage from './pages/HostLivePage.jsx'
import PlayPage from './pages/PlayPage.jsx'
import LeaderboardPage from './pages/LeaderboardPage.jsx'

function App() {
  return (
    <Routes>
      <Route path="/" element={<MyGamesPage />} />
      <Route path="/edit/:gameId" element={<GameEditorPage />} />
      <Route path="/host/:sessionId" element={<HostLivePage />} />
      <Route path="/play" element={<PlayPage />} />
      <Route path="/play/:joinCode" element={<PlayPage />} />
      <Route path="/leaderboard/:sessionId" element={<LeaderboardPage />} />
    </Routes>
  )
}

export default App
