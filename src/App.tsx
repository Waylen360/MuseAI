import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell';
import Works from './pages/Works';
import Settings from './pages/Settings';
import DeAi from './pages/DeAi';
import Examples from './pages/Examples';
import './App.css';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<Works />} />
          <Route path="settings" element={<Settings />} />
          <Route path="examples" element={<Examples />} />
          <Route path="de-ai" element={<DeAi />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App;
