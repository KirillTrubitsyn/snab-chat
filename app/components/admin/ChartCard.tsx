"use client";

import dynamic from "next/dynamic";
import type { ApexOptions } from "apexcharts";

// react-apexcharts обращается к window при импорте — грузим только на клиенте.
const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false });

interface ChartCardProps {
  title: string;
  type: "line" | "area" | "bar" | "donut" | "pie";
  series: ApexAxisChartSeries | ApexNonAxisChartSeries;
  options: ApexOptions;
  height?: number;
}

export default function ChartCard({ title, type, series, options, height = 320 }: ChartCardProps) {
  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-header-left">
          <h3 className="admin-card-title">{title}</h3>
        </div>
      </div>
      <div style={{ padding: "8px 16px 16px" }}>
        <ReactApexChart type={type} series={series} options={options} height={height} />
      </div>
    </div>
  );
}
