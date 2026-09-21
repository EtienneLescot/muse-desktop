import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  browserCaptureAttachment,
  browserCaptureMatchesPage,
  browserCapturePreviewSize,
  browserDownloadFilename,
  describeBrowserElement,
  IMAGE_GENERATION_NOTE,
  formatBrowserContext,
  formatBrowserCaptureContext,
  formatBrowserObservation,
  normalizeBrowserObservation,
  normalizeSameOriginTarget,
  normalizeBrowserUrl,
  createBrowserTab,
  loadBrowserTabs,
  MAX_BROWSER_TABS,
  MAX_BROWSER_DOWNLOAD_BYTES,
  saveBrowserTabs,
  type BrowserTab,
  type BrowserAnnotation,
  type BrowserAppPermission,
  type BrowserCapture,
  type BrowserCaptureRegion,
  type BrowserElementAnchor,
} from "../lib/browserAnnotate";
import { isTauriRuntime } from "../lib/env";
import { userFacingError } from "../lib/errorCopy";
import {
  buildBrowserSkillArguments,
  findBrowserSkill,
  isAdvertisedBrowserSkill,
  type BrowserSkillAction,
} from "../lib/browserSkills";
import type { HostSkill } from "../lib/hostSkills";
import type { SkillInvocationProgress } from "../lib/skills";
import { CapabilityBadge } from "./CapabilityBadge";

interface Props {
  /** Conversation identity; browser navigation must not leak across sessions. */
  sessionId: string;
  annotations: BrowserAnnotation[];
  permissions: BrowserAppPermission[];
  onAddAnnotation: (url: string, selection: string, comment: string, element?: BrowserElementAnchor | null) => void;
  onRemoveAnnotation: (id: string) => void;
  onSetPermission: (app: string, allowed: boolean) => void;
  /** Insert a bounded, provenance-labelled page context into the composer. */
  onInsertContext: (context: string) => void;
  /** Insert an explicitly captured visual page as context + image attachment. */
  onInsertCapture: (capture: BrowserCapture) => boolean;
  /** Host-owned browser skills, if the connected engine advertises them. */
  hostSkills?: readonly HostSkill[];
  /** Current renderer progress for the active host skill invocation. */
  skillProgress?: SkillInvocationProgress;
  /** Invoke one advertised host skill through the session SSOT. */
  onInvokeBrowserSkill?: (selector: string, args: string) => void;
  /** Stop the active browser skill through the session SSOT. */
  onCancelBrowserSkill?: () => Promise<void> | void;
}

/** Apps offered a computer-use toggle (explicit opt-in, default denied). */
const KNOWN_APPS = ["browser", "finder", "terminal", "editor"];

/**
 * US-19 in-app browser (scoped): a sandboxed iframe renders the URL, and
 * comments anchor to URL + selection text. Computer-use is a per-app
 * permission toggle (default denied); background operation needs an explicit
 * opt-in per app. Image generation is out of scope (honest note, no UI).
 */
