"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import type { TpsPoint } from "@/lib/store";

export function GasChart({ series }: { series: TpsPoint[] }) {
  if (series.length < 2) {
    return (
      <div className="flex h-20 items-center justify-center text-xs text-mist-400">正在采集区块…</div>
    );
  }

  return (
    <div className="h-20 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="gasFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f0a85a" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#f0a85a" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, "dataMax + 5"]} />
          <Tooltip
            cursor={{ stroke: "#8a6a3a", strokeWidth: 1 }}
            contentStyle={{
              background: "#12101b",
              border: "1px solid #322b45",
              borderRadius: 8,
              fontSize: 12,
              color: "#cbc4dc",
            }}
            labelFormatter={() => ""}
            formatter={(value) => [`${value} gwei`, "基础费"]}
          />
          <Area
            type="monotone"
            dataKey="baseFeeGwei"
            stroke="#f0c08a"
            strokeWidth={1.5}
            fill="url(#gasFill)"
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
