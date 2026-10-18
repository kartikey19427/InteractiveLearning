import { BrowserRouter, Route, Routes } from 'react-router-dom';
import HomePage from './pages/HomePage';
import TopicPage from './pages/TopicPage';
import VoicesPage from './pages/VoicesPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/topic/:slug" element={<TopicPage />} />
        <Route path="/voices" element={<VoicesPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </BrowserRouter>
  );
}