export function BrowserPanel({
  sessionId,
  annotations,
  permissions,
  onAddAnnotation,
  onRemoveAnnotation,
  onSetPermission,
  onInsertContext,
  onInsertCapture,
  hostSkills = [],
  skillProgress,
  onInvokeBrowserSkill,
  onCancelBrowserSkill,
}: Props) {
  const initialTabsRef = useRef<BrowserTab[] | null>(null);
  if (initialTabsRef.current === null) {
    const stored = loadBrowserTabs(sessionId);
    initialTabsRef.current = stored.length > 0 ? stored : [createBrowserTab()];
  }
  const initialTabs = initialTabsRef.current;
  const initialTab = initialTabs[0];
  const [tabs, setTabs] = useState<BrowserTab[]>(initialTabs);
  const [activeTabId, setActiveTabId] = useState(initialTab.id);
  const [url, setUrl] = useState(initialTab.url);
  const [currentUrl, setCurrentUrl] = useState(initialTab.url);
  const [history, setHistory] = useState<string[]>(initialTab.history);
  const [historyIndex, setHistoryIndex] = useState(initialTab.historyIndex);
  const [frameKey, setFrameKey] = useState(0);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [nativeBrowserStatus, setNativeBrowserStatus] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [elementAnchor, setElementAnchor] = useState<BrowserElementAnchor | null>(null);
  const [comment, setComment] = useState("");
  const [appName, setAppName] = useState("");
  const [capture, setCapture] = useState<BrowserCapture | null>(null);
  const [captureRegion, setCaptureRegion] = useState<BrowserCaptureRegion | null>(null);
  const [captureZoom, setCaptureZoom] = useState(1);
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const [pageObservation, setPageObservation] = useState<ReturnType<typeof normalizeBrowserObservation>>(null);
  const [controlStatus, setControlStatus] = useState<string | null>(null);
  const [typeText, setTypeText] = useState("");
  const [stoppingHostSkill, setStoppingHostSkill] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const captureImageRef = useRef<HTMLImageElement>(null);
  const captureDragRef = useRef<{ x: number; y: number } | null>(null);
  const currentUrlRef = useRef(currentUrl);
  const captureGenerationRef = useRef(0);
  const selectionCleanupRef = useRef<(() => void) | null>(null);
  const browserControlsAllowedRef = useRef(false);
  currentUrlRef.current = currentUrl;

  useEffect(() => {
    saveBrowserTabs(tabs, sessionId);
  }, [sessionId, tabs]);

  useEffect(() => () => {
    selectionCleanupRef.current?.();
    selectionCleanupRef.current = null;
  }, []);

  // A native browser surface belongs to the conversation that opened it.
  // Closing it on unmount/session switch avoids leaving a stale page visible
  // after the user moves to another conversation.
  useEffect(() => () => {
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("close_native_browser", { sessionId }))
      .catch(() => {});
  }, [sessionId]);

  const normalized = normalizeBrowserUrl(currentUrl);
  const addressNormalized = normalizeBrowserUrl(url);
  const renderable = normalized !== null;
  const pageNotes =
    normalized !== null
      ? annotations.filter((a) => a.url === normalized)
      : [];

  const submitAnnotation = () => {
    if (!renderable || normalized === null || comment.trim().length === 0) return;
    onAddAnnotation(normalized, selection, comment, elementAnchor);
    setSelection("");
    setElementAnchor(null);
    setComment("");
  };

  const handleFrameLoad = () => {
    setFrameError(null);
    // Same-origin previews can provide a real browser selection without
    // asking users to copy/paste it. Cross-origin frames remain usable; the
    // access error is intentionally swallowed because it is a browser rule.
    selectionCleanupRef.current?.();
    selectionCleanupRef.current = null;
    try {
      const document = frameRef.current?.contentDocument;
      if (!document) return;
      const syncSelection = () => {
        try {
          const selected = frameRef.current?.contentWindow?.getSelection()?.toString() ?? "";
          if (selected.trim().length > 0) setSelection(selected.trim());
        } catch {
          // Cross-origin selection is unavailable by design.
        }
      };
      const syncElement = (event: MouseEvent) => {
        try {
          const target = event.target;
          setElementAnchor(
            target && typeof (target as Element).tagName === "string"
              ? describeBrowserElement(target as Element)
              : null,
          );
        } catch {
          // Cross-origin access is unavailable by design.
        }
      };
      const syncPageDownload = (event: MouseEvent) => {
        const target = event.target;
        const targetElement = target && typeof (target as Element).closest === "function"
          ? target as Element
          : null;
        const anchor = targetElement?.closest("a[href]") as HTMLAnchorElement | null;
        if (anchor === null || !anchor.hasAttribute("download")) return;
        event.preventDefault();
        if (!browserControlsAllowedRef.current) {
          setDownloadStatus("Allow computer-use for browser before saving a page download.");
          return;
        }
        setElementAnchor(describeBrowserElement(anchor));
        void downloadLink(anchor.href, anchor.getAttribute("download") ?? undefined);
      };
      document.addEventListener("selectionchange", syncSelection);
      document.addEventListener("mouseup", syncSelection);
      document.addEventListener("click", syncElement, true);
      document.addEventListener("click", syncPageDownload, true);
      selectionCleanupRef.current = () => {
        document.removeEventListener("selectionchange", syncSelection);
        document.removeEventListener("mouseup", syncSelection);
        document.removeEventListener("click", syncElement, true);
        document.removeEventListener("click", syncPageDownload, true);
      };
    } catch {
      // The iframe is cross-origin; the explicit selection field remains the
      // safe fallback and no page script is executed by Muse.
    }
  };

  const sameOriginDocument = (): Document | null => {
    try {
      return frameRef.current?.contentDocument ?? null;
    } catch {
      return null;
    }
  };

  const observePage = () => {
    if (!renderable || normalized === null) return;
    const document = sameOriginDocument();
    if (document === null) {
      setControlStatus("Page observation is unavailable for this cross-origin preview.");
      return;
    }
    const labels = (selector: string): string[] => Array.from(document.querySelectorAll(selector))
      .map((node) => {
        const element = node as HTMLElement;
        const text = (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent ?? "")
          .replace(/\s+/g, " ").trim();
        return text;
      })
      .filter((text) => text.length > 0)
      .slice(0, 20);
    const observation = normalizeBrowserObservation({
      title: document.title,
      text: document.body?.innerText ?? "",
      links: labels("a"),
      controls: labels("button, input, textarea, select"),
    });
    setPageObservation(observation);
    setControlStatus(observation ? "Page observed. Content remains untrusted data." : "Page observation returned no usable data.");
  };

  const selectedElement = (): Element | null => {
    const document = sameOriginDocument();
    if (document === null || elementAnchor === null) return null;
    try {
      return document.querySelector(elementAnchor.selector);
    } catch {
      return null;
    }
  };

  const clickSelectedElement = () => {
    if (!browserControlsAllowed) {
      setControlStatus("Allow computer-use for browser before clicking a page element.");
      return;
    }
    const element = selectedElement();
    if (element === null) {
      setControlStatus("Select an element in a same-origin page before clicking it.");
      return;
    }
    try {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: element.ownerDocument.defaultView }));
      setControlStatus(`Clicked ${elementAnchor?.selector ?? "selected element"}. Check the page for its result.`);
    } catch {
      setControlStatus("The selected element could not be clicked.");
    }
  };

  const typeIntoSelectedElement = () => {
    if (!browserControlsAllowed) {
      setControlStatus("Allow computer-use for browser before typing into a page field.");
      return;
    }
    const value = typeText.trim();
    if (value.length === 0) {
      setControlStatus("Enter text before using Type into field.");
      return;
    }
    const element = selectedElement();
    if (element === null) {
      setControlStatus("Select an input or textarea in a same-origin page first.");
      return;
    }
    const tag = element.tagName.toLowerCase();
    const inputType = (element.getAttribute("type") ?? "text").toLowerCase();
    if ((tag !== "input" && tag !== "textarea") || ["password", "file", "hidden"].includes(inputType)) {
      setControlStatus("For safety, Type into field only supports visible text inputs and textareas.");
      return;
    }
    if (element.hasAttribute("disabled") || element.hasAttribute("readonly")) {
      setControlStatus("This field is disabled or read-only.");
      return;
    }
    try {
      (element as HTMLInputElement | HTMLTextAreaElement).value = value.slice(0, 2_000);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      setTypeText("");
      setControlStatus(`Text entered in ${elementAnchor?.selector ?? "selected field"}.`);
    } catch {
      setControlStatus("The selected field could not be updated.");
    }
  };

  const navigateSelectedLink = () => {
    if (!browserControlsAllowed) {
      setControlStatus("Allow computer-use for browser before navigating a page link.");
      return;
    }
    if (!elementAnchor?.href || normalized === null) {
      setControlStatus("Select a link in the same-origin page before navigating it.");
      return;
    }
    const target = normalizeSameOriginTarget(normalized, elementAnchor.href);
    if (target === null) {
      setControlStatus("For safety, navigation is limited to the current page origin.");
      return;
    }
    navigate(target);
    setControlStatus("Navigated to the selected link.");
  };

  const openSelectedLinkInNewTab = () => {
    if (!browserControlsAllowed) {
      setControlStatus("Allow computer-use for browser before opening a new tab.");
      return;
    }
    if (!elementAnchor?.href || normalized === null) {
      setControlStatus("Select a link in the same-origin page before opening it.");
      return;
    }
    if (tabs.length >= MAX_BROWSER_TABS) {
      setControlStatus(`The browser supports up to ${MAX_BROWSER_TABS} tabs.`);
      return;
    }
    const target = normalizeSameOriginTarget(normalized, elementAnchor.href);
    if (target === null) {
      setControlStatus("For safety, navigation is limited to the current page origin.");
      return;
    }
    const tab = {
      ...createBrowserTab(),
      url: target,
      history: [target],
      historyIndex: 0,
    };
    setTabs((current) => [...current, tab]);
    activateTab(tab);
    setControlStatus("Opened the selected link in a new tab.");
  };

  const downloadLink = async (link: string | undefined, suggested?: string): Promise<void> => {
    if (!browserControlsAllowedRef.current) {
      setDownloadStatus("Allow computer-use for browser before saving a page link.");
      return;
    }
    if (!link || normalized === null) {
      setDownloadStatus("Select a link in the same-origin page before downloading it.");
      return;
    }
    try {
      const page = new URL(normalized);
      const targetUrl = normalizeSameOriginTarget(page.toString(), link);
      if (targetUrl === null) {
        setDownloadStatus("For safety, downloads are limited to the current page origin.");
        return;
      }
      const target = new URL(targetUrl);
      setDownloadStatus("Fetching the selected link…");
      let encoded: string;
      let contentType = "application/octet-stream";
      let bytes: ArrayBuffer | null = null;
      if (isTauriRuntime()) {
        // The native runtime avoids webview CORS while keeping the same
        // explicit same-origin, no-credentials and 10 MiB policy in Rust.
        const { invoke } = await import("@tauri-apps/api/core");
        const payload = await invoke<{ data?: unknown; contentType?: unknown }>(
          "browser_download_fetch",
          { pageUrl: page.toString(), targetUrl: target.toString() },
        );
        if (typeof payload?.data !== "string" || payload.data.length === 0) {
          throw new Error("native browser returned an invalid download payload");
        }
        encoded = payload.data;
        if (typeof payload.contentType === "string" && payload.contentType.trim().length > 0) {
          contentType = payload.contentType.split(";", 1)[0] || contentType;
        }
      } else {
        const response = await fetch(target.toString(), { credentials: "omit", redirect: "error" });
        if (!response.ok) throw new Error(`server returned ${response.status}`);
        const declaredLength = Number(response.headers.get("content-length") ?? "");
        if (Number.isFinite(declaredLength) && declaredLength > MAX_BROWSER_DOWNLOAD_BYTES) {
          throw new Error("the selected file exceeds the 10 MB download limit");
        }
        bytes = await response.arrayBuffer();
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_BROWSER_DOWNLOAD_BYTES) {
          throw new Error("the selected file exceeds the 10 MB download limit");
        }
        contentType = response.headers.get("content-type")?.split(";", 1)[0] || contentType;
        const binary = new Uint8Array(bytes);
        let text = "";
        for (let offset = 0; offset < binary.length; offset += 0x8000) {
          text += String.fromCharCode(...binary.subarray(offset, offset + 0x8000));
        }
        encoded = btoa(text);
      }
      const filename = browserDownloadFilename(target.toString(), suggested ?? elementAnchor?.downloadName);
      if (isTauriRuntime()) {
        const [{ save }, { invoke }] = await Promise.all([
          import("@tauri-apps/plugin-dialog"),
          import("@tauri-apps/api/core"),
        ]);
        const path = await save({
          title: "Save browser download",
          defaultPath: filename,
        });
        if (!path) {
          setDownloadStatus("Download cancelled.");
          return;
        }
        await invoke("browser_download_write", { path, data: encoded });
      } else {
        if (bytes === null) throw new Error("browser returned no download bytes");
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: contentType }));
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(objectUrl);
      }
      setDownloadStatus(`Saved ${filename}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDownloadStatus(`Download failed: ${userFacingError(message)}`);
    }
  };

  const downloadSelectedLink = async (): Promise<void> => {
    await downloadLink(elementAnchor?.href, elementAnchor?.downloadName);
  };

  const captureVisiblePage = async (): Promise<void> => {
    if (!renderable || normalized === null) return;
    const requestUrl = normalized;
    const requestGeneration = captureGenerationRef.current;
    const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia;
    if (typeof getDisplayMedia !== "function") {
      setCaptureStatus("Visual capture is unavailable in this browser build.");
      return;
    }
    setCaptureStatus("Choose the browser surface to capture…");
    let stream: MediaStream | null = null;
    try {
      stream = await getDisplayMedia.call(navigator.mediaDevices, {
        video: { displaySurface: "browser" },
        audio: false,
      });
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("the selected surface could not be read"));
      });
      await video.play();
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      if (sourceWidth < 1 || sourceHeight < 1) throw new Error("the selected surface has no visible pixels");
      const scale = Math.min(1, 2400 / sourceWidth, 1600 / sourceHeight);
      const width = Math.max(1, Math.floor(sourceWidth * scale));
      const height = Math.max(1, Math.floor(sourceHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("the capture surface is unavailable");
      context.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      const next: BrowserCapture = {
        dataUrl,
        url: normalized,
        ...(selection.trim() ? { selection: selection.trim() } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(elementAnchor ? { element: elementAnchor } : {}),
        capturedAt: Date.now(),
        width,
        height,
        devicePixelRatio: window.devicePixelRatio || 1,
      };
      // The display picker is asynchronous. Do not attach pixels captured for
      // an older page after navigation or a reload has reset the panel state.
      if (
        requestGeneration !== captureGenerationRef.current ||
        !browserCaptureMatchesPage(requestUrl, currentUrlRef.current)
      ) {
        setCaptureStatus("Capture discarded because the browser page changed. Capture it again on the current page.");
        return;
      }
      if (browserCaptureAttachment(next) === null) {
        throw new Error("the captured image exceeds the 5 MB attachment limit");
      }
      setCapture(next);
      setCaptureRegion(null);
      setCaptureZoom(1);
      setCaptureStatus("Capture ready. Review it, then add it to the composer.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCaptureStatus(
        /denied|abort|cancel/i.test(message)
          ? "Visual capture was cancelled."
          : `Visual capture failed: ${userFacingError(message)}`,
      );
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  };

  const addCaptureToPrompt = () => {
    if (capture === null) return;
    if (onInsertCapture(capture)) {
      setCaptureStatus("Screenshot attached to the composer.");
    }
  };

  const capturePoint = (event: ReactPointerEvent<HTMLImageElement>): { x: number; y: number } | null => {
    if (capture === null) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(capture.width, Math.round(((event.clientX - rect.left) / rect.width) * capture.width))),
      y: Math.max(0, Math.min(capture.height, Math.round(((event.clientY - rect.top) / rect.height) * capture.height))),
    };
  };

  const cropCapture = async (): Promise<void> => {
    if (capture === null || captureRegion === null || captureRegion.width < 2 || captureRegion.height < 2) return;
    try {
      const image = new Image();
      image.src = capture.dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = captureRegion.width;
      canvas.height = captureRegion.height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("the capture surface is unavailable");
      context.drawImage(
        image,
        captureRegion.x,
        captureRegion.y,
        captureRegion.width,
        captureRegion.height,
        0,
        0,
        captureRegion.width,
        captureRegion.height,
      );
      const next: BrowserCapture = {
        ...capture,
        dataUrl: canvas.toDataURL("image/jpeg", 0.84),
        width: captureRegion.width,
        height: captureRegion.height,
        region: captureRegion,
        sourceWidth: capture.width,
        sourceHeight: capture.height,
      };
      if (browserCaptureAttachment(next) === null) {
        throw new Error("the cropped image exceeds the 5 MB attachment limit");
      }
      setCapture(next);
      setCaptureRegion(null);
      setCaptureZoom(1);
      setCaptureStatus("Region cropped. Review it, then add it to the composer.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCaptureStatus(`Region crop failed: ${userFacingError(message)}`);
    }
  };

  const insertCurrentContext = () => {
    if (!renderable || normalized === null) return;
    const context = formatBrowserContext(normalized, selection, comment, elementAnchor ?? undefined);
    if (context.length > 0) onInsertContext(context);
  };

  const resetPageState = () => {
    captureGenerationRef.current += 1;
    setFrameError(null);
    setNativeBrowserStatus(null);
    setSelection("");
    setElementAnchor(null);
    setPageObservation(null);
    setControlStatus(null);
    setCapture(null);
    setCaptureRegion(null);
    setCaptureZoom(1);
    setCaptureStatus(null);
    setTypeText("");
    setFrameKey((key) => key + 1);
  };

  const activateTab = (tab: BrowserTab) => {
    setActiveTabId(tab.id);
    setUrl(tab.url);
    setCurrentUrl(tab.url);
    setHistory(tab.history);
    setHistoryIndex(tab.historyIndex);
    resetPageState();
  };

  const updateActiveTab = (nextUrl: string, nextHistory: string[], nextHistoryIndex: number) => {
    setTabs((cur) => cur.map((tab) =>
      tab.id === activeTabId
        ? { ...tab, url: nextUrl, history: nextHistory, historyIndex: nextHistoryIndex }
        : tab,
    ));
  };

  const navigate = (nextInput: string, record = true, requestedIndex?: number) => {
    const next = normalizeBrowserUrl(nextInput);
    if (next === null) {
      setFrameError("That URL can't be shown here (http/https only).");
      return;
    }
    let nextHistory = history;
    let nextHistoryIndex = requestedIndex ?? historyIndex;
    if (record) {
      const base = historyIndex >= 0 ? history.slice(0, historyIndex + 1) : [];
      nextHistory = base[base.length - 1] === next ? base : [...base, next];
      nextHistoryIndex = nextHistory.length - 1;
    }
    setHistory(nextHistory);
    setHistoryIndex(nextHistoryIndex);
    setUrl(next);
    setCurrentUrl(next);
    updateActiveTab(next, nextHistory, nextHistoryIndex);
    resetPageState();
  };

  const goBack = () => {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    navigate(history[nextIndex], false, nextIndex);
  };

  const goForward = () => {
    if (historyIndex < 0 || historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    navigate(history[nextIndex], false, nextIndex);
  };

  const createTab = () => {
    if (tabs.length >= MAX_BROWSER_TABS) return;
    const tab = createBrowserTab();
    setTabs((cur) => [...cur, tab]);
    activateTab(tab);
  };

  const closeTab = (tabId: string) => {
    if (tabs.length <= 1) {
      const blank = createBrowserTab();
      setTabs([blank]);
      activateTab(blank);
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === tabId);
    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    const nextTab = nextTabs[Math.max(0, Math.min(index, nextTabs.length - 1))] ?? nextTabs[0];
    setTabs(nextTabs);
    if (nextTab) activateTab(nextTab);
  };

  async function openNativeBrowser(): Promise<void> {
    if (!renderable || normalized === null) return;
    if (!isTauriRuntime()) {
      setNativeBrowserStatus("The native browser is available in the desktop build.");
      return;
    }
    setNativeBrowserStatus("Opening native browser…");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_native_browser", { url: normalized, sessionId });
      setNativeBrowserStatus("Opened in the Muse Browser window.");
    } catch (error) {
      setNativeBrowserStatus(
        userFacingError(
          `native browser open failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  async function closeNativeBrowser(): Promise<void> {
    if (!isTauriRuntime()) {
      setNativeBrowserStatus("The native browser is available in the desktop build.");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const closed = await invoke<boolean>("close_native_browser", { sessionId });
      setNativeBrowserStatus(closed ? "Closed the Muse Browser window." : "The Muse Browser window is already closed.");
    } catch (error) {
      setNativeBrowserStatus(
        userFacingError(
          `native browser close failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  const toggleApp = (app: string, allowed: boolean) => {
    onSetPermission(app, allowed);
  };

  const addCustomApp = () => {
    if (appName.trim().length === 0) return;
    onSetPermission(appName.trim(), true);
    setAppName("");
  };

  const isAllowed = (app: string) =>
    permissions.find((p) => p.app === app)?.allowed === true;
  const browserControlsAllowed = isAllowed("browser");

  const invokeBrowserSkill = (action: BrowserSkillAction): void => {
    const skill = findBrowserSkill(hostSkills, action);
    if (skill === null || onInvokeBrowserSkill === undefined) {
      setControlStatus("This browser action is not available from the connected Muse host.");
      return;
    }
    if (action !== "observe" && !browserControlsAllowed) {
      setControlStatus("Allow computer-use for browser before asking Muse to act on the page.");
      return;
    }
    onInvokeBrowserSkill(
      skill.selector,
      buildBrowserSkillArguments(action, normalized ?? currentUrl, elementAnchor, typeText),
    );
    setControlStatus(`Asked Muse to ${action === "openTab" ? "open a new tab" : action} in the browser.`);
  };

  const advertisedBrowserSkills = (Object.keys({
    observe: true,
    click: true,
    type: true,
    navigate: true,
    openTab: true,
    download: true,
  }) as BrowserSkillAction[]).filter((action) => findBrowserSkill(hostSkills, action) !== null);
  const browserSkillInFlight =
    skillProgress !== undefined &&
    ["preparing", "loading-resources", "sending", "queued", "running", "unknown"].includes(skillProgress.stage) &&
    isAdvertisedBrowserSkill(hostSkills, skillProgress.name);

  const stopBrowserSkill = () => {
    if (!browserSkillInFlight || onCancelBrowserSkill === undefined || stoppingHostSkill) return;
    setStoppingHostSkill(true);
    setControlStatus("Asking Muse to stop the browser action…");
    void Promise.resolve(onCancelBrowserSkill())
      .then(() => setControlStatus("Stop requested. Waiting for Muse to confirm."))
      .catch((error) => setControlStatus(`The browser action could not be stopped: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => setStoppingHostSkill(false));
  };
  browserControlsAllowedRef.current = browserControlsAllowed;
  const capturePreview = capture === null
    ? null
    : browserCapturePreviewSize(capture.width, capture.height, captureZoom);

  return (
    <section className="browser-panel" aria-label="In-app browser">
      <details open>
        <summary className="browser-title">
          <span>Browser</span>
          <span className="capability-line">
            <CapabilityBadge
              status="local"
              reason={isTauriRuntime()
                ? "The embedded preview runs locally; native windows and Muse actions remain explicit and depend on the desktop host."
                : "The embedded preview runs locally in this browser; native windows and host actions require the desktop app."}
            />
            <span className="muted">Same-origin preview</span>
          </span>
        </summary>
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
          {tabs.map((tab) => {
            const host = tab.url ? new URL(tab.url).hostname.replace(/^www\./, "") : "New tab";
            return (
              <div className={`browser-tab${tab.id === activeTabId ? " is-active" : ""}`} key={tab.id}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeTabId}
                  className="browser-tab-select"
                  onClick={() => activateTab(tab)}
                  title={tab.url || "New tab"}
                >
                  <span>{host}</span>
                </button>
                <button
                  type="button"
                  className="browser-tab-close"
                  aria-label={`Close ${host} tab`}
                  title={`Close ${host} tab`}
                  onClick={() => closeTab(tab.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="browser-tab-new"
            onClick={createTab}
            disabled={tabs.length >= MAX_BROWSER_TABS}
            title={tabs.length >= MAX_BROWSER_TABS ? `Maximum of ${MAX_BROWSER_TABS} tabs` : "Open a new browser tab"}
          >
            +
          </button>
        </div>
        <form className="browser-url-row" onSubmit={(event) => {
          event.preventDefault();
          navigate(url);
        }}>
          <input
            className="browser-url"
            type="url"
            placeholder="https://example.com"
            aria-label="Page URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit" disabled={addressNormalized === null}>Go</button>
        </form>
        <div className="browser-nav-row" aria-label="Browser navigation">
          <button type="button" onClick={goBack} disabled={historyIndex <= 0} aria-label="Back">←</button>
          <button type="button" onClick={goForward} disabled={historyIndex < 0 || historyIndex >= history.length - 1} aria-label="Forward">→</button>
          <button type="button" onClick={() => renderable && setFrameKey((key) => key + 1)} disabled={!renderable}>Reload</button>
          <button
            type="button"
            className="browser-native-open"
            onClick={() => void openNativeBrowser()}
            disabled={!renderable}
            title="Open this page in a native Muse Browser window"
          >
            Open native
          </button>
          <button
            type="button"
            className="browser-native-close"
            onClick={() => void closeNativeBrowser()}
            disabled={!isTauriRuntime()}
            title="Close the dedicated Muse Browser window"
          >
            Close native
          </button>
          {normalized && <span className="browser-current-url" title={normalized}>{normalized}</span>}
        </div>
        {nativeBrowserStatus && (
          <div className="muted browser-native-status" role="status" aria-live="polite">
            {nativeBrowserStatus}
          </div>
        )}
        {url.trim().length > 0 && addressNormalized === null && (
          <div className="muted" role="note">
            That URL can&apos;t be shown here (http/https only).
          </div>
        )}
        {frameError && <div className="browser-frame-error" role="alert">{frameError}</div>}
        {renderable && normalized !== null && (
          <iframe
            ref={frameRef}
            key={frameKey}
            className="browser-frame"
            title={`Preview of ${normalized}`}
            src={normalized}
            sandbox="allow-scripts allow-same-origin"
            onLoad={handleFrameLoad}
            onError={() => setFrameError("This page could not be loaded in the embedded preview.")}
          />
        )}
        {/*
          The preview surface only exists once a URL is renderable, so a fresh
          tab used to show nothing at all between the navigation row and "Page
          controls" — the one panel of the seven with no empty state. Reported by
          an independent visual review and confirmed by structure measurement.
        */}
        {!renderable && frameError === null && (
          <div className="browser-frame-empty" role="status">
            <span className="muted">
              No page loaded yet. Enter an http or https address above and press Go.
            </span>
          </div>
        )}
        <div className="browser-controls" aria-label="Browser page controls">
          <div className="browser-controls-head">
            <span>Page controls</span>
            <span className="muted">Same-origin preview only</span>
          </div>
          <div className="browser-controls-actions">
            <button type="button" disabled={!renderable} onClick={observePage}>
              Observe page
            </button>
            <button
              type="button"
              disabled={elementAnchor === null || !browserControlsAllowed}
              onClick={clickSelectedElement}
              title={browserControlsAllowed ? "Click the selected same-origin element" : "Allow computer-use for browser first"}
            >
              Click selected element
            </button>
            <button
              type="button"
              disabled={elementAnchor?.href === undefined || !browserControlsAllowed}
              onClick={navigateSelectedLink}
              title={browserControlsAllowed ? "Navigate to the selected same-origin link" : "Allow computer-use for browser first"}
            >
              Navigate selected link
            </button>
            <button
              type="button"
              disabled={elementAnchor?.href === undefined || !browserControlsAllowed || tabs.length >= MAX_BROWSER_TABS}
              onClick={openSelectedLinkInNewTab}
              title={browserControlsAllowed ? "Open the selected same-origin link in a new tab" : "Allow computer-use for browser first"}
            >
              Open in new tab
            </button>
            <button
              type="button"
              disabled={elementAnchor?.href === undefined || !browserControlsAllowed}
              onClick={() => void downloadSelectedLink()}
              title={browserControlsAllowed ? "Fetch and save the selected same-origin link" : "Allow computer-use for browser first"}
            >
              Save selected link
            </button>
            <input
              type="text"
              aria-label="Text to enter into selected field"
              placeholder="Text for selected field"
              value={typeText}
              onChange={(event) => setTypeText(event.target.value)}
              disabled={elementAnchor === null || !browserControlsAllowed}
            />
            <button
              type="button"
              disabled={elementAnchor === null || !browserControlsAllowed || typeText.trim().length === 0}
              onClick={typeIntoSelectedElement}
              title={browserControlsAllowed ? "Type into the selected same-origin field" : "Allow computer-use for browser first"}
            >
              Type into field
            </button>
          </div>
          {advertisedBrowserSkills.length > 0 && (
            <div className="browser-host-actions" aria-label="Muse browser actions">
              <span className="muted">Muse actions from the connected host</span>
              {advertisedBrowserSkills.map((action) => (
                <button
                  type="button"
                  key={action}
                  onClick={() => invokeBrowserSkill(action)}
                  disabled={
                    (action !== "observe" && (!browserControlsAllowed || elementAnchor === null)) ||
                    (["navigate", "openTab", "download"].includes(action) && elementAnchor?.href === undefined) ||
                    (action === "type" && typeText.trim().length === 0)
                  }
                  title="Run the advertised browser skill through the current conversation"
                >
                  {action === "openTab"
                    ? "Ask Muse to open a tab"
                    : `Ask Muse to ${action}`}
                </button>
              ))}
              {browserSkillInFlight && onCancelBrowserSkill !== undefined && (
                <button
                  type="button"
                  className="browser-host-stop"
                  onClick={stopBrowserSkill}
                  disabled={stoppingHostSkill}
                  title="Ask Muse to stop the active browser action"
                >
                  {stoppingHostSkill ? "Stopping…" : "Stop Muse action"}
                </button>
              )}
            </div>
          )}
          {controlStatus && <div className="muted browser-control-status" role="status" aria-live="polite">{controlStatus}</div>}
          {downloadStatus && <div className="muted browser-control-status" role="status" aria-live="polite">{downloadStatus}</div>}
          {pageObservation && normalized && (
            <details className="browser-observation" open>
              <summary>Observed page: {pageObservation.title}</summary>
              <pre>{formatBrowserObservation(normalized, pageObservation)}</pre>
              <button type="button" onClick={() => onInsertContext(formatBrowserObservation(normalized, pageObservation))}>
                Add observation to prompt
              </button>
            </details>
          )}
        </div>
        <div className="browser-annotate">
          <div className="muted">Anchor a comment to this page + selection:</div>
          {elementAnchor && (
            <div className="browser-element-anchor" role="status" aria-live="polite">
              <span>Element anchor: <code>{elementAnchor.selector}</code></span>
              <button
                type="button"
                className="quiet"
                onClick={() => setElementAnchor(null)}
                title="Clear the selected element anchor"
              >
                Clear
              </button>
            </div>
          )}
          <input
            aria-label="Selection text"
            placeholder="Quoted selection (optional)"
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
          />
          <input
            aria-label="Comment"
            placeholder="Comment (required)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <button
            type="button"
            disabled={!renderable || comment.trim().length === 0}
            onClick={submitAnnotation}
          >
            Add comment
          </button>
          <button
            type="button"
            disabled={!renderable}
            onClick={insertCurrentContext}
            title="Add the current page URL, selection and comment to the composer"
          >
            Add page context
          </button>
          <div className="browser-capture-actions">
            <button
              type="button"
              disabled={!renderable}
              onClick={() => void captureVisiblePage()}
              title="Capture a visible browser surface after explicit system consent"
            >
              Capture visible page
            </button>
            {capture !== null && (
              <>
                {capturePreview !== null && (
                  <>
                    <div className="browser-capture-zoom">
                      <label htmlFor="browser-capture-zoom">Preview zoom</label>
                      <input
                        id="browser-capture-zoom"
                        type="range"
                        min="1"
                        max="2.5"
                        step="0.1"
                        value={captureZoom}
                        onChange={(event) => setCaptureZoom(Number(event.currentTarget.value))}
                        aria-label="Capture preview zoom"
                      />
                      <output>{Math.round(capturePreview.zoom * 100)}%</output>
                      {captureZoom !== 1 && (
                        <button type="button" className="quiet" onClick={() => setCaptureZoom(1)}>
                          Reset
                        </button>
                      )}
                    </div>
                    <div className="browser-capture-viewport">
                      <div
                        className="browser-capture-canvas"
                        style={{ width: `${capturePreview.width}px`, height: `${capturePreview.height}px` }}
                      >
                        <img
                          ref={captureImageRef}
                          className="browser-capture-preview"
                          src={capture.dataUrl}
                          width={capturePreview.width}
                          height={capturePreview.height}
                          alt="Captured browser page preview; drag to select a region"
                          onPointerDown={(event) => {
                            const point = capturePoint(event);
                            if (point === null) return;
                            event.currentTarget.setPointerCapture(event.pointerId);
                            captureDragRef.current = point;
                            setCaptureRegion({ ...point, width: 0, height: 0 });
                          }}
                          onPointerMove={(event) => {
                            const start = captureDragRef.current;
                            const point = capturePoint(event);
                            if (start === null || point === null) return;
                            setCaptureRegion({
                              x: Math.min(start.x, point.x),
                              y: Math.min(start.y, point.y),
                              width: Math.abs(point.x - start.x),
                              height: Math.abs(point.y - start.y),
                            });
                          }}
                          onPointerUp={(event) => {
                            captureDragRef.current = null;
                            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                              event.currentTarget.releasePointerCapture(event.pointerId);
                            }
                          }}
                        />
                        {captureRegion !== null && captureRegion.width > 1 && captureRegion.height > 1 && (
                          <span
                            className="browser-capture-region"
                            aria-hidden="true"
                            style={{
                              left: `${(captureRegion.x / capture.width) * 100}%`,
                              top: `${(captureRegion.y / capture.height) * 100}%`,
                              width: `${(captureRegion.width / capture.width) * 100}%`,
                              height: `${(captureRegion.height / capture.height) * 100}%`,
                            }}
                          />
                        )}
                      </div>
                    </div>
                  </>
                )}
                <span className="muted browser-capture-help">Drag on the preview to crop a region.</span>
                {captureRegion !== null && captureRegion.width > 1 && captureRegion.height > 1 && (
                  <button type="button" onClick={() => void cropCapture()}>
                    Crop to region
                  </button>
                )}
                <button type="button" onClick={addCaptureToPrompt}>
                  Add screenshot to prompt
                </button>
                <button type="button" className="quiet" onClick={() => { setCapture(null); setCaptureRegion(null); setCaptureZoom(1); }}>
                  Remove capture
                </button>
              </>
            )}
          </div>
          {captureStatus !== null && (
            <div className="muted browser-capture-status" role="status" aria-live="polite">
              {captureStatus}
            </div>
          )}
          {capture !== null && (
            <div className="muted browser-capture-meta">
              {formatBrowserCaptureContext(capture).split("\n").slice(1, 4).join(" · ")}
            </div>
          )}
        </div>
        {pageNotes.length > 0 && (
          <ul className="browser-notes">
            {pageNotes.map((a) => (
              <li key={a.id} className="browser-note">
                {a.selection !== "" && (
                  <blockquote title="Anchored selection">“{a.selection}”</blockquote>
                )}
                <span>{a.comment}</span>
                <button
                  type="button"
                  className="browser-note-remove"
                  title="Remove this comment"
                  onClick={() => onRemoveAnnotation(a.id)}
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => onInsertContext(formatBrowserContext(a.url, a.selection, a.comment, a.element))}
                  title="Add this annotation to the composer"
                >
                  Add to prompt
                </button>
              </li>
            ))}
          </ul>
        )}
        {annotations.length > pageNotes.length && (
          <div className="muted">
            +{annotations.length - pageNotes.length} comment(s) on other pages
          </div>
        )}
        <div className="browser-perms">
          <div className="muted browser-perms-title">
            Computer-use permissions (default denied — background operation
            needs an explicit opt-in per app)
          </div>
          <ul className="browser-perms-rows">
            {KNOWN_APPS.map((app) => {
              const allowed = isAllowed(app);
              return (
                <li key={app} className="browser-perm-row">
                  <code>{app}</code>
                  <span className="muted">{allowed ? "allowed" : "denied"}</span>
                  <button
                    type="button"
                    aria-pressed={allowed}
                    title={
                      allowed
                        ? `Revoke computer-use for ${app}`
                        : `Allow computer-use for ${app}`
                    }
                    onClick={() => toggleApp(app, !allowed)}
                  >
                    {allowed ? "Revoke" : "Allow"}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="browser-perms-custom">
            <input
              aria-label="Other app name"
              placeholder="Other app…"
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
            />
            <button
              type="button"
              disabled={appName.trim().length === 0}
              onClick={addCustomApp}
            >
              Allow app
            </button>
          </div>
          {permissions.filter((p) => !KNOWN_APPS.includes(p.app)).length > 0 && (
            <ul className="browser-perms-rows">
              {permissions
                .filter((p) => !KNOWN_APPS.includes(p.app))
                .map((p) => (
                  <li key={p.app} className="browser-perm-row">
                    <code>{p.app}</code>
                    <span className="muted">{p.allowed ? "allowed" : "denied"}</span>
                    <button
                      type="button"
                      aria-pressed={p.allowed}
                      title={p.allowed ? `Revoke computer-use for ${p.app}` : `Allow computer-use for ${p.app}`}
                      onClick={() => toggleApp(p.app, !p.allowed)}
                    >
                      {p.allowed ? "Revoke" : "Allow"}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
        <div className="muted" role="note" title="Image generation scope">
          {IMAGE_GENERATION_NOTE}
        </div>
      </details>
    </section>
  );
}
