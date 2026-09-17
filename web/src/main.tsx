import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Sin basename, al recargar estando en /hormiga/ahorros el router busca
        la ruta '/hormiga/ahorros' entre las suyas, no la encuentra, y muestra
        una pantalla en blanco. */}
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
