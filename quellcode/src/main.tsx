import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initDesktopStorage } from './desktop';
import './styles.css';

// In der Windows-Version zuerst gespeicherte Eingaben laden, dann die App starten
void initDesktopStorage().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

// Service Worker: macht die App installierbar (Startbildschirm am Handy)
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('./sw.js').catch(() => undefined); });
}
