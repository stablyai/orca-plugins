// Orca custom editor for .excalidraw files. Orca owns the buffer, dirty state and saving; this frame
// renders the document's text and posts full-text edits back (see build/README.md).
// The baseline, version gating, `source` preservation and flush follow stablyai/orca#27413 by
// Roughriver74, which first brought Excalidraw into Orca's editor.
// Each entry (main.js, srcdoc/entry.js) adapts the frame first, then imports this file.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  defaultLang,
  getNonDeletedElements,
  hashElementsVersion,
  isElementLink,
  languages,
  restore,
  serializeAsJSON,
  useHandleLibrary
} from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { parseExcalidrawScene, withExcalidrawSceneSource } from './excalidraw-scene.js'
import { libraryAdapter, libraryPersists, onLibraryStored } from './library-storage.js'
import { canSaveFiles } from './orca-file-access.js'

const EDIT_DEBOUNCE_MS = 250
const EXTERNAL_LINK = /^(https?|mailto):/i
// Why: Orca sends the theme just after the frame loads; past this, assume light rather than stay blank.
const THEME_WAIT_MS = 1000

/** Host APIs beyond the document. Read once Orca's hello has arrived, which can change them. */
function readFeatures() {
  return {
    saveFiles: canSaveFiles(),
    openLinks:
      typeof window.orca?.shell?.openExternal === 'function' &&
      window.orca.host?.has?.('shell.openExternal') !== false
  }
}

function uiOptions(features) {
  return {
    canvasActions: {
      // Why: Orca owns the document and saves it; "Save to…" and image export write copies elsewhere.
      loadScene: false,
      saveToActiveFile: false,
      export: features.saveFiles ? { saveFileToDisk: true } : false,
      saveAsImage: features.saveFiles,
      toggleTheme: false,
      changeViewBackgroundColor: true,
      clearCanvas: true
    },
    tools: { image: true }
  }
}

/** The first of Orca's UI locale and the browser languages that Excalidraw has a translation for. */
function pickLanguage() {
  const codes = languages.map((language) => language.code)
  const tags = [window.orca?.locale, ...(navigator.languages ?? [navigator.language])]
  for (const tag of tags.filter((tag) => typeof tag === 'string' && tag !== '')) {
    const exact = codes.find((code) => code.toLowerCase() === tag.toLowerCase())
    const base = tag.split('-')[0].toLowerCase()
    const sameLanguage = codes.find((code) => code.split('-')[0].toLowerCase() === base)
    if (exact ?? sameLanguage) {
      return exact ?? sameLanguage
    }
  }
  return defaultLang.code
}

/** 'dark' or 'light' once Orca has set the theme class, otherwise null. */
function readTheme() {
  const classes = document.documentElement.classList
  return classes.contains('dark') ? 'dark' : classes.contains('light') ? 'light' : null
}

/** Changes that reach the saved file; selection, scroll and zoom do not. */
function sceneVersion(elements, appState, files) {
  return [
    hashElementsVersion(elements),
    appState.viewBackgroundColor,
    appState.gridModeEnabled,
    appState.gridSize,
    appState.gridStep,
    Object.keys(files).length
  ].join(':')
}

function restoreScene(data) {
  return restore(data, null, null, { repairBindings: true })
}

const versionsOf = (elements) => new Map(elements.map((element) => [element.id, element.version]))

/**
 * The outside scene with this canvas's unsent changes laid over it, or null when there are none.
 * `agreed` holds the element versions Orca last had from this canvas; anything else is unsent.
 */
function mergeUnsent(scene, latest, agreed) {
  const remote = versionsOf(scene.elements)
  const unsent = latest.elements.filter(
    (element) => agreed.get(element.id) !== element.version && remote.get(element.id) !== element.version
  )
  if (unsent.length === 0) {
    return null
  }
  const byId = new Map(scene.elements.map((element) => [element.id, element]))
  for (const element of unsent) {
    byId.set(element.id, element)
  }
  return { ...scene, elements: [...byId.values()], files: { ...latest.files, ...scene.files } }
}

function useTheme() {
  const [theme, setTheme] = useState(readTheme)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme((current) => readTheme() ?? current))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    const timer = window.setTimeout(() => setTheme((current) => current ?? 'light'), THEME_WAIT_MS)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [])
  return theme
}

function onLinkOpen(element, event, api, features) {
  event.preventDefault()
  const link = element.link
  if (isElementLink(link)) {
    api?.scrollToContent(link, { animate: true })
  } else if (features.openLinks && EXTERNAL_LINK.test(link)) {
    window.orca.shell.openExternal(link).catch(() => {})
  }
}

