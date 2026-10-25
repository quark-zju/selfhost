export const HOLD_DURATION_MS = 2000;

// One continuous hold; cancellation never leaves a delayed destructive action.
export class HoldAction {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private action: () => void;
  private holding: (active: boolean) => void;
  private clock: {
    setTimeout: (
      action: () => void,
      delay: number,
    ) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  };
  constructor(
    action: () => void,
    holding: (active: boolean) => void,
    clock = {
      setTimeout: (action: () => void, delay: number) =>
        setTimeout(action, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) =>
        clearTimeout(timer),
    },
  ) {
    this.action = action;
    this.holding = holding;
    this.clock = clock;
  }
  start() {
    if (this.timer !== undefined) return;
    this.holding(true);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.holding(false);
      this.action();
    }, HOLD_DURATION_MS);
  }
  cancel() {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.holding(false);
  }
}
