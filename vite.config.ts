/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function githubPagesBase(): string {
  if (process.env.GITHUB_PAGES !== 'true') {
    return '/'
  }
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
  if (!repo || repo.endsWith('.github.io')) {
    return '/'
  }
  return `/${repo}/`
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: githubPagesBase(),
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
