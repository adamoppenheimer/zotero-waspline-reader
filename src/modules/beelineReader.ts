const BEE_LINE_BUTTON_ID = "waspline-reader-toggle";
const CHARACTERS_PER_CYCLE = 48;

const BLUE: [number, number, number] = [26, 115, 232];
const RED: [number, number, number] = [220, 38, 38];
const BLACK: [number, number, number] = [17, 24, 39];
const WHITE: [number, number, number] = [241, 245, 249];

interface ReaderState {
  enabled: boolean;
  observer?: MutationObserver;
  refreshTimer?: number;
}

class BeeLineReaderService {
  private readonly stateByReader = new Map<string, ReaderState>();

  private readonly toolbarHandler: _ZoteroTypes.Reader.EventHandler<"renderToolbar"> = (
    event,
  ) => {
    const { reader, doc, append } = event;
    if (reader.type !== "pdf") {
      return;
    }

    const state = this.ensureReaderState(reader);

    if (!doc.getElementById(BEE_LINE_BUTTON_ID)) {
      const button = doc.createElement("button");
      button.id = BEE_LINE_BUTTON_ID;
      button.type = "button";
      button.className = "toolbarButton";
      button.textContent = "BeeLine";
      button.addEventListener("click", () => {
        state.enabled = !state.enabled;
        this.updateButtonState(button, state.enabled);
        this.refreshReader(reader);
      });
      this.updateButtonState(button, state.enabled);
      append(button);
    }

    this.observeReaderTextLayer(reader);
    this.refreshReader(reader);
  };

  start() {
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      this.toolbarHandler,
      addon.data.config.addonID,
    );
  }

  stop() {
    Zotero.Reader.unregisterEventListener("renderToolbar", this.toolbarHandler);
    for (const reader of Zotero.Reader._readers as _ZoteroTypes.ReaderInstance[]) {
      this.clearReader(reader);
    }
    this.stateByReader.clear();
  }

  private ensureReaderState(reader: _ZoteroTypes.ReaderInstance): ReaderState {
    const key = reader._instanceID;
    let state = this.stateByReader.get(key);
    if (!state) {
      state = { enabled: true };
      this.stateByReader.set(key, state);
    }
    return state;
  }

  private observeReaderTextLayer(reader: _ZoteroTypes.ReaderInstance) {
    const iframeWindow = reader._iframeWindow;
    if (!iframeWindow) {
      return;
    }

    const state = this.ensureReaderState(reader);
    if (state.observer) {
      return;
    }

    const target = iframeWindow.document.body;
    if (!target) {
      return;
    }

    state.observer = new iframeWindow.MutationObserver((mutations: MutationRecord[]) => {
      if (
        !mutations.some((mutation: MutationRecord) =>
          Array.from(mutation.addedNodes).some((node: Node | null) => {
            if (!(node instanceof iframeWindow.HTMLElement)) {
              return false;
            }
            const element = node as HTMLElement;
            return (
              element.matches(".textLayer") ||
              !!element.querySelector(".textLayer")
            );
          }),
        )
      ) {
        return;
      }

      if (state.refreshTimer) {
        iframeWindow.clearTimeout(state.refreshTimer);
      }
      state.refreshTimer = iframeWindow.setTimeout(() => {
        state.refreshTimer = undefined;
        this.refreshReader(reader);
      }, 120);
    });

    state.observer?.observe(target, { childList: true, subtree: true });
  }

  private refreshReader(reader: _ZoteroTypes.ReaderInstance) {
    const iframeWindow = reader._iframeWindow;
    if (!iframeWindow) {
      return;
    }

    const doc = iframeWindow.document;
    const textSpans = Array.from(doc.querySelectorAll(".textLayer > span"));
    const state = this.ensureReaderState(reader);

    if (!state.enabled) {
      for (const span of textSpans) {
        this.restoreSpan(span as HTMLSpanElement);
      }
      return;
    }

    const endColor = this.isDarkTheme(doc, iframeWindow) ? WHITE : BLACK;
    let charOffset = 0;

    for (const span of textSpans) {
      const el = span as HTMLSpanElement;
      const sourceText = this.getSourceText(el);
      if (!sourceText) {
        continue;
      }

      const fragment = doc.createDocumentFragment();
      const chars = Array.from(sourceText);
      for (let i = 0; i < chars.length; i++) {
        const t = ((charOffset + i) % CHARACTERS_PER_CYCLE) / CHARACTERS_PER_CYCLE;
        const color = this.sampleColor(t, endColor);
        const charNode = doc.createElement("span");
        charNode.style.color = color;
        charNode.textContent = chars[i];
        fragment.append(charNode);
      }

      el.replaceChildren(fragment);
      el.dataset.beelineApplied = "1";
      charOffset += chars.length;
    }
  }

  private getSourceText(span: HTMLSpanElement): string {
    if (span.dataset.beelineOriginal) {
      return span.dataset.beelineOriginal;
    }

    const text = span.textContent || "";
    span.dataset.beelineOriginal = text;
    return text;
  }

  private restoreSpan(span: HTMLSpanElement) {
    if (span.dataset.beelineApplied !== "1") {
      return;
    }

    span.textContent = span.dataset.beelineOriginal || span.textContent;
    delete span.dataset.beelineApplied;
  }

  private clearReader(reader: _ZoteroTypes.ReaderInstance) {
    const state = this.stateByReader.get(reader._instanceID);
    if (!state) {
      return;
    }

    const iframeWindow = reader._iframeWindow;
    if (state.refreshTimer && iframeWindow) {
      iframeWindow.clearTimeout(state.refreshTimer);
    }
    state.observer?.disconnect();

    if (iframeWindow) {
      const textSpans = Array.from(
        iframeWindow.document.querySelectorAll(".textLayer > span"),
      );
      for (const span of textSpans) {
        this.restoreSpan(span as HTMLSpanElement);
      }
    }
  }

  private updateButtonState(button: HTMLButtonElement, enabled: boolean) {
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.style.fontWeight = enabled ? "600" : "400";
    button.style.opacity = enabled ? "1" : "0.7";
  }

  private isDarkTheme(doc: Document, win: Window) {
    return (
      !!doc.documentElement?.classList.contains("theme-dark") ||
      !!win.matchMedia("(prefers-color-scheme: dark)")?.matches
    );
  }

  private sampleColor(t: number, endColor: [number, number, number]) {
    if (t < 0.5) {
      return this.interpolate(BLUE, RED, t * 2);
    }
    return this.interpolate(RED, endColor, (t - 0.5) * 2);
  }

  private interpolate(
    from: [number, number, number],
    to: [number, number, number],
    t: number,
  ) {
    const channel = (i: number) => Math.round(from[i] + (to[i] - from[i]) * t);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  }
}

export const BeeLineReader = new BeeLineReaderService();
