import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative assets work in local production previews and under GitHub Pages'
  // repository subpath (for example /Scribbledicks/).
  base: './',
  plugins: [react()],
})
