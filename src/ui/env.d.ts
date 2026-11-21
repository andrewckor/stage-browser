import type { StageApi } from '../shared/contract'

declare global {
  interface Window {
    stage?: StageApi
  }
}

export {}
