export type Pin = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    pins: { pins: Shaped<Pin[]> }
  }
}
