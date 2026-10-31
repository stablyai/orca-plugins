// Orca's frames may refuse clipboard writes. Excalidraw then falls back to the copy event and
// execCommand; if those fail too, the shapes are kept here so a paste inside this frame still works.
// Kept only while the frame has focus: leaving it may mean the person copied something elsewhere.

let copiedText = null

const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard)
if (writeText) {
  Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true,
    value: async (text) => {
      try {
        await writeText(text)
        copiedText = null
      } catch (error) {
        copiedText = String(text)
        throw error
      }
    }
  })
}

// A copy of selected text, or a copy outside this frame, replaces what was kept.
const forget = (event) => {
  if (event.type !== 'blur' || event.target === window) {
    copiedText = null
  }
}
window.addEventListener('blur', forget)
window.addEventListener('copy', forget, true)
window.addEventListener('cut', forget, true)

window.addEventListener(
  'paste',
  (event) => {
    const pasted = event.clipboardData?.getData('text/plain') ?? ''
    if (!event.isTrusted || copiedText === null || pasted === copiedText) {
      return
    }
    // Why: the system clipboard never got the copy, so replay the paste with what was copied here.
    event.preventDefault()
    event.stopImmediatePropagation()
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', copiedText)
    event.target.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  },
  true
)
