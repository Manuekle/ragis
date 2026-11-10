import { useRef } from "react";
import { Point, VelocityTracker } from "./physics";

interface IProps {
  onStart?: (start: Point) => void;
  // Offset from where the pointer went down
  onMove: (delta: Point) => void;
  // Release velocity in px/s
  onEnd?: (velocity: Point) => void;
}

type IState = {
  pointerId: number | null;
  startX: number;
  startY: number;
};

// Spread the result onto the element you drag. Give that element
// `touch-action: none` (and `user-select: none`) or touch will scroll the page
// instead.
export const useDrag = (props: IProps) => {
  const { onMove, onEnd, onStart } = props;

  const state = useRef<IState>({
    pointerId: null,
    startX: 0,
    startY: 0,
  });

  const tracker = useRef(new VelocityTracker());

  const end = (e: React.PointerEvent<Element>) => {
    if (e.pointerId !== state.current.pointerId) return;
    state.current.pointerId = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    onEnd?.(tracker.current.get());
  };

  return {
    onPointerDown: (e: React.PointerEvent<Element>) => {
      // Left button only: right/ctrl-click opens the context menu, which swallows pointerup
      if (e.button !== 0 || e.ctrlKey) return;
      // Ignore a second finger while one is already dragging
      if (state.current.pointerId !== null) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      state.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
      };
      tracker.current.reset();
      tracker.current.add(e.clientX, e.clientY);
      onStart?.({ x: state.current.startX, y: state.current.startY });
    },
    onPointerMove: (e: React.PointerEvent<Element>) => {
      if (e.pointerId !== state.current.pointerId) return;
      tracker.current.add(e.clientX, e.clientY);
      onMove({
        x: e.clientX - state.current.startX,
        y: e.clientY - state.current.startY,
      });
    },
    onPointerUp: end,
    onPointerCancel: end,
    // Capture can be lost without a pointerup (app switch, context menu): always settle
    onLostPointerCapture: end,
  };
};
