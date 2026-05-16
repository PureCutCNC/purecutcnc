import { useEffect } from 'react'

export function useRestoreCanvasFocus() {
  useEffect(() => {
    return () => {
      const canvas = document.querySelector<HTMLElement>('.sketch-canvas')
      canvas?.focus({ preventScroll: true })
    }
  }, [])
}
