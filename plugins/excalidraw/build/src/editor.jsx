// Orca custom editor for .excalidraw files. Orca owns the buffer, dirty state and saving; the
// document session (scene-sync.js) sends the canvas's changes and merges outside ones (see
// build/README.md). `source` preservation and the load baseline follow stablyai/orca#27413 by
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
import { SAVED_APP_STATE, openSceneSession, pickSavedAppState } from './scene-sync.js'
import { libraryAdapter, onLibraryStored } from './library-storage.js'
import { canSaveFiles } from './orca-file-access.js'
import { effectiveTheme, onThemePreferenceStored, readThemePreference, storeThemePreference } from './theme-preference.js'

const EXTERNAL_LINK = /^(https?|mailto):/i

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
      // Why: the canvas theme can differ from Orca's; the menu's Theme item and Shift+Alt+D pick it.
      toggleTheme: true,
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
const readOrcaTheme = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')

/** Orca's theme, the picked preference ('light', 'dark' or 'system' for Orca's), and the theme shown. */
function useTheme() {
  const [orcaTheme, setOrcaTheme] = useState(readOrcaTheme)
  const [preference, setPreference] = useState(readThemePreference)
  useEffect(() => {
    const observer = new MutationObserver(() => setOrcaTheme(readOrcaTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => onThemePreferenceStored(setPreference), [])
  const pick = (next) => {
    storeThemePreference(next)
    setPreference(next)
  }
  return { theme: effectiveTheme(preference, orcaTheme), preference, pick }
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

function App({ doc }) {
  const { theme, preference, pick } = useTheme()
  // The theme Excalidraw last reported, to tell Shift+Alt+D from a change of the `theme` prop.
  const reportedTheme = useRef(theme)
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
    // Why both checks: Shift+Alt+D changes Excalidraw's theme without the menu, so keep it as the
    // pick. After the prop changes, Excalidraw reports once more with the old theme; that is
    // not a change from the last report, so it is not taken for a pick.
    if (appState.theme !== reportedTheme.current) {
      reportedTheme.current = appState.theme
      if (appState.theme !== theme) {
        pick(appState.theme)
      }
    }
    const version = appState.isLoading ? shown.current : sceneVersion(elements, appState, files)
    // Why: Excalidraw normalizes a scene as it loads; that is not an edit, so it only sets the mark.
    if (shown.current !== undefined && version !== shown.current) {
      doc.change({ elements, appState: pickSavedAppState(appState), files, source: doc.value.source })
    }
    shown.current = version
  }

  if (view.scene.error) {
    return (
      <div className="orca-excalidraw-message" role="alert">
        Cannot display this file as an Excalidraw drawing: {view.scene.error}. Switch to Source to
        fix it.
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
          {/* "System" follows Orca's theme. */}
          <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={preference} onSelect={pick} />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Hints.ToolbarHint />
          <WelcomeScreen.Hints.MenuHint>
            {features.saveFiles ? 'Export, search, help, theme and canvas background' : 'Search, help, theme and canvas background'}
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

// Why after the session: it starts once Orca's hello brought the theme, so a dark Orca never shows
// a light canvas.
openSceneSession(serialize).then((doc) => createRoot(document.getElementById('root')).render(<App doc={doc} />))
