import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);

// Register PWA service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failed — non-critical
    });
  });
}
