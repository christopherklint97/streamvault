import { defineConfig } from 'vite'
import { execSync } from 'child_process'
import react from '@vitejs/plugin-react'

const lanIp = process.env.VITE_SERVER_IP
  || execSync('hostname -I').toString().trim().split(/\s+/)[0]

export default defineConfig({
  plugins: [react()],
  define: {
    __SERVER_URL__: JSON.stringify(`http://${lanIp}:3002`),
  },
  resolve: {
    alias: {
      'react': 'preact/compat',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  build: {
    target: 'es2017',
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
