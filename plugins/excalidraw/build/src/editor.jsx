// Orca custom editor for .excalidraw files, and for .excalidraw.svg and .excalidraw.png images that
// embed their scene (editor/image.html). Orca owns the buffer, dirty state and saving; the
// document session (scene-sync.js) sends the canvas's changes and merges outside ones, and an
// image's picture is drawn again after each change (picture-sync.js; see build/README.md).
// `source` preservation and the load baseline follow stablyai/orca#27413 by
// Roughriver74, which first brought Excalidraw into Orca's editor. main.js imports this file.
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
import { SAVED_APP_STATE, editedScene, openSceneSession, pickSavedAppState } from './scene-sync.js'
import { syncPicture } from './picture-sync.js'
import { SCALES, drawPicture, lookOf, rememberLook } from './picture-render.js'
import { libraryAdapter, onLibraryStored } from './library-storage.js'
import { canSaveFiles } from './orca-file-access.js'

const EXTERNAL_LINK = /^(https?|mailto):/i
/** Set by image.html: the document is an .excalidraw.svg or .excalidraw.png picture. */
const IMAGE = document.documentElement.dataset.document === 'image'

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

/** Changes that reach the saved file; selection, scroll and zoom do not. */
function sceneVersion(elements, appState, files) {
  return [hashElementsVersion(elements), ...SAVED_APP_STATE.map((key) => appState[key]), Object.keys(files).length].join(':')
}

const restoreScene = (scene) => restore(scene, null, null, { repairBindings: true })
const serialize = (scene) => serializeAsJSON(getNonDeletedElements(scene.elements), scene.appState, scene.files, 'local')
const readTheme = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')

function useTheme() {
  const [theme, setTheme] = useState(readTheme)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

function onLinkOpen(element, event, api, features) {
  event.preventDefault()
  const link = element.link
  if (isElementLink(link)) {
    api?.scrollToContent(link, { animate: true })
  } else if (features.openLinks && EXTERNAL_LINK.test(link)) {
    // Why the toast: otherwise a link Orca could not ask about (say, its window was hidden) does
    // nothing at all. A cancelled prompt was the person's choice, so it shows nothing.
    const couldNotAsk = () => api?.setToast({ message: "Orca couldn't ask to open this link", closable: true })
    window.orca.shell.openExternal(link).then((result) => {
      if (result?.opened === false && result.reason === 'consent-unavailable') {
        couldNotAsk()
      }
    }, couldNotAsk)
  }
}

function PersistedLibrary({ api }) {
  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter })
  // Why: another tab's save would otherwise be overwritten by this tab's next one.
  useEffect(() => onLibraryStored((libraryItems) => api.updateLibrary({ libraryItems })), [api])
  return null
}

/**
 * The main menu's picture options for an image: how this file's picture is drawn. A new file's
 * picture starts with the options last picked.
 */
function PictureOptions({ doc, picture }) {
  const [look, setLook] = useState(null)
  // Why read on each replacement: an outside change can bring a picture with another look.
  const [read, setRead] = useState(0)
  useEffect(() => {
    const replaced = doc.onReplace(() => setRead((count) => count + 1))
    return () => replaced.dispose()
  }, [doc])
  useEffect(() => {
    let current = true
    lookOf(doc.value).then((next) => current && setLook(next))
    return () => {
      current = false
    }
  }, [doc, read])
  if (!look) {
    return null
  }
  const pick = (event, change) => {
    // Why: the menu stays open, so several options can be picked in a row.
    event.preventDefault()
    const next = { ...look, ...change }
    rememberLook(next)
    setLook(next)
    doc.change({ ...doc.value, look: next, stale: true })
    picture.schedule()
  }
  const nextScale = SCALES[(SCALES.indexOf(look.scale) + 1) % SCALES.length]
  return (
    <MainMenu.Group title="Picture in this file">
      <MainMenu.Item onSelect={(event) => pick(event, { scale: nextScale })} shortcut={`${look.scale}×`}>
        Scale
      </MainMenu.Item>
      <MainMenu.Item onSelect={(event) => pick(event, { background: !look.background })} shortcut={look.background ? 'On' : 'Off'}>
        Background
      </MainMenu.Item>
      <MainMenu.Item onSelect={(event) => pick(event, { dark: !look.dark })} shortcut={look.dark ? 'On' : 'Off'}>
        Dark mode
      </MainMenu.Item>
    </MainMenu.Group>
  )
}

