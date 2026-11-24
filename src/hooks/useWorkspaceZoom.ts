import { RefObject, useCallback, useEffect, useRef, useState } from 'react';

export const MIN_WORKSPACE_ZOOM = 0.6;
export const MAX_WORKSPACE_ZOOM = 2.0;
export const DEFAULT_WORKSPACE_ZOOM = 1.0;
export const ZOOM_STEP = 0.1;

interface FocalPoint {
  x: number;
  y: number;
}

interface PinchSession {
  active: boolean;
  startDist: number;
  startScale: number;
  anchorContentX: number;
  anchorContentY: number;
}

interface UseWorkspaceZoomOptions {
  /** Whether the zoomable container is currently mounted in the DOM. */
  enabled?: boolean;
  /** Called when an interactive zoom gesture starts (e.g. to close open cell popovers). */
  onGestureStart?: () => void;
  /** Disable keyboard zoom shortcuts while modals are open. */
  disableShortcuts?: boolean;
}

function clampZoom(value: number): number {
  return Math.min(MAX_WORKSPACE_ZOOM, Math.max(MIN_WORKSPACE_ZOOM, value));
}

function getTouchDistance(t1: Touch, t2: Touch): number {
  return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Smooth, anchor-stable workspace zoom controller for scrollable tables/grids.
 *
 * - Supports 2-finger touch pinch-to-zoom (mobile/tablet) without blocking 1-finger scroll.
 * - Supports trackpad pinch & Ctrl/Cmd + mouse wheel centered on the cursor position.
 * - Supports smooth +/- stepping, exact 100% reset, and Ctrl/Cmd + (+ / - / 0) shortcuts.
 * - Applies zoom directly via DOM + rAF coalescing so active gestures never trigger
 *   expensive React re-renders across hundreds of table cells.
 */
export function useWorkspaceZoom(
  containerRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  options?: UseWorkspaceZoomOptions
) {
  const enabled = options?.enabled ?? true;
  const [zoomPercent, setZoomPercent] = useState<number>(100);
  const [isDefaultZoom, setIsDefaultZoom] = useState<boolean>(true);

  const scaleRef = useRef<number>(DEFAULT_WORKSPACE_ZOOM);
  const lastReportedPercentRef = useRef<number>(100);
  const lastReportedDefaultRef = useRef<boolean>(true);

  const onGestureStartRef = useRef(options?.onGestureStart);
  onGestureStartRef.current = options?.onGestureStart;
  const disableShortcutsRef = useRef(Boolean(options?.disableShortcuts));
  disableShortcutsRef.current = Boolean(options?.disableShortcuts);

  const animRafRef = useRef<number | null>(null);
  const gestureRafRef = useRef<number | null>(null);
  const lastPinchEndRef = useRef<number>(0);

  const pinchRef = useRef<PinchSession>({
    active: false,
    startDist: 0,
    startScale: 1,
    anchorContentX: 0,
    anchorContentY: 0,
  });

  const pendingWheelRef = useRef<{
    factor: number;
    focal: FocalPoint;
  } | null>(null);

  const pendingPinchFrameRef = useRef<{
    scale: number;
    targetLeft: number;
    targetTop: number;
  } | null>(null);

  const cancelAnimation = useCallback(() => {
    if (animRafRef.current !== null) {
      window.cancelAnimationFrame(animRafRef.current);
      animRafRef.current = null;
    }
  }, []);

  const syncUiState = useCallback((scale: number) => {
    const rounded = Math.round(scale * 100);
    const atDefault = Math.abs(scale - DEFAULT_WORKSPACE_ZOOM) < 0.0005;
    if (rounded !== lastReportedPercentRef.current) {
      lastReportedPercentRef.current = rounded;
      setZoomPercent(rounded);
    }
    if (atDefault !== lastReportedDefaultRef.current) {
      lastReportedDefaultRef.current = atDefault;
      setIsDefaultZoom(atDefault);
    }
  }, []);

  const applyScaleImmediate = useCallback(
    (
      rawScale: number,
      focal?: FocalPoint,
      explicitScroll?: { left: number; top: number }
    ) => {
      const container = containerRef.current;
      const content = contentRef.current;
      const clamped = clampZoom(rawScale);
      const exactScale =
        Math.abs(clamped - DEFAULT_WORKSPACE_ZOOM) < 0.0001
          ? DEFAULT_WORKSPACE_ZOOM
          : clamped;
      const prevScale = scaleRef.current;

      if (!container || !content) {
        scaleRef.current = exactScale;
        syncUiState(exactScale);
        return;
      }

      let targetLeft: number;
      let targetTop: number;

      if (explicitScroll) {
        targetLeft = explicitScroll.left;
        targetTop = explicitScroll.top;
      } else {
        const fx = focal ? focal.x : container.clientWidth / 2;
        const fy = focal ? focal.y : container.clientHeight / 2;
        const contentX = (container.scrollLeft + fx) / prevScale;
        const contentY = (container.scrollTop + fy) / prevScale;
        targetLeft = contentX * exactScale - fx;
        targetTop = contentY * exactScale - fy;
      }

      scaleRef.current = exactScale;

      if (exactScale === DEFAULT_WORKSPACE_ZOOM) {
        content.style.zoom = '';
        content.style.setProperty('--register-zoom', '1');
      } else {
        content.style.zoom = String(exactScale);
        content.style.setProperty('--register-zoom', String(exactScale));
      }

      const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollLeft = Math.max(0, Math.min(maxLeft, targetLeft));
      container.scrollTop = Math.max(0, Math.min(maxTop, targetTop));

      syncUiState(exactScale);
    },
    [containerRef, contentRef, syncUiState]
  );

  const animateToScale = useCallback(
    (targetRaw: number, optionsArg?: { focal?: FocalPoint; durationMs?: number }) => {
      cancelAnimation();
      const targetScale = clampZoom(targetRaw);
      const startScale = scaleRef.current;
      const container = containerRef.current;

      if (
        !container ||
        prefersReducedMotion() ||
        Math.abs(targetScale - startScale) < 0.001
      ) {
        applyScaleImmediate(targetScale, optionsArg?.focal);
        return;
      }

      const fx = optionsArg?.focal
        ? optionsArg.focal.x
        : container.clientWidth / 2;
      const fy = optionsArg?.focal
        ? optionsArg.focal.y
        : container.clientHeight / 2;
      const anchorContentX = (container.scrollLeft + fx) / startScale;
      const anchorContentY = (container.scrollTop + fy) / startScale;

      const duration = optionsArg?.durationMs ?? 150;
      const startTime = performance.now();

      const step = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        // Smooth cubic ease-out
        const eased = 1 - Math.pow(1 - progress, 3);
        const current =
          progress >= 1
            ? targetScale
            : startScale + (targetScale - startScale) * eased;

        applyScaleImmediate(current, undefined, {
          left: anchorContentX * current - fx,
          top: anchorContentY * current - fy,
        });

        if (progress < 1) {
          animRafRef.current = window.requestAnimationFrame(step);
        } else {
          animRafRef.current = null;
        }
      };

      animRafRef.current = window.requestAnimationFrame(step);
    },
    [applyScaleImmediate, cancelAnimation, containerRef]
  );

  const zoomIn = useCallback(() => {
    const next = Math.round((scaleRef.current + ZOOM_STEP) * 10) / 10;
    animateToScale(next);
  }, [animateToScale]);

  const zoomOut = useCallback(() => {
    const next = Math.round((scaleRef.current - ZOOM_STEP) * 10) / 10;
    animateToScale(next);
  }, [animateToScale]);

  const resetZoom = useCallback(() => {
    cancelAnimation();
    const container = containerRef.current;
    // Restore exact 100% (1.0) cleanly, keeping top-left aligned and removing any zoom offset
    applyScaleImmediate(DEFAULT_WORKSPACE_ZOOM, { x: 0, y: 0 });
    if (container && container.scrollWidth <= container.clientWidth + 1) {
      container.scrollLeft = 0;
    }
  }, [applyScaleImmediate, cancelAnimation, containerRef]);

  // Pointer/wheel/touch gesture bindings on the scrollable workspace container
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    // Ensure DOM reflects current scale if container remounted (e.g. switching from empty class)
    if (contentRef.current && scaleRef.current !== DEFAULT_WORKSPACE_ZOOM) {
      contentRef.current.style.zoom = String(scaleRef.current);
      contentRef.current.style.setProperty('--register-zoom', String(scaleRef.current));
    }

    const flushPendingGesture = () => {
      gestureRafRef.current = null;

      if (pendingPinchFrameRef.current) {
        const { scale, targetLeft, targetTop } = pendingPinchFrameRef.current;
        pendingPinchFrameRef.current = null;
        applyScaleImmediate(scale, undefined, {
          left: targetLeft,
          top: targetTop,
        });
      }

      if (pendingWheelRef.current) {
        const { factor, focal } = pendingWheelRef.current;
        pendingWheelRef.current = null;
        applyScaleImmediate(scaleRef.current * factor, focal);
      }
    };

    const scheduleFlush = () => {
      if (gestureRafRef.current === null) {
        gestureRafRef.current = window.requestAnimationFrame(flushPendingGesture);
      }
    };

    // 1. Desktop trackpad pinch & Ctrl/Meta + mouse wheel
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      cancelAnimation();

      const rect = container.getBoundingClientRect();
      const focal: FocalPoint = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 120;
      const clampedDy = Math.max(-60, Math.min(60, dy));
      const stepFactor = Math.exp(-clampedDy * 0.0022);

      if (pendingWheelRef.current) {
        pendingWheelRef.current.factor *= stepFactor;
        pendingWheelRef.current.focal = focal;
      } else {
        pendingWheelRef.current = { factor: stepFactor, focal };
      }

      scheduleFlush();
    };

    // 2. Touch pinch-to-zoom (2 fingers only; 1 finger scrolls natively!)
    const startPinchSession = (t1: Touch, t2: Touch) => {
      const dist = getTouchDistance(t1, t2);
      if (dist < 10) return;
      cancelAnimation();
      onGestureStartRef.current?.();

      const rect = container.getBoundingClientRect();
      const midX = (t1.clientX + t2.clientX) / 2 - rect.left;
      const midY = (t1.clientY + t2.clientY) / 2 - rect.top;
      const currentScale = scaleRef.current;

      pinchRef.current = {
        active: true,
        startDist: dist,
        startScale: currentScale,
        anchorContentX: (container.scrollLeft + midX) / currentScale,
        anchorContentY: (container.scrollTop + midY) / currentScale,
      };
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        startPinchSession(e.touches[0], e.touches[1]);
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();

      const t1 = e.touches[0];
      const t2 = e.touches[1];
      if (!pinchRef.current.active) {
        startPinchSession(t1, t2);
        return;
      }

      const dist = getTouchDistance(t1, t2);
      if (dist < 10 || pinchRef.current.startDist < 10) return;

      const rect = container.getBoundingClientRect();
      const curMidX = (t1.clientX + t2.clientX) / 2 - rect.left;
      const curMidY = (t1.clientY + t2.clientY) / 2 - rect.top;
      const nextScale = clampZoom(
        pinchRef.current.startScale * (dist / pinchRef.current.startDist)
      );

      pendingPinchFrameRef.current = {
        scale: nextScale,
        targetLeft: pinchRef.current.anchorContentX * nextScale - curMidX,
        targetTop: pinchRef.current.anchorContentY * nextScale - curMidY,
      };
      scheduleFlush();
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (pinchRef.current.active && e.touches.length < 2) {
        pinchRef.current.active = false;
        lastPinchEndRef.current = performance.now();
      }
    };

    // Prevent Safari iPadOS/macOS from zooming the whole page during an in-table gesture
    const handleSafariGesture = (e: Event) => {
      e.preventDefault();
    };

    // Suppress accidental synthetic cell taps immediately after lifting fingers from a pinch
    const handleClickCapture = (e: MouseEvent) => {
      if (performance.now() - lastPinchEndRef.current < 220) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    container.addEventListener('gesturestart', handleSafariGesture, { passive: false });
    container.addEventListener('gesturechange', handleSafariGesture, { passive: false });
    container.addEventListener('click', handleClickCapture, { capture: true });

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
      container.removeEventListener('gesturestart', handleSafariGesture);
      container.removeEventListener('gesturechange', handleSafariGesture);
      container.removeEventListener('click', handleClickCapture, { capture: true });
      cancelAnimation();
      if (gestureRafRef.current !== null) {
        window.cancelAnimationFrame(gestureRafRef.current);
        gestureRafRef.current = null;
      }
    };
  }, [applyScaleImmediate, cancelAnimation, containerRef, contentRef, enabled]);

  // Keyboard shortcuts: Ctrl/Cmd + (+ / - / 0)
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (disableShortcutsRef.current) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === '0') {
        e.preventDefault();
        resetZoom();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, resetZoom, zoomIn, zoomOut]);

  return {
    zoomPercent,
    isDefaultZoom,
    canZoomIn: zoomPercent < Math.round(MAX_WORKSPACE_ZOOM * 100),
    canZoomOut: zoomPercent > Math.round(MIN_WORKSPACE_ZOOM * 100),
    zoomIn,
    zoomOut,
    resetZoom,
  };
}
