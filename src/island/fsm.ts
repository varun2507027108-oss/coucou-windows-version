// Island open/close FSM — port of IslandStateMachine.swift.
// No DOM, no Tauri: it only reports transitions.

export type FsmState = "hidden" | "petit" | "home" | "coucou";

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /** home → petit delay, seconds. */
  homeToPetitDelay = 15;
  /** petit → hidden delay, seconds. */
  petitToHiddenDelay = 60;
  /** coucou → petit once the greeting animation ends (no hover). */
  greetAutoCollapseDelay = 0.6;
  /** coucou → petit while the mouse hovers the greeting. */
  greetHoverCollapseDelay = 10;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;

  private petitHide: number | null = null;
  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("coucou");
  }

  mouseEntered() {
    switch (this.state) {
      case "hidden":
        this.cancelTimers();
        this.transition("petit");
        break;
      case "petit":
        this.clear("petitHide");
        break;
      case "home":
        this.clear("homeCollapse");
        break;
      case "coucou":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  mouseLeft() {
    // A card that is waiting for an answer holds the island open. Auto-closing it
    // mid-decision leaves the user staring at a compact pill with an unanswered
    // permission request — the thing the whole app exists to avoid.
    if (this.pinned) return;
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.schedulePetitHide();
        break;
      case "home":
        this.scheduleHomeCollapse();
        break;
      case "coucou":
        this.clear("greetCollapse");
        this.transition("petit");
        break;
    }
  }

  /**
   * Compact island clicked.
   *
   * Accepts `hidden` and `coucou` as well as `petit`: after an alert the island
   * can be on screen while the FSM never saw the mouse enter (it was already
   * there), and a click during the greeting has to open it too. Ignoring those
   * left the island stuck — expanded, and with no click that did anything.
   */
  click() {
    if (this.state === "home") return;
    this.cancelTimers();
    this.transition("home");
  }

  /**
   * The app hid the island on its own (e.g. when the last task ends).
   * Mirror it without side effects, so the next hover peeks again
   * instead of being swallowed by a FSM that still thinks the island is `petit`.
   */
  hiddenExternally() {
    if (this.state !== "petit") return;
    this.cancelTimers();
    this.state = "hidden";
  }

  /**
   * The app expanded the island itself — a hook alert, or a tab the user clicked.
   *
   * Timers are cancelled and the state is synced to `home` *without* firing
   * `onTransition`, because the app has already done the expanding. Firing it
   * would make the listener redraw the view it was just told to show.
   *
   * Without this the FSM still believed the island was hidden, so the next
   * `mouseEntered`/`mouseLeft` collapsed an island the user was looking at. This
   * is the Windows half of upstream's `openedExternally()` (3186879).
   */
  openedExternally() {
    this.cancelTimers();
    if (this.state === "home" || this.state === "coucou") return;
    this.state = "home";
  }

  /**
   * The app folded the island itself (Escape, Settings, OK button, auto-close).
   * Move to `petit` right away so hover and click keep working; waiting for the
   * 15 s home timer left the island compact on screen while the FSM still said `home`.
   */
  collapse() {
    if (this.state !== "home" && this.state !== "coucou") return;
    this.cancelTimers();
    this.transition("petit");
  }

  /** Greeting animation finished (T.end). Doesn't override a running hover timer. */
  greetComplete() {
    if (this.state !== "coucou") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    this.transition("petit");
    this.schedulePetitHide();
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.transition("home");
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.cancelTimers();
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private schedulePetitHide() {
    this.clear("petitHide");
    this.petitHide = window.setTimeout(() => {
      this.petitHide = null;
      if (this.state === "petit") this.transition("hidden");
    }, this.petitToHiddenDelay * 1000);
  }

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    if (this.pinned) return;
    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      if (this.state === "home") this.transition("petit");
    }, this.homeToPetitDelay * 1000);
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    this.greetCollapse = window.setTimeout(() => {
      this.greetCollapse = null;
      if (this.state === "coucou") this.transition("petit");
    }, delay * 1000);
  }

  private clear(which: "petitHide" | "homeCollapse" | "greetCollapse") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
  }

  cancelTimers() {
    this.clear("petitHide");
    this.clear("homeCollapse");
    this.clear("greetCollapse");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