function App({ doc, picture, onApi }) {
  const theme = useTheme()
  // Read once: the session started after Orca's hello brought the locale and host methods.
  const [language] = useState(pickLanguage)
  const [features] = useState(readFeatures)
  const options = useMemo(() => uiOptions(features), [features])
  const [view, setView] = useState(() => ({ scene: doc.value, mountKey: 0 }))
  const [readOnly, setReadOnly] = useState(doc.readOnly)
  const apiRef = useRef(null)
  // useHandleLibrary needs the API as state; the sync reads the ref.
  const [api, setApi] = useState(null)
  // The version the canvas last loaded or sent; undefined until the first change after a load.
  const shown = useRef(undefined)

  useEffect(() => {
    const replaced = doc.onReplace((scene) => {
      const api = apiRef.current
      shown.current = undefined
      if (!api || scene.error || view.scene.error) {
        setView((current) => ({ scene, mountKey: current.mountKey + 1 }))
        return
      }
      const restored = restoreScene(scene)
      api.addFiles(Object.values(restored.files))
      api.updateScene({ elements: restored.elements, appState: pickSavedAppState(restored.appState), captureUpdate: CaptureUpdateAction.NEVER })
      api.history.clear()
    })
    const readOnlyChanges = window.orca.document.onDidChange((next) => setReadOnly(next.readOnly === true))
    return () => [replaced, readOnlyChanges].forEach((subscription) => subscription.dispose())
  }, [doc, view.scene.error])

  const initialData = useMemo(
    () => (view.scene.error ? null : { ...restoreScene(view.scene), scrollToContent: true }),
    [view.scene]
  )

  const onChange = (elements, appState, files) => {
    const version = appState.isLoading ? shown.current : sceneVersion(elements, appState, files)
    // Why: Excalidraw normalizes a scene as it loads; that is not an edit, so it only sets the mark.
    if (shown.current !== undefined && version !== shown.current) {
      doc.change(editedScene(doc.value, { elements, appState: pickSavedAppState(appState), files }))
      picture?.schedule()
    }
    shown.current = version
  }

  if (view.scene.error) {
    return (
      <div className="orca-excalidraw-message" role="alert">
        Cannot display this file as an Excalidraw drawing: {view.scene.error}.
        {view.scene.format === 'json' && ' Switch to Source to fix it.'}
      </div>
    )
  }
  return (
    <>
      {api && <PersistedLibrary api={api} />}
      <Excalidraw
        key={view.mountKey}
        initialData={initialData}
        excalidrawAPI={(next) => {
          apiRef.current = next
          setApi(next)
          onApi(next)
        }}
        onChange={onChange}
        onLinkOpen={(element, event) => onLinkOpen(element, event, apiRef.current, features)}
        validateEmbeddable={false}
        aiEnabled={false}
        theme={theme}
        langCode={language}
        viewModeEnabled={readOnly}
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
          {picture && !readOnly && <MainMenu.Separator />}
          {picture && !readOnly && <PictureOptions doc={doc} picture={picture} />}
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

let api = null
// Before the session, so a save is timed from its start (see picture-sync.js).
const picture = IMAGE
  ? syncPicture({
      render: drawPicture,
      onError: (error) => {
        console.error(error)
        api?.setToast({ message: `Couldn't update the picture in this file: ${error.message}`, closable: true })
      }
    })
  : null
// Why after the session: it starts once Orca's hello brought the theme, so a dark Orca never shows
// a light canvas.
openSceneSession(serialize, { image: IMAGE, timing: picture?.timing }).then((doc) => {
  picture?.attach(doc)
  createRoot(document.getElementById('root')).render(<App doc={doc} picture={picture} onApi={(next) => (api = next)} />)
})