function PersistedLibrary({ api }) {
  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter })
  // Why: another tab's save would otherwise be overwritten by this tab's next one.
  useEffect(() => onLibraryStored((libraryItems) => api.updateLibrary({ libraryItems })), [api])
  return null
}

function App() {
  const theme = useTheme()
  const ready = theme !== null
  // Why after the theme: Orca's hello brings the theme together with its locale and host methods.
  // Why only isolated: the single-file build carries English alone (build.mjs defines __EDITOR_FRAME__).
  const language = useMemo(
    () => (ready && __EDITOR_FRAME__ === 'guest' ? pickLanguage() : defaultLang.code),
    [ready]
  )
  const features = useMemo(() => (ready ? readFeatures() : { saveFiles: false, openLinks: false }), [ready])
  const options = useMemo(() => uiOptions(features), [features])
  const [view, setView] = useState({ status: 'waiting' })
  const apiRef = useRef(null)
  // useHandleLibrary needs the API as state; the document session reads the ref.
  const [api, setApi] = useState(null)
  // Mutable editing session; message handlers and onChange read it without re-rendering.
  const session = useRef({
    source: undefined,
    readOnly: true,
    // Why: Excalidraw repairs and normalizes scenes as it loads them, so the baseline is the first
    // scene onChange reports after a load, not the raw text; otherwise opening a file dirties it.
    awaitingBaseline: false,
    baseline: null,
    // The Orca document version the canvas shows; every edit names it so Orca can refuse stale ones.
    documentVersion: null,
    version: null,
    latest: null,
    lastPosted: null,
    // Element versions Orca has from this canvas, so an outside change keeps what was not sent yet.
    agreed: new Map(),
    // An outside change was merged with unsent changes, which must be sent once it has loaded.
    sendAfterLoad: false,
    timer: undefined,
    mounts: 0
  })

  useEffect(() => {
    const s = session.current

    const serialize = ({ elements, appState, files }) =>
      withExcalidrawSceneSource(
        serializeAsJSON(getNonDeletedElements(elements), appState, files, 'local'),
        s.source
      )

    const flush = () => {
      window.clearTimeout(s.timer)
      s.timer = undefined
      if (s.readOnly || s.baseline === null || s.latest === null || s.documentVersion === null) {
        return
      }
      const next = serialize(s.latest)
      if (next === s.baseline) {
        return
      }
      s.baseline = next
      s.lastPosted = next
      const sent = versionsOf(s.latest.elements)
      return window.orca.document
        .applyEdit({ baseVersion: s.documentVersion, content: { kind: 'text', text: next } })
        .then(
          () => {
            s.agreed = sent
          },
          (error) => {
            // Orca kept its text: forget what this canvas last sent, so the next change sends the
            // whole scene again (a conflict also brings the newer document, which merges it).
            s.baseline = ''
            s.lastPosted = null
            // Why rethrow: a save waiting on this flush must fail rather than write the older text.
            throw error
          }
        )
    }
    const flushQuietly = () => flush()?.catch(() => {})

    s.onChange = (elements, appState, files) => {
      if (appState.isLoading) {
        return
      }
      s.latest = { elements, appState, files }
      const version = sceneVersion(elements, appState, files)
      if (s.awaitingBaseline) {
        s.awaitingBaseline = false
        s.version = version
        if (s.sendAfterLoad) {
          // The merged scene differs from Orca's text by the unsent changes: send it.
          s.sendAfterLoad = false
          s.baseline = ''
          s.timer = window.setTimeout(flushQuietly, EDIT_DEBOUNCE_MS)
        } else {
          s.baseline = serialize(s.latest)
          s.agreed = versionsOf(elements)
        }
        return
      }
      if (version === s.version) {
        return
      }
      s.version = version
      if (s.readOnly || s.baseline === null) {
        return
      }
      window.clearTimeout(s.timer)
      s.timer = window.setTimeout(flushQuietly, EDIT_DEBOUNCE_MS)
    }

    const loadDocument = (text, readOnly) => {
      const api = apiRef.current
      // Why: Orca may hand back the text this frame just posted; reloading it would drop undo history
      // and any stroke still inside the debounce window.
      if (api && text === s.lastPosted) {
        s.readOnly = readOnly
        setView((current) => (current.status === 'ready' ? { ...current, readOnly } : current))
        return
      }
      // Why: strokes made since the last edit (or refused with it) must survive an outside change.
      const unsent = api && !s.readOnly && !readOnly && s.baseline !== null ? s.latest : null
      window.clearTimeout(s.timer)
      s.timer = undefined
      s.baseline = null
      s.latest = null
      s.lastPosted = null
      s.readOnly = readOnly
      let parsed
      try {
        parsed = parseExcalidrawScene(text)
      } catch (error) {
        apiRef.current = null
        setView({ status: 'error', message: error.message })
        return
      }
      s.source = parsed.source
      const outside = restoreScene(parsed.data)
      const merged = unsent ? mergeUnsent(outside, unsent, s.agreed) : null
      const scene = merged ?? outside
      s.agreed = versionsOf(outside.elements)
      s.sendAfterLoad = merged !== null
      s.awaitingBaseline = true
      if (api) {
        api.addFiles(Object.values(scene.files))
        api.updateScene({
          elements: scene.elements,
          appState: {
            viewBackgroundColor: scene.appState.viewBackgroundColor,
            gridModeEnabled: scene.appState.gridModeEnabled,
            gridSize: scene.appState.gridSize,
            gridStep: scene.appState.gridStep
          },
          captureUpdate: CaptureUpdateAction.NEVER
        })
        api.history.clear()
        setView((current) => ({ ...current, readOnly }))
        return
      }
      s.mounts += 1
      setView({
        status: 'ready',
        readOnly,
        mountKey: s.mounts,
        initialData: { ...scene, scrollToContent: true }
      })
    }

    const onDocument = (doc) => {
      if (Number.isSafeInteger(doc.version) && doc.content?.kind === 'text') {
        s.documentVersion = doc.version
        loadDocument(doc.content.text, doc.readOnly === true)
      }
    }
    // Why: closing the tab or hiding the frame may come before the debounce fires.
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        flushQuietly()
      }
    }
    window.addEventListener('pagehide', flushQuietly)
    document.addEventListener('visibilitychange', onHide)
    // Orca waits for the returned promise before it saves.
    const subscriptions = [
      window.orca.document.onDidChange(onDocument),
      window.orca.on('editor.flush', () => flush())
    ]
    return () => {
      window.removeEventListener('pagehide', flushQuietly)
      document.removeEventListener('visibilitychange', onHide)
      subscriptions.forEach((subscription) => subscription.dispose())
    }
  }, [])

  // Why: mounting before the theme is known would flash a light canvas in a dark Orca.
  if (view.status === 'waiting' || !ready) {
    return null
  }
  if (view.status === 'error') {
    return (
      <div className="orca-excalidraw-message" role="alert">
        Cannot display this file as an Excalidraw drawing: {view.message}. Switch to Source to fix
        it.
      </div>
    )
  }
  return (
    <>
      {libraryPersists && api && <PersistedLibrary api={api} />}
      <Excalidraw
        key={view.mountKey}
        initialData={view.initialData}
        excalidrawAPI={(next) => {
          apiRef.current = next
          setApi(next)
        }}
        onChange={(elements, appState, files) => session.current.onChange?.(elements, appState, files)}
        onLinkOpen={(element, event) => onLinkOpen(element, event, apiRef.current, features)}
        validateEmbeddable={false}
        aiEnabled={false}
        theme={theme}
        langCode={language}
        viewModeEnabled={view.readOnly}
        UIOptions={options}
      >
        <MainMenu>
          {features.saveFiles && <MainMenu.DefaultItems.Export />}
          {features.saveFiles && <MainMenu.DefaultItems.SaveAsImage />}
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Hints.ToolbarHint />
          <WelcomeScreen.Hints.MenuHint>
            {features.saveFiles ? 'Export, search, help and canvas background' : 'Search, help and canvas background'}
          </WelcomeScreen.Hints.MenuHint>
          <WelcomeScreen.Hints.HelpHint />
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Logo />
            <WelcomeScreen.Center.Heading>Pick a tool and start drawing</WelcomeScreen.Center.Heading>
          </WelcomeScreen.Center>
        </WelcomeScreen>
      </Excalidraw>
    </>
  )
}

// Why the flag: index.html falls back to the inlined editor, or a message, when none has started.
if (!window.orcaExcalidrawStarted) {
  window.orcaExcalidrawStarted = true
  createRoot(document.getElementById('root')).render(<App />)
  window.dispatchEvent(new Event('orca-excalidraw-started'))
}
