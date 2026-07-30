import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import DrawingSandbox from './drawing/DrawingSandbox'
import './styles.css'

const redirectedRoute = new URLSearchParams(window.location.search).get('route')
const activeRoute = (redirectedRoute ?? window.location.pathname).replace(/\/+$/, '')
const isDrawingSandbox = activeRoute.endsWith('/dev/drawing')

if (redirectedRoute) {
  const repositoryBase = window.location.pathname.replace(/\/+$/, '')
  window.history.replaceState(null, '', `${repositoryBase}${redirectedRoute}`)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isDrawingSandbox ? <DrawingSandbox /> : <App />}
  </StrictMode>,
)
