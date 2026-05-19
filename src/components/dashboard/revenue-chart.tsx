"use client";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function RevenueChart({ data }: { data: { label: string; revenue: number }[] }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#c5a55a" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#c5a55a" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis dataKey="label" stroke="#9e9e9e" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis
            stroke="#9e9e9e"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
          />
          <Tooltip
            contentStyle={{
              background: "#1a1a1a",
              border: "1px solid #2e2e2e",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v: number) =>
              new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 0,
              }).format(v)
            }
          />
          <Area
            type="monotone"
            dataKey="revenue"
            stroke="#c5a55a"
            strokeWidth={2}
            fill="url(#gold)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
