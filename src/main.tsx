import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);

// Register PWA service worker — detect updates and reload to pick up new assets
if ('serviceWorker' in navigator) {
  let refreshing = false;

  // Reload once when a new SW takes control (means new assets are available)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failed — non-critical
    });
  });
}
