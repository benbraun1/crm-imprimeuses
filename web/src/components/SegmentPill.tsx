import { segColor } from "../lib/segments";

export function SegmentPill({ segment }: { segment: string }) {
  return (
    <span className="pill" style={{ "--seg": segColor(segment) } as React.CSSProperties}>
      <span className="dot" />
      {segment}
    </span>
  );
}
