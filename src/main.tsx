import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import DrawingSandbox from './drawing/DrawingSandbox'
import './styles.css'

const isDrawingSandbox = window.location.pathname.replace(/\/+$/, '').endsWith('/dev/drawing')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isDrawingSandbox ? <DrawingSandbox /> : <App />}
  </StrictMode>,
)
