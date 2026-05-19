import { hasEntraConfigured } from "@/lib/env";
import { mockGraph } from "./mock";
import { graphCalendar } from "./graph";
import type { GraphCalendarAdapter } from "./adapter";

export const calendar: GraphCalendarAdapter = hasEntraConfigured ? graphCalendar : mockGraph;
export type { GraphCalendarAdapter, GraphEvent } from "./adapter";
