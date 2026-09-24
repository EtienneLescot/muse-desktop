const paths = {
  minimize: "M5 12h14",
  maximize: "M5 5h14v14H5z",
  restore: "M8 8h12v12H8zM4 16V4h12",
  moon: "M20.9 13.1A9 9 0 0 1 10.9 3.1 9 9 0 1 0 20.9 13.1Z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  folder: "M3 6h6l2 2h10v12H3z",
  panel: "M3 4h18v16H3zM9 4v16",
  archive: "M3 3h18v5H3zM5 8v13h14V8M9 12h6",
  close: "m6 6 12 12M6 18 18 6",
  globe:
    "M2 12h20M12 2c7 6 7 14 0 20-7-6-7-14 0-20M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6",
  sun: "M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  shield: "M12 3 19 6v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
  // Fork. Hand-written, like every glyph here: the project ships no icon
  // library, and `Icon` renders one stroked path with fill:none, so circles are
  // drawn as arcs rather than <circle> elements.
  //
  // Five shapes were rendered at real size before this one and all five failed:
  // a trunk with a crossbar read as the digit "4", straight diagonals read as an
  // arrow, and a node circle on a bare stem read as a keyhole. The canonical
  // git-branch layout avoids every one of those traps, which is why the
  // reference the user supplied is the shape that works.
  // Evidence: docs/evidence/2026-09-21-ux/pass2/fork-icon-*.png
  branch:
    "M3.5 5.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0Z" +
    "M3.5 18.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0Z" +
    "M15.5 5.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0Z" +
    "M6 8v8" +
    "M18 8v3a3 3 0 0 1-3 3H6",
  pin: "M8 3h8l-1 6 3 3v2h-5v7l-1 1-1-1v-7H6v-2l3-3-1-6Z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  stop: "M7 7h10v10H7z",
  check: "m5 13 4 4 10-10",
};
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
