import { spawn } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const API = 'http://localhost:8787'

/* Run the API server alongside `vite dev`, so `npm run dev` is one command
   on every platform — `node server.js & vite` is not portable to PowerShell. */
let child = null
const apiServer = () => ({
  name: 'api-server',
  apply: 'serve',
  configureServer() {
    if (child) return // config reload — the server is already up
    child = spawn(process.execPath, ['server.js'], { stdio: 'inherit' })
    child.on('exit', () => (child = null))
    process.on('exit', () => child?.kill())
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), apiServer()],
  server: { proxy: { '/api': API } },
})
