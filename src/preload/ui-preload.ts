// Preload for the UI window's view (sandbox: false, contextIsolation: true).
import { contextBridge, ipcRenderer } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'
import { channel, type StageApi, type StageState, type UiCommands, type UiQueries } from '../shared/contract'

injectBrowserAction() // the <browser-action-list> element for extension icons

const command =
  <K extends keyof UiCommands>(name: K) =>
  (...args: UiCommands[K]) =>
    ipcRenderer.send(channel(name), ...args)

const query =
  <K extends keyof UiQueries>(name: K) =>
  (...args: UiQueries[K]['args']): Promise<UiQueries[K]['result']> =>
    ipcRenderer.invoke(channel(name), ...args)

const api: StageApi = {
  getState: query('getState'),
  suggest: query('suggest'),
  onState(listener) {
    const handler = (_e: Electron.IpcRendererEvent, state: StageState) => listener(state)
    ipcRenderer.on(channel('state'), handler)
    return () => ipcRenderer.removeListener(channel('state'), handler)
  },
  activateTab: command('activateTab'),
  closeTab: command('closeTab'),
  moveTab: command('moveTab'),
  showTabMenu: command('showTabMenu'),
  openOmnibox: command('openOmnibox'),
  closeOverlay: command('closeOverlay'),
  submitOmnibox: command('submitOmnibox'),
  back: command('back'),
  forward: command('forward'),
  reload: command('reload'),
  setBarHover: command('setBarHover'),
  passClick: command('passClick'),
  startWindowDrag: command('startWindowDrag'),
  endWindowDrag: command('endWindowDrag'),
  windowAction: command('windowAction'),
}

contextBridge.exposeInMainWorld('stage', api)
