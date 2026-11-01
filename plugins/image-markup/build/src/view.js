// Zoom and pan. A view maps image pixels to CSS pixels of the stage: screen = image * scale + offset.

export const MIN_SCALE = 0.02
export const MAX_SCALE = 32
const FIT_PADDING = 24

const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

/** Centres the image, scaled down to fit (never up past 100%). */
export function fitView(imageWidth, imageHeight, stageWidth, stageHeight) {
  const room = (size) => Math.max(1, size - FIT_PADDING * 2)
  const scale = clampScale(Math.min(1, room(stageWidth) / imageWidth, room(stageHeight) / imageHeight))
  return {
    scale,
    x: (stageWidth - imageWidth * scale) / 2,
    y: (stageHeight - imageHeight * scale) / 2
  }
}

/** Zooms by `factor` keeping stage point (sx, sy) over the same image pixel. */
export function zoomAt(view, factor, sx, sy) {
  const scale = clampScale(view.scale * factor)
  const ratio = scale / view.scale
  return { scale, x: sx - (sx - view.x) * ratio, y: sy - (sy - view.y) * ratio }
}

export const toImage = (view, sx, sy) => [(sx - view.x) / view.scale, (sy - view.y) / view.scale]
export const toStage = (view, ix, iy) => [ix * view.scale + view.x, iy * view.scale + view.y]
