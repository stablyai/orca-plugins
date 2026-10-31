// Inlined at the end of editor/index.html. An isolated frame (orca-plugin-frame:) loads the
// multi-file editor from ./assets; a srcdoc frame, whose CSP allows only inline code, runs the
// single-file editor kept inert in this page. Whichever starts sets window.orcaExcalidrawStarted.
;(function (assets) {
  var STALL_MS = 10000
  var root = document.getElementById('root')
  var inlined = [document.getElementById('orca-excalidraw-css'), document.getElementById('orca-excalidraw-js')]
  var settled = false

  function add(parent, tag, properties) {
    var element = document.createElement(tag)
    Object.keys(properties).forEach(function (name) { element[name] = properties[name] })
    parent.appendChild(element)
    return element
  }
  function discardInlined() {
    inlined.forEach(function (element) { if (element) element.remove() })
  }
  function runInlined() {
    if (settled || window.orcaExcalidrawStarted || !inlined[1]) return
    settled = true
    document.documentElement.classList.add('orca-excalidraw-srcdoc')
    add(document.head, 'style', { textContent: inlined[0].textContent })
    var code = inlined[1].textContent
    discardInlined()
    add(document.body, 'script', { textContent: code })
    window.setTimeout(failed, STALL_MS)
  }
  function failed() {
    if (window.orcaExcalidrawStarted) return
    root.innerHTML = '<div class="orca-excalidraw-message" role="alert">Excalidraw could not start. ' +
      'Reopen the file, or update Orca; meanwhile, switch to Source to edit it as text.</div>'
  }
  window.addEventListener('orca-excalidraw-started', function () {
    settled = true
    discardInlined()
  })

  if (location.protocol !== 'orca-plugin-frame:') {
    runInlined()
    return
  }
  add(document.head, 'link', { rel: 'stylesheet', href: assets.css })
  assets.preload.forEach(function (href) { add(document.head, 'link', { rel: 'modulepreload', href: href }) })
  // Why the fallbacks: a missing or broken asset would otherwise leave a blank tab.
  add(document.head, 'script', { type: 'module', src: assets.entry, onerror: runInlined })
  window.setTimeout(runInlined, STALL_MS)
})(__ASSETS__)
