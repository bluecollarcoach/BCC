import type { GraphCalendarAdapter, GraphEvent } from "./adapter";

const memory = new Map<string, GraphEvent[]>();

function seed(userId: string): GraphEvent[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return [
    {
      id: `mock-${userId}-1`,
      subject: "Crew standup",
      start: new Date(today.getTime() + 8 * 3600_000).toISOString(),
      end: new Date(today.getTime() + 8.25 * 3600_000).toISOString(),
      location: "Shop",
    },
    {
      id: `mock-${userId}-2`,
      subject: "Castro Job — site walk",
      start: new Date(today.getTime() + 10 * 3600_000).toISOString(),
      end: new Date(today.getTime() + 11.5 * 3600_000).toISOString(),
      location: "2412 Elm St",
    },
    {
      id: `mock-${userId}-3`,
      subject: "Coaching call — Mike",
      start: new Date(today.getTime() + 14 * 3600_000).toISOString(),
      end: new Date(today.getTime() + 15 * 3600_000).toISOString(),
    },
  ];
}

export const mockGraph: GraphCalendarAdapter = {
  async listEvents(userId, _range) {
    if (!memory.has(userId)) memory.set(userId, seed(userId));
    return memory.get(userId)!;
  },
  async createEvent(userId, ev) {
    const id = `mock-${userId}-${Date.now()}`;
    const created: GraphEvent = { id, ...ev };
    const list = memory.get(userId) ?? [];
    list.push(created);
    memory.set(userId, list);
    return created;
  },
  async updateEvent(userId, id, ev) {
    const list = memory.get(userId) ?? [];
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error("Event not found");
    list[idx] = { ...list[idx], ...ev };
    return list[idx];
  },
  async deleteEvent(userId, id) {
    const list = memory.get(userId) ?? [];
    memory.set(userId, list.filter((e) => e.id !== id));
  },
};
