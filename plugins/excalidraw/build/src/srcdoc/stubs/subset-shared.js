// Font "subsetting" without WebAssembly: returns the whole font, which is already embedded.
export const Commands = { Subset: 'SUBSET' }

export const toBase64 = async (arrayBuffer) => {
  let binary = ''
  const bytes = new Uint8Array(arrayBuffer)
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return `data:font/woff2;base64,${btoa(binary)}`
}

export const subsetToBinary = async (arrayBuffer) => arrayBuffer

export const subsetToBase64 = async (arrayBuffer) => toBase64(arrayBuffer)
