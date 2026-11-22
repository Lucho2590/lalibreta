"use client";

import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const EASING = "cubic-bezier(0.2, 0, 0, 1)";

const dropAnimation: DropAnimation = {
  duration: 220,
  easing: EASING,
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.35" } } }),
};

/** true justo después de soltar: el click que sigue no tiene que navegar. */
const JustDraggedContext = createContext<React.RefObject<boolean> | null>(null);

/**
 * Menú ordenable con arrastrar y soltar. Mouse: apretar y mover (un click
 * normal sigue navegando). Touch: mantener apretado y mover (deslizar sin
 * esperar sigue scrolleando). Teclado: espacio para agarrar/soltar.
 */
export function SortableNav({
  ids,
  onReorder,
  strategy,
  renderOverlay,
  children,
}: {
  ids: string[];
  onReorder: (ids: string[]) => void;
  strategy: SortingStrategy;
  renderOverlay: (id: string) => React.ReactNode;
  children: React.ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const justDragged = useRef(false);
  // id estable: sin esto, los aria-describedby de dnd-kit no coinciden entre servidor y cliente.
  const dndId = useId();
  // eslint-disable-next-line react-hooks/set-state-in-effect -- el portal necesita document (solo cliente)
  useEffect(() => setMounted(true), []);

  // MouseSensor (no PointerSensor): en touch, el PointerSensor se activaría
  // al deslizar para scrollear. El touch lo maneja solo el TouchSensor.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Enter sigue abriendo el link; espacio agarra.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const finish = () => {
    setActiveId(null);
    justDragged.current = true;
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
  };

  const onDragEnd = (e: DragEndEvent) => {
    finish();
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <JustDraggedContext.Provider value={justDragged}>
      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
        onDragEnd={onDragEnd}
        onDragCancel={finish}
      >
        <SortableContext items={ids} strategy={strategy}>
          {children}
        </SortableContext>
        {mounted &&
          createPortal(
            // En el body, para que la hoja "Más" (con su transform y scroll) no la corra ni la corte.
            <DragOverlay dropAnimation={dropAnimation} zIndex={60}>
              {activeId ? renderOverlay(activeId) : null}
            </DragOverlay>,
            document.body,
          )}
      </DndContext>
    </JustDraggedContext.Provider>
  );
}

/**
 * Props para hacer arrastrable un ítem entero del menú (un <Link> o un botón).
 * Incluye lo necesario para que soltar no navegue. Ojo: en iOS, si el ítem es
 * un <a href>, mantener apretado abre la vista previa del link y no arrastra;
 * en touch conviene que sea un botón (ver bottom-nav).
 */
export function useSortableNavItem(id: string) {
  const justDragged = useContext(JustDraggedContext);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    transition: { duration: 220, easing: EASING },
  });
  // Sin role/tabIndex de dnd-kit: el ítem define los suyos.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { role, tabIndex, ...a11y } = attributes;

  return {
    isDragging,
    itemProps: {
      ref: setNodeRef,
      ...a11y,
      ...listeners,
      draggable: false,
      style: { transform: CSS.Translate.toString(transform), transition },
      onClickCapture: (e: React.MouseEvent) => {
        if (justDragged?.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      onContextMenu: (e: React.MouseEvent) => {
        // Android abre un menú contextual al mantener apretado.
        if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType !== "mouse") e.preventDefault();
      },
    },
  };
}
