// Build-time changes to Excalidraw's prebuilt files and the image resizer it bundles, for Orca's two
// editor frames. Every patch is required: the build fails when its pattern is gone, so an Excalidraw
// update cannot silently bring back what a patch removed. See README.md.
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Why: the CJK font alone is 12 MB in ~200 shards; those characters fall back to a system font.
// Liberation Sans is the GPL-licensed fallback of the deprecated Helvetica family.
export const SKIPPED_FONT_FAMILIES = new Set(['Xiaolai', 'Liberation'])

// Why: the frame CSPs have no 'unsafe-eval', and the font subsetter's Emscripten glue builds wrappers
// from source with Function: a named function (the name is cosmetic), a dynCall invoker and embind's
// invoker for every bound C++ function. Each becomes a closure doing the same.
export const EVAL_FREE_REWRITES = [
  [
    /new Function\("body",`return function \$\{\w+\}\(\) \{\s*"use strict";\s*return body\.apply\(this, arguments\);\s*\};\s*`\)\((\w+)\)/,
    'function(){return $1.apply(this,arguments)}'
  ],
  [
    /function (\w+)\((\w+)\)\{let \w+=\[\];for\(let \w+=1;[^;]*;\+\+\w+\)\w+\.push\(`a\$\{\w+\}`\);let (\w+)=`return function \$\{`dynCall_[^]*?new Function\("dynCall","rawFunction",\3\)\(\2,(\w+)\)\}/,
    'function $1($2){return function(...args){return $2($4,...args)}}'
  ],
  [
    /function (\w+)\((\w+),(\w+),(\w+),(\w+),(\w+)\)\{let \w+=\3\.length;\w+<2&&(\w+)\("argTypes array size mismatch[^]*?\["throwBindingError","invoker","fn","runDestructors","retType","classParam"\],\w+=\[\w+,\w+,\w+,(\w+),[^]*?\w+\(Function,\w+\)\.apply\(null,\w+\)\}/,
    (_, name, humanName, argTypes, classType, invoker, fn, throwBindingError, runDestructors) =>
      `function ${name}(${humanName},${argTypes},${classType},${invoker},${fn}){` +
      `const count=${argTypes}.length;count<2&&${throwBindingError}("argTypes array size mismatch! Must at least get return value and 'this' types!");` +
      `const isClass=${argTypes}[1]!==null&&${classType}!==null,expected=count-2,returns=${argTypes}[0].name!=="void";` +
      `const needsStack=${argTypes}.some((type,index)=>index>0&&type!==null&&type.destructorFunction===void 0);` +
      `return function(...args){` +
      `args.length!==expected&&${throwBindingError}(\`function \${${humanName}} called with \${args.length} arguments, expected \${expected} args!\`);` +
      `const destructors=needsStack?[]:null,wired=[];` +
      `isClass&&wired.push(${argTypes}[1].toWireType(destructors,this));` +
      `for(let index=0;index<expected;++index)wired.push(${argTypes}[index+2].toWireType(destructors,args[index]));` +
      `const rv=${invoker}(${fn},...wired);` +
      `if(needsStack)${runDestructors}(destructors);` +
      `else for(let index=isClass?1:2;index<count;++index)${argTypes}[index].destructorFunction!==null&&${argTypes}[index].destructorFunction(wired[index-(isClass?1:2)]);` +
      `if(returns)return ${argTypes}[0].fromWireType(rv)}}`
  ]
]

/** Applies the eval-free rewrites; `applied` holds the indexes of those that matched. */
export function rewriteEvalFree(code) {
  const applied = new Set()
  for (const [index, [pattern, replacement]] of EVAL_FREE_REWRITES.entries()) {
    if (pattern.test(code)) {
      code = code.replace(pattern, replacement)
      applied.add(index)
    }
  }
  return { code, applied }
}

// Lodash's global lookup ends in Function("return this")(), which never runs where `self` exists.
const UNREACHABLE_EVAL = /\|\|Function\("return this"\)\(\)/g
const EVAL = /\bFunction\(|\beval\(|\(Function,|\bFunction\.(apply|call)\(/

/** Whether bundled code may evaluate a string as JavaScript, which neither frame CSP allows. */
export const evaluatesStrings = (code) => EVAL.test(code.replace(UNREACHABLE_EVAL, ''))

// Why: after the local copy, Excalidraw lists a CDN copy of every font, which the frame CSP refuses
// (a violation per font, even with the local copy loaded).
const FONT_CDN_FALLBACK = /(\w+)\.push\(new URL\(\w+,\w+\.ASSETS_FALLBACK_URL\)\),\1/
// Why: pica's WebAssembly resizer needs 'wasm-unsafe-eval', which the srcdoc CSP refuses (it then
// falls back to JavaScript anyway, after logging a CSP violation).
const PICA_FEATURES = 'features:["js","wasm"]'
// Why: pica (also bundled inside image-blob-reduce) feature-tests workers with a data: URL, which
// worker-src refuses in both frames, logging a CSP violation each time an image is resized.
const DATA_URL_WORKER = 'new Worker("data:text/javascript;base64,".concat(code))'
const BLOB_URL_WORKER = 'new Worker(URL.createObjectURL(new Blob([atob(code)],{type:"text/javascript"})))'
// The srcdoc CSP refuses blob: workers too; throwing inside the test's executor answers "unsupported".
const NO_WORKER = '(()=>{throw new Error("no workers in this frame")})()'

/**
 * esbuild plugin adapting the dist for `frame`: 'guest' (fonts from assets/fonts, eval-free font
 * subsetting) or 'srcdoc' (fonts inlined as data: URLs, no WebAssembly). `check()` throws unless
 * every patch the frame needs was applied.
 */
export function adaptExcalidraw(frame, excalidrawDist) {
  const applied = new Set()
  const evalFree = new Set()
  const plugin = {
    name: `adapt-excalidraw-${frame}`,
    setup(context) {
      if (frame === 'guest') {
        // Why: Excalidraw's CSS names its UI font as ./fonts/…, which resolves inside assets/ as it is.
        context.onResolve({ filter: /^\.\/fonts\/.*\.woff2$/ }, () => ({ external: true }))
      }
      context.onLoad({ filter: /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/].*\.js$/ }, (args) => {
        let code = readFileSync(args.path, 'utf8').replace(
          /"\.\/fonts\/([A-Za-z]+)\/([\w.-]+\.woff2)"/g,
          (match, family, file) =>
            // Why `local:`: Excalidraw resolves that prefix to no URL, so it never fetches the font.
            SKIPPED_FONT_FAMILIES.has(family)
              ? JSON.stringify(`local:${family}`)
              : frame === 'srcdoc'
                ? JSON.stringify(dataUrl(path.join(excalidrawDist, 'fonts', family, file)))
                : match
        )
        if (frame === 'guest' && FONT_CDN_FALLBACK.test(code)) {
          code = code.replace(FONT_CDN_FALLBACK, '$1')
          applied.add('font CDN fallback')
        }
        if (frame === 'srcdoc' && code.includes(PICA_FEATURES)) {
          code = code.replaceAll(PICA_FEATURES, 'features:["js"]')
          applied.add('pica WebAssembly')
        }
        if (frame === 'guest') {
          const rewritten = rewriteEvalFree(code)
          code = rewritten.code
          rewritten.applied.forEach((index) => evalFree.add(index))
        }
        return { contents: code, loader: 'js' }
      })
      context.onLoad({ filter: /[\\/]node_modules[\\/](pica|image-blob-reduce)[\\/]dist[\\/][\w.-]+\.m?js$/ }, (args) => {
        const code = readFileSync(args.path, 'utf8')
        if (!code.includes(DATA_URL_WORKER)) {
          return undefined
        }
        applied.add(`worker test in ${args.path.includes('image-blob-reduce') ? 'image-blob-reduce' : 'pica'}`)
        return { contents: code.replaceAll(DATA_URL_WORKER, frame === 'guest' ? BLOB_URL_WORKER : NO_WORKER), loader: 'js' }
      })
    }
  }
  const required = [
    'worker test in pica',
    'worker test in image-blob-reduce',
    ...(frame === 'guest' ? ['font CDN fallback'] : ['pica WebAssembly'])
  ]
  const check = () => {
    const missing = required.filter((name) => !applied.has(name))
    if (frame === 'guest' && evalFree.size !== EVAL_FREE_REWRITES.length) {
      missing.push("eval-free font subsetter glue (the Emscripten glue changed; recheck it for Function)")
    }
    if (missing.length > 0) {
      throw new Error(`Excalidraw changed; these ${frame} patches no longer apply: ${missing.join(', ')}`)
    }
  }
  return { plugin, check }
}

const dataUrl = (file) => `data:font/woff2;base64,${readFileSync(file).toString('base64')}`
