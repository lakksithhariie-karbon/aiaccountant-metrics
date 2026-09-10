export type WeekBounds = {
  fromWeek: string | null;
  toWeek: string | null;
};

function snapToMonday(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error("must be YYYY-MM-DD");
  }
  const weekday = parsed.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  parsed.setUTCDate(parsed.getUTCDate() + mondayOffset);
  return parsed.toISOString().slice(0, 10);
}

export function parseWeekFilter(params: URLSearchParams): WeekBounds {
  const bounds: WeekBounds = { fromWeek: null, toWeek: null };
  for (const name of ["from_week", "to_week"] as const) {
    const raw = params.get(name);
    if (raw === null) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error(`${name} must be YYYY-MM-DD`);
    }
    try {
      const snapped = snapToMonday(raw);
      if (name === "from_week") bounds.fromWeek = snapped;
      else bounds.toWeek = snapped;
    } catch {
      throw new Error(`${name} must be YYYY-MM-DD`);
    }
  }
  if (bounds.fromWeek && bounds.toWeek && bounds.fromWeek > bounds.toWeek) {
    throw new Error("from_week must be on or before to_week");
  }
  return bounds;
}
