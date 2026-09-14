const paths = {
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
  sun: "M12 2v2m0 16v2M2 12h2m16 0h2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
};
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
