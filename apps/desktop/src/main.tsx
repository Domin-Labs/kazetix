import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './styles.css';
import Overlay from './Overlay';
import Toast from './Toast';
import SettingsWindow from './Settings';

const label = getCurrentWindow().label;
if (label === 'settings') document.body.classList.add('settings-window');
else document.documentElement.classList.add('device'); // transparent window: the rounded device is the window
document.addEventListener('contextmenu', (e) => {
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>{label === 'overlay' ? <Overlay /> : label === 'toast' ? <Toast /> : <SettingsWindow />}</StrictMode>,
);
