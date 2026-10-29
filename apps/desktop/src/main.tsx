import { createRoot } from 'react-dom/client';
import App from './App';
import { applySettings, loadSettings } from './lib/settings';
import './styles.css';

applySettings(loadSettings());

const container = document.getElementById('root');
if (!container) throw new Error('Missing root element.');

createRoot(container).render(<App />);
