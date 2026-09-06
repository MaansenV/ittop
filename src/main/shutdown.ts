export interface ShutdownStep {
  name: string
  run: () => Promise<void>
}

// Serializes app shutdown: every quit request awaits the SAME drain, all
// steps run even if one fails, errors are collected (never thrown — a
// rejected shutdown would stall Electron's quit), and quit() fires exactly
// once. A renewed request during the drain joins it; it never bypasses it.
export class AppShutdown {
  private state: 'running' | 'draining' | 'complete' = 'running'
  private promise: Promise<void> | null = null

  constructor(
    private readonly steps: ShutdownStep[],
    private readonly quit: () => void,
    private readonly log: (message: string) => void,
  ) {}

  get settled(): boolean {
    return this.state === 'complete'
  }

  requestQuit(): Promise<void> {
    if (!this.promise) {
      this.state = 'draining'
      const run = (async () => {
        for (const step of this.steps) {
          try {
            await step.run()
          } catch (e) {
            this.log(`shutdown step '${step.name}' failed: ${(e as Error).message}`)
          }
        }
        this.state = 'complete'
        this.quit()
      })()
      this.promise = run
    }
    return this.promise
  }
}
