// Clipboard and shelf events → island state. The Rust listener is what decides a
// copy happened; the island only adds the row Rust already filtered and stored.
//
// Deliberately quiet: a new clipboard entry does not wake the island or play a
// sound. Copying something is the most frequent thing anyone does all day, and a
// history that pops the panel open on every Ctrl+C would be unusable.

import { onEvent, type ClipEntry } from "../core/bridge";
import { State } from "../core/state";

export function registerLibraryHandlers() {
  void onEvent<ClipEntry>("clipboard", (entry) => {
    // Re-check the flag: a preference can be turned off between the copy and the
    // event landing, and the user must not get rows after switching it off.
    if (!State.settings.clipboardEnabled) return;
    // De-duplicated by id *and* by text.
    //
    // The text check is what actually closes the duplicate-rows bug: the Rust
    // listener records a copy and emits it, and opening the clipboard view also
    // re-reads the clipboard, so the same text can arrive twice by two routes.
    // When the two disagreed on identity the front end had no way to tell them
    // apart and stacked both rows. Rust now keeps the original id for a repeat
    // copy, but a text check here makes the view correct even if that ever slips.
    const at = State.clipboard.findIndex((e) => e.id === entry.id || e.text === entry.text);
    if (at >= 0) {
      // Same text as an existing row: move that row up rather than adding another.
      const next = State.clipboard.slice();
      next.splice(at, 1);
      State.clipboard = [entry, ...next];
    } else {
      State.clipboard = [entry, ...State.clipboard];
    }
    const cap = State.settings.clipboardMaxEntries;
    if (cap > 0 && State.clipboard.length > cap) {
      State.clipboard = State.clipboard.slice(0, cap);
    }
    State.notify();
  });
}
