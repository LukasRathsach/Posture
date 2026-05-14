import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function copySharedTradeContract() {
  return {
    name: 'copy-shared-trade-contract',
    closeBundle() {
      const source = resolve(__dirname, 'extension/trade-contract.js')
      const destination = resolve(__dirname, 'dist/extension/trade-contract.js')
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(source, destination)
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), copySharedTradeContract()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom'],
  },
  server: {
    port: 3000,
    host: true
  },
  preview: {
    port: 4173,
    host: true
  }
})
