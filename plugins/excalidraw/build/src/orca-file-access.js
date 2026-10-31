// Stands in for browser-fs-access, which Excalidraw uses for every file it reads or writes. The frame
// cannot download or use the File System Access API, so saving goes through Orca's save dialog.

/** False: Excalidraw then never asks for file handles (drag-and-drop, "save to current file"). */
export const supported = false

/** Whether Orca offers its save dialog to this frame: only isolated frames on desktop get it. */
export const canSaveFiles = () =>
  typeof window.orca?.files?.saveAs === 'function' && window.orca.host?.has?.('files.saveAs') !== false

const aborted = () => new DOMException('The user aborted a request.', 'AbortError')

/** Orca's save dialog; rejects with AbortError when the person cancels it. */
async function saveAs(request) {
  try {
    await window.orca.files.saveAs(request)
  } catch (error) {
    // Why: Excalidraw shows an error for anything but AbortError, and a closed dialog is not one.
    throw error?.code === 'cancelled' ? aborted() : error
  }
}

/** Asks for a fresh click, whose activation lets saveAs open Orca's dialog. */
function confirmSave(request) {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('div')
    dialog.className = 'orca-excalidraw-save'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-label', 'Save export')
    const label = document.createElement('span')
    label.textContent = `${request.suggestedName} is ready.`
    const save = document.createElement('button')
    save.type = 'button'
    save.textContent = 'Save…'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel'
    dialog.append(label, save, cancel)
    const close = () => {
      dialog.remove()
      document.removeEventListener('keydown', onKeyDown, true)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
        reject(aborted())
      }
    }
    // Why synchronous: the click's activation is what lets Orca open its dialog.
    save.addEventListener('click', () => {
      close()
      saveAs(request).then(resolve, reject)
    })
    cancel.addEventListener('click', () => {
      close()
      reject(aborted())
    })
    document.addEventListener('keydown', onKeyDown, true)
    document.body.append(dialog)
    save.focus()
  })
}

export async function fileSave(blobOrPromise, options = {}) {
  if (!canSaveFiles()) {
    throw new Error('Saving files needs the Orca desktop app')
  }
  // Prepare everything first, so the dialog opens on the click that started the export if it can.
  const blob = await blobOrPromise
  const request = {
    suggestedName: options.fileName ?? 'Untitled',
    mimeType: blob.type || options.mimeTypes?.[0] || 'application/octet-stream',
    data: await blob.arrayBuffer()
  }
  // Why: a slow export outlives the click's activation, and Orca opens no dialog without one.
  await (navigator.userActivation?.isActive === false ? confirmSave(request) : saveAs(request))
  return null
}

/** A plain file input: Orca's frames refuse the File System Access API's permission prompt. */
export function fileOpen(options = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options.multiple === true
    input.accept = [...(options.mimeTypes ?? []), ...(options.extensions ?? [])].filter(Boolean).join(',')
    input.addEventListener(
      'change',
      () => {
        const files = [...input.files]
        resolve(input.multiple ? files : files[0])
      },
      { once: true }
    )
    input.addEventListener('cancel', () => reject(aborted()), { once: true })
    input.click()
  })
}
