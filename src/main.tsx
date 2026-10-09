import { createRoot } from 'react-dom/client';
import App from './App';
import { applyPrefs } from './store/prefs';
import './styles.css';

applyPrefs();
createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
}
