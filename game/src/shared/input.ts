export interface PadHandlers {
  /** Finger (or Space) went down. */
  down?: () => void;
  /** Finger (or Space) lifted, whether or not it swiped. */
  up?: () => void;
  /** Finger travelled upward past the threshold while down (or W / ArrowUp). Fires once per touch. */
  swipeUp?: () => void;
  /** Finger travelled downward past the threshold while down (or S / ArrowDown). */
  swipeDown?: () => void;
}

/**
 * One-thumb touch surface over the whole screen with desktop key fallbacks.
 * Read `held` for continuous input; handlers fire on edges.
 */
export class TouchPad {
  held = false;
  enabled = true;
  private startY = 0;
  private swiped = false;
  private pointer = -1;

  constructor(el: HTMLElement, private h: PadHandlers, private threshold = 34) {
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.pointer !== -1) return;
      e.preventDefault();
      this.pointer = e.pointerId;
      el.setPointerCapture?.(e.pointerId);
      this.startY = e.clientY;
      this.swiped = false;
      this.held = true;
      this.h.down?.();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointer || this.swiped) return;
      const dy = e.clientY - this.startY;
      if (dy < -this.threshold) {
        this.swiped = true;
        this.h.swipeUp?.();
      } else if (dy > this.threshold) {
        this.swiped = true;
        this.h.swipeDown?.();
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = -1;
      this.held = false;
      if (this.enabled) this.h.up?.();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.repeat) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.held = true;
        this.h.down?.();
      } else if (e.code === 'ArrowUp' || e.code === 'KeyW') this.h.swipeUp?.();
      else if (e.code === 'ArrowDown' || e.code === 'KeyS') this.h.swipeDown?.();
    });
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' || !this.enabled) return;
      this.held = false;
      this.h.up?.();
    });
  }
}
